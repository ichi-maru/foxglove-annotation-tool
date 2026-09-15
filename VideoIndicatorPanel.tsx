import { Immutable, PanelExtensionContext, Topic } from "@foxglove/extension";
import { ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ─── STEP 1 SCOPE (confirmed working against real data: 1280×960 @
// "/compressed_image_topic_cam0") ───────────────────────────────────────────
// Bare decode-and-draw only. No pan/zoom, no event indicator. Step 2
// (confirmed working) replaced the auto-detect block with the manual
// dropdown picker. Step 3 below adds the below-video event indicator.

function timeToNanos(t: { sec: number; nsec: number }): number {
  return t.sec * 1_000_000_000 + t.nsec;
}

// ─── STEP 3: ANNOTATION INDICATOR ──────────────────────────────────────────
// Shape read back from the "allAnnotations" global variable, published by
// the Main Panel — identical guard pattern to GlobalAnnotationTimelinePanel.tsx.
//
// Filtering rule (explicitly confirmed): an annotation counts as "active"
// purely by currentTime falling in [startTime, endTime] — regardless of
// which topic it was originally saved against, and regardless of which
// camera is currently selected in this panel's own dropdown. The video
// feed just shows whichever camera is picked; the indicator answers "what
// was annotated at this moment," full stop. (An earlier draft of this
// panel scoped the indicator to the selected camera's topic, inferred from
// the design mockup — that inference was wrong and has been corrected.)
type SavedAnnotation = {
  id: number;
  eventName: string;
  topic: string;
  startTime: number;
  endTime: number;
  color?: string;
};

function isSavedAnnotation(value: unknown): value is SavedAnnotation {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "number" &&
    typeof v.eventName === "string" &&
    typeof v.topic === "string" &&
    typeof v.startTime === "number" &&
    typeof v.endTime === "number" &&
    (v.color === undefined || typeof v.color === "string")
  );
}

const DEFAULT_ANNOTATION_COLOR = "#888888";

// Schema names observed across ROS1/ROS2/Foxglove-native compressed image
// messages. Extend this list if a recording's schema name isn't in it.
const KNOWN_COMPRESSED_IMAGE_SCHEMAS = new Set([
  "sensor_msgs/msg/CompressedImage",
  "sensor_msgs/CompressedImage",
  "foxglove_msgs/msg/CompressedImage",
  "foxglove.CompressedImage",
]);

// Shape of a decoded CompressedImage-family message. `data` arrives as a
// Uint8Array of the compressed bytes; `format` is a lowercase hint like
// "jpeg" or "png". Runtime guard, not a cast — a message that merely looks
// like the right schema but doesn't have these fields is reported, not
// crashed on.
type CompressedImageMessage = {
  format: string;
  data: Uint8Array;
};

function isCompressedImageMessage(msg: unknown): msg is CompressedImageMessage {
  if (msg == null || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return typeof m.format === "string" && m.data instanceof Uint8Array;
}

function mimeTypeForFormat(format: string): string {
  const f = format.toLowerCase();
  if (f.includes("png")) return "image/png";
  return "image/jpeg";
}

function VideoIndicatorPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [status, setStatus] = useState<string>("Waiting for topics…");

  // ── STEP 2: manual topic picker ──
  // Replaces the step-1 auto-detect scaffolding. Dropdown is filtered to
  // topics whose schema matches a known compressed-image type; falls back
  // to listing every topic if none match, so the panel is never a dead end
  // if a recording uses a schema name not yet in the known-list above.
  const [selectedTopic, setSelectedTopic] = useState<string>("");

  // ── STEP 3: indicator data ──
  const [currentTime, setCurrentTime] = useState<number | undefined>();
  const [annotations, setAnnotations] = useState<SavedAnnotation[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Holds the ImageBitmap currently on screen so we can .close() it the
  // moment it's replaced (decision point #6: no frame retention beyond the
  // current one; bitmaps must be explicitly released or they leak GPU
  // memory).
  const currentBitmapRef = useRef<ImageBitmap | null>(null);

  // Monotonically increasing token guarding against out-of-order decodes:
  // if frame A starts decoding, frame B arrives and starts decoding, and
  // A's decode finishes AFTER B's, A must be discarded rather than painted
  // over B. Also bumped on topic switch so an in-flight decode from the
  // OLD topic can never land after we've switched away from it.
  const decodeTokenRef = useRef(0);

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.topics != undefined) setTopics(renderState.topics);
      if (renderState.currentTime != undefined) setCurrentTime(timeToNanos(renderState.currentTime));

      if (renderState.variables != undefined) {
        const raw = renderState.variables.get("allAnnotations");
        setAnnotations(Array.isArray(raw) ? raw.filter(isSavedAnnotation) : []);
      }

      if (renderState.currentFrame != undefined && renderState.currentFrame.length > 0) {
        if (selectedTopic === "") return;

        // If multiple messages for our topic arrived in one frame batch,
        // only the most recent one matters — we never render older frames.
        let latest: unknown | undefined;
        for (const ev of renderState.currentFrame) {
          if (ev.topic === selectedTopic) latest = ev.message;
        }
        if (latest != undefined) decodeAndDraw(latest);
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
    context.watch("currentTime");
    context.watch("variables");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, selectedTopic]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const imageTopics = (topics ?? []).filter((t) => KNOWN_COMPRESSED_IMAGE_SCHEMAS.has(t.schemaName));
  // Fallback: if nothing matches the known-schema list, offer every topic
  // rather than leaving the dropdown empty — better to let the user pick
  // the right one (and tell us the real schema name) than to dead-end.
  const dropdownTopics = imageTopics.length > 0 ? imageTopics : topics ?? [];

  // Default-select the first detected image topic once topics arrive, but
  // only if nothing's been picked yet — never override a manual choice.
  useEffect(() => {
    if (selectedTopic !== "" || topics == undefined) return;
    if (imageTopics.length > 0) {
      setSelectedTopic(imageTopics[0]!.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics]);

  // Subscribe/re-subscribe whenever the selected topic changes. A single
  // context.subscribe call replaces the whole subscription list (same
  // pattern SignalPlotPanel already uses for its live field-sampling
  // subscription), so switching topics automatically drops the old one.
  useEffect(() => {
    if (selectedTopic === "") return;

    // Invalidate any decode still in flight for the previous topic, and
    // clear the on-screen frame immediately rather than leaving the old
    // topic's last frame visible until the new topic's first frame arrives
    // — a stale frame under a new topic label would be misleading.
    decodeTokenRef.current += 1;
    currentBitmapRef.current?.close();
    currentBitmapRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }

    setStatus(`Subscribed to "${selectedTopic}" — waiting for first frame…`);
    context.subscribe([{ topic: selectedTopic }]);
  }, [selectedTopic, context]);

  // Release the last bitmap on unmount so we don't leak GPU memory when the
  // panel is removed mid-recording.
  useEffect(() => {
    return () => {
      currentBitmapRef.current?.close();
      currentBitmapRef.current = null;
    };
  }, []);

  async function decodeAndDraw(message: unknown) {
    if (!isCompressedImageMessage(message)) {
      setStatus(`Message on "${selectedTopic}" doesn't look like a compressed-image message (missing "format"/"data" fields) — nothing to draw.`);
      return;
    }

    const token = ++decodeTokenRef.current;

    let bitmap: ImageBitmap;
    try {
      // message.data's buffer is typed as ArrayBufferLike (it could in
      // principle back onto a SharedArrayBuffer), but Blob's constructor
      // only accepts a plain ArrayBuffer. Copying into a fresh Uint8Array
      // sidesteps the mismatch — cheap relative to the decode itself.
      const bytes = new Uint8Array(message.data);
      const blob = new Blob([bytes], { type: mimeTypeForFormat(message.format) });
      bitmap = await createImageBitmap(blob);
    } catch (err) {
      setStatus(`Failed to decode frame: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Discard if a newer frame (or a topic switch) started after this one.
    if (token !== decodeTokenRef.current) {
      bitmap.close();
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      bitmap.close();
      return;
    }

    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return;
    }

    ctx.drawImage(bitmap, 0, 0);

    currentBitmapRef.current?.close();
    currentBitmapRef.current = bitmap;

    setStatus(`Rendering ${bitmap.width}×${bitmap.height} @ "${selectedTopic}"`);
  }

  // Active-event computation (see the filtering-rule comment on
  // SavedAnnotation above — time-only, confirmed). selectedTopic is not
  // part of this filter; it only determines which video feed is shown.
  const activeEvents = useMemo(() => {
    if (currentTime == undefined) return [];
    return annotations.filter((a) => currentTime >= a.startTime && currentTime <= a.endTime);
  }, [annotations, currentTime]);

  return (
    <div style={{ padding: "1rem", fontFamily: "sans-serif", height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
      <h2 style={{ marginBottom: "0.5rem" }}>Video Indicator (step 4 — corner badge overlay)</h2>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
        <span style={{ fontSize: "0.8rem", color: "#aaa" }}>Camera topic:</span>
        <select
          value={selectedTopic}
          onChange={(e) => setSelectedTopic(e.target.value)}
          style={{ flex: 1, padding: "0.3rem", backgroundColor: "#222", color: "#eee", border: "1px solid #444", borderRadius: "4px" }}
        >
          {selectedTopic === "" && <option value="">-- Select a camera topic --</option>}
          {dropdownTopics.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.schemaName})
            </option>
          ))}
        </select>
      </div>
      {imageTopics.length === 0 && topics != undefined && topics.length > 0 && (
        <div style={{ fontSize: "0.72rem", color: "#e0a030", marginBottom: "0.5rem" }}>
          No topic matched a known compressed-image schema — showing all {topics.length} topic(s) instead. If you
          pick one and nothing renders, let me know its schema name from Foxglove's Topics panel so I can add it to
          the known list.
        </div>
      )}

      <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "0.75rem" }}>{status}</div>

      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#000", border: "1px solid #444", borderRadius: "6px", overflow: "hidden" }}>
        <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }} />

        {/* INDICATOR — CORNER BADGE OVERLAY (design decision #4, revised:
            initially confirmed as a below-video strip, since replaced with
            an overlay after comparing both in mockup form). Stacked list,
            one line per active event, reusing each event's color from
            eventColors via the published `color` field (design decision
            #3). Always renders a visible state, including an explicit "No
            event" line (design decision #5) — note this means the badge
            never fully disappears, unlike the below-strip version having
            its own dedicated space; flagged during mockup review as an
            accepted tradeoff of the overlay approach.

            KNOWN GAP, NOT YET IMPLEMENTED: there's currently no way to tell,
            while creating an annotation on a non-video topic (e.g. IMU
            acceleration) in the Main Panel, which camera feed was on screen
            at the time — annotations aren't linked to "what video was being
            watched when this was annotated." Flagged as a possible future
            feature; deliberately not implemented yet. */}
        <div
          style={{
            position: "absolute",
            top: "10px",
            left: "10px",
            maxWidth: "68%",
            backgroundColor: "rgba(15,15,15,0.72)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "6px",
            padding: "0.45rem 0.6rem",
            fontSize: "0.78rem",
            pointerEvents: "none",
          }}
        >
          {activeEvents.length === 0 ? (
            <div style={{ color: "#aaa", fontStyle: "italic" }}>No event</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              {activeEvents.map((a) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }} title={a.topic}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "2px", backgroundColor: a.color ?? DEFAULT_ANNOTATION_COLOR, flexShrink: 0 }} />
                  <span style={{ fontWeight: "bold", whiteSpace: "nowrap" }}>{a.eventName}</span>
                  <span style={{ color: "#999", fontSize: "0.68rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {a.topic}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function initVideoIndicatorPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<VideoIndicatorPanel context={context} />);
  return () => {
    root.unmount();
  };
}
