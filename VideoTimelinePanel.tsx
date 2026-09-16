// VideoTimelinePanel.tsx
//
// EXPERIMENTAL — this is a NEW, separate panel, not a replacement for
// GlobalAnnotationTimelinePanel.tsx / VideoIndicatorPanel.tsx. Those two
// remain untouched and keep working standalone. This file merges them:
// the video feed (with its corner-badge overlay) stacked on top of the
// full multi-lane annotation timeline below it — see the approved layout
// mockup for the video/timeline space split (video gets flex:1, the
// timeline keeps its own natural height and scrolls internally).
import { Immutable, PanelExtensionContext, Topic } from "@foxglove/extension";
import { ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ─── SHARED HELPERS (deduped — both original files had identical copies) ───
function timeToNanos(t: { sec: number; nsec: number }): number {
  return t.sec * 1_000_000_000 + t.nsec;
}

function padLeft(value: string, length: number, char = "0"): string {
  return value.length >= length ? value : char.repeat(length - value.length) + value;
}

function formatRelative(ns: number, base: number): string {
  const totalSec = (ns - base) / 1_000_000_000;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec - minutes * 60;
  return `${minutes}:${padLeft(seconds.toFixed(3), 6, "0")}`;
}

function nanosToTime(ns: number): { sec: number; nsec: number } {
  return { sec: Math.floor(ns / 1_000_000_000), nsec: ns % 1_000_000_000 };
}

// ─── ANNOTATION DATA MODEL (deduped — identical SavedAnnotation shape and
//     isSavedAnnotation guard existed in both original files) ──────────────
// Shape read back from the "allAnnotations" global variable, published by
// the Main Panel — every saved annotation, unfiltered. `color` is optional
// at the type level so a stale Main Panel build doesn't get its entries
// dropped outright.
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

// One shared name for the fallback color — the two original files called
// this DEFAULT_COLOR and DEFAULT_ANNOTATION_COLOR respectively for the same
// "#888888" value; picked the more descriptive of the two.
const DEFAULT_ANNOTATION_COLOR = "#888888";

// ─── VIDEO DECODE (from VideoIndicatorPanel.tsx) ────────────────────────────
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

// ─── TIMELINE LAYOUT (from GlobalAnnotationTimelinePanel.tsx) ──────────────
const PLOT_W = 1000;
const LANE_H = 32;
const LANE_GAP = 6;
const RULER_H = 22;
const VISIBLE_LANES = 8;

// Tick spacing adapts to the recording length instead of a fixed step, so a
// 30-second clip and a 27-minute one both end up with a readable ~8 ticks
// instead of either 1 tick or 60+.
const NICE_STEPS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function chooseTickStepSeconds(durationSec: number): number {
  const target = durationSec / 8;
  for (const step of NICE_STEPS_SEC) {
    if (step >= target) return step;
  }
  return NICE_STEPS_SEC[NICE_STEPS_SEC.length - 1]!;
}

// ─── PANEL COMPONENT ───────────────────────────────────────────────────────
function VideoTimelinePanel({ context }: { context: PanelExtensionContext }): ReactElement {
  // ── SHARED STATE ──
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [currentTime, setCurrentTime] = useState<number | undefined>();
  const [annotations, setAnnotations] = useState<SavedAnnotation[]>([]);

  // ── VIDEO-SIDE STATE (from VideoIndicatorPanel.tsx) ──
  const [status, setStatus] = useState<string>("Waiting for topics…");
  const [selectedTopic, setSelectedTopic] = useState<string>("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Holds the ImageBitmap currently on screen so we can .close() it the
  // moment it's replaced — bitmaps must be explicitly released or they leak
  // GPU memory.
  const currentBitmapRef = useRef<ImageBitmap | null>(null);
  // Monotonically increasing token guarding against out-of-order decodes:
  // if frame A starts decoding, frame B arrives and starts decoding, and
  // A's decode finishes AFTER B's, A must be discarded rather than painted
  // over B. Also bumped on topic switch so an in-flight decode from the OLD
  // topic can never land after we've switched away from it.
  const decodeTokenRef = useRef(0);

  // ── TIMELINE-SIDE STATE (from GlobalAnnotationTimelinePanel.tsx) ──
  const [recStart, setRecStart] = useState<number | undefined>();
  const [recEnd, setRecEnd] = useState<number | undefined>();
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  // ── FOXGLOVE SETUP — one shared onRender/watch, replacing the two
  //    separate ones the original files each had ──
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.topics != undefined) setTopics(renderState.topics);
      if (renderState.startTime != undefined) setRecStart(timeToNanos(renderState.startTime));
      if (renderState.endTime != undefined) setRecEnd(timeToNanos(renderState.endTime));
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
    context.watch("startTime");
    context.watch("endTime");
    context.watch("variables");
    // Note: no context.subscribe([]) here — GlobalAnnotationTimelinePanel.tsx
    // called that standalone to explicitly declare "no topic data needed."
    // In this merged file, the video-side subscribe effect below is the
    // only place that ever needs to call context.subscribe, same as it
    // already worked in VideoIndicatorPanel.tsx on its own (it simply never
    // calls subscribe at all until a camera topic is selected).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, selectedTopic]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // ── VIDEO-SIDE: topic picker (from VideoIndicatorPanel.tsx) ──
  const imageTopics = (topics ?? []).filter((t) => KNOWN_COMPRESSED_IMAGE_SCHEMAS.has(t.schemaName));
  // Fallback: if nothing matches the known-schema list, offer every topic
  // rather than leaving the dropdown empty.
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

  // Subscribe/re-subscribe whenever the selected topic changes. This is the
  // ONLY context.subscribe call in the merged file (see the note in the
  // Foxglove setup effect above).
  useEffect(() => {
    if (selectedTopic === "") return;

    // Invalidate any decode still in flight for the previous topic, and
    // clear the on-screen frame immediately rather than leaving the old
    // topic's last frame visible under the new topic's label.
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

  // Active-event computation for the corner badge — time-only, regardless
  // of which topic each annotation was saved against or which camera is
  // currently selected.
  const activeEvents = useMemo(() => {
    if (currentTime == undefined) return [];
    return annotations.filter((a) => currentTime >= a.startTime && currentTime <= a.endTime);
  }, [annotations, currentTime]);

  // ── TIMELINE-SIDE: layout math (from GlobalAnnotationTimelinePanel.tsx) ──
  const haveRange = recStart != undefined && recEnd != undefined && recEnd > recStart;

  function timeToX(t: number): number {
    if (!haveRange) return 0;
    const pct = (t - recStart!) / (recEnd! - recStart!);
    return Math.min(1, Math.max(0, pct)) * PLOT_W;
  }

  function xToTime(x: number): number | undefined {
    if (!haveRange) return undefined;
    const pct = Math.min(1, Math.max(0, x / PLOT_W));
    return recStart! + pct * (recEnd! - recStart!);
  }

  // Fixed insertion order: lane index is simply the annotation's position in
  // the published array, which mirrors Main Panel's Saved Annotations list
  // order (including drag-to-reorder there). Two annotations that share an
  // event name still land in separate lanes even when their time ranges
  // overlap — that's the whole reason for lanes instead of a shared row.
  const lanes = useMemo(
    () => annotations.map((a, index) => ({ ...a, lane: index, color: a.color ?? DEFAULT_ANNOTATION_COLOR })),
    [annotations]
  );

  const ticks = useMemo(() => {
    if (!haveRange) return [];
    const durationSec = (recEnd! - recStart!) / 1_000_000_000;
    const stepNs = chooseTickStepSeconds(durationSec) * 1_000_000_000;
    const out: number[] = [];
    for (let t = recStart!; t <= recEnd!; t += stepNs) out.push(t);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [haveRange, recStart, recEnd]);

  const totalHeight = lanes.length * (LANE_H + LANE_GAP) + RULER_H + 8;
  const containerMaxHeight = RULER_H + VISIBLE_LANES * (LANE_H + LANE_GAP) + 8;

  function findLaneIdAt(x: number, y: number): number | null {
    for (const l of lanes) {
      const laneY = RULER_H + l.lane * (LANE_H + LANE_GAP);
      if (y < laneY || y > laneY + LANE_H) continue;
      const x0 = timeToX(l.startTime);
      const x1 = Math.max(x0 + 2, timeToX(l.endTime));
      if (x >= x0 && x <= x1) return l.id;
    }
    return null;
  }

  // ── TIMELINE-SIDE: CLICK-TO-SEEK / DRAG-TO-SCRUB / HOVER-PREVIEW ──
  // This is the only seek/scrub interaction in the merged file — the video
  // canvas itself has no pointer handlers (same as it never did standalone).
  const canSeek = typeof context.seekPlayback === "function";
  const svgRef = useRef<SVGSVGElement | null>(null);
  const isDraggingRef = useRef(false);
  const lastSeekRef = useRef(0);
  // Root of the whole panel — the hover tooltip below is positioned
  // relative to THIS (not the scrollable lane box), specifically so it can
  // render outside that box's clipping bounds. See handlePlotPointerMove.
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Cursor position (relative to panelRef), captured on hover — the
  // tooltip below follows the cursor rather than being anchored to the
  // lane's time position, so it's never clipped by the lane box's own
  // overflow-y:auto (it used to be a child of that box and got cut off at
  // the top/bottom edges — the bug you reported).
  const [hoverClientPos, setHoverClientPos] = useState<{ x: number; y: number } | null>(null);

  function clientPosToViewBox(clientX: number, clientY: number): { x: number; y: number } | undefined {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    return {
      x: ((clientX - rect.left) / rect.width) * PLOT_W,
      y: ((clientY - rect.top) / rect.height) * totalHeight,
    };
  }

  function seekTo(t: number, force = false) {
    if (!canSeek) return;
    const now = Date.now();
    if (!force && now - lastSeekRef.current < 50) return; // throttle mid-drag seeks
    lastSeekRef.current = now;
    context.seekPlayback!(nanosToTime(t));
  }

  function previewAt(t: number | undefined) {
    context.setPreviewTime(t != undefined ? t / 1_000_000_000 : undefined);
  }

  function handlePlotPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!canSeek) return;
    isDraggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    previewAt(undefined);
    const pos = clientPosToViewBox(e.clientX, e.clientY);
    const t = pos ? xToTime(pos.x) : undefined;
    if (t != undefined) seekTo(t, true);
  }

  function handlePlotPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const pos = clientPosToViewBox(e.clientX, e.clientY);
    setHoveredId(pos ? findLaneIdAt(pos.x, pos.y) : null);

    if (panelRef.current) {
      const panelRect = panelRef.current.getBoundingClientRect();
      setHoverClientPos({ x: e.clientX - panelRect.left, y: e.clientY - panelRect.top });
    }

    if (!pos) return;
    const t = xToTime(pos.x);
    if (t == undefined) return;
    if (isDraggingRef.current) {
      seekTo(t);
    } else {
      previewAt(t);
    }
  }

  function handlePlotPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const pos = clientPosToViewBox(e.clientX, e.clientY);
    const t = pos ? xToTime(pos.x) : undefined;
    if (t != undefined) seekTo(t, true);
  }

  function handlePlotPointerLeave() {
    if (!isDraggingRef.current) previewAt(undefined);
    setHoveredId(null);
    setHoverClientPos(null);
  }

  const hoveredLane = hoveredId != null ? lanes.find((l) => l.id === hoveredId) ?? null : null;

  // ── UI (JSX) ─────────────────────────────────────────────────────────────
  // Outer container: fixed height, column direction. Video gets flex:1 (the
  // flexible space); the timeline block below keeps its own natural height
  // (capped around 8 visible lanes, scrolling internally beyond that) —
  // exactly the sizing each original panel already had standalone, just
  // stacked instead of each being the whole panel. See the approved mockup.
  return (
    <div ref={panelRef} style={{ padding: "1rem", fontFamily: "sans-serif", height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", position: "relative" }}>
      <h2 style={{ marginBottom: "0.5rem", flexShrink: 0 }}>Video Indicator + Timeline (Experimental)</h2>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center", flexShrink: 0 }}>
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
        <div style={{ fontSize: "0.72rem", color: "#e0a030", marginBottom: "0.5rem", flexShrink: 0 }}>
          No topic matched a known compressed-image schema — showing all {topics.length} topic(s) instead. If you
          pick one and nothing renders, let me know its schema name from Foxglove's Topics panel so I can add it to
          the known list.
        </div>
      )}

      <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "0.75rem", flexShrink: 0 }}>{status}</div>

      {/* VIDEO — flex:1, takes whatever space the timeline block below
          doesn't claim. minHeight:0 is required here so it can actually
          shrink inside this flex column instead of overflowing. */}
      <div style={{ flex: 1, minHeight: "80px", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#000", border: "1px solid #444", borderRadius: "6px", overflow: "hidden", marginBottom: "0.6rem" }}>
        <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }} />

        {/* CORNER BADGE OVERLAY — unchanged from VideoIndicatorPanel.tsx. */}
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
                  <span style={{ fontWeight: "bold", whiteSpace: "nowrap", color: "#eee" }}>{a.eventName}</span>
                  <span style={{ color: "#999", fontSize: "0.68rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {a.topic}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* TIMELINE — from GlobalAnnotationTimelinePanel.tsx, unchanged
          behavior, just relocated below the video instead of being the
          whole panel. Not flexed — keeps its own natural height (ruler +
          up to 8 lanes) and scrolls internally beyond that. */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontSize: "0.78rem", color: "#888", marginBottom: "0.5rem" }}>
          Every saved annotation, one permanent lane each in save order. Read-only — click or drag to seek, hover a
          region for its full name.
        </div>

        {!haveRange ? (
          <div style={{ padding: "1.5rem", textAlign: "center", color: "#888", border: "1px dashed #555", borderRadius: "6px" }}>
            No recording loaded — open an MCAP file to see the timeline.
          </div>
        ) : lanes.length === 0 ? (
          <div style={{ padding: "1.5rem", textAlign: "center", color: "#888", border: "1px dashed #555", borderRadius: "6px" }}>
            No saved annotations yet — save some in the Main Panel and they'll appear here.
          </div>
        ) : (
          <>
            {/* Outer wrapper handles HORIZONTAL overflow: the inner box
                below has a minWidth floor so its text can never be
                scaled down past legibility (the "blurred when shrunk"
                bug) — when the panel is narrower than that floor, this
                wrapper scrolls sideways instead of squeezing the SVG. */}
            <div style={{ overflowX: "auto", marginBottom: "0.4rem" }}>
              <div
                style={{
                  position: "relative",
                  border: "1px solid #444",
                  borderRadius: "6px",
                  backgroundColor: "#222",
                  overflowY: "auto",
                  maxHeight: `${containerMaxHeight}px`,
                  // Never render narrower than the SVG's native viewBox
                  // width — below that, text drawn at a fixed viewBox
                  // font size (e.g. fontSize:"10px" in the lane labels)
                  // starts rendering smaller than its authored size and
                  // gets blurry, since the whole SVG scales down with it.
                  minWidth: `${PLOT_W}px`,
                }}
              >
                <svg
                ref={svgRef}
                viewBox={`0 0 ${PLOT_W} ${totalHeight}`}
                preserveAspectRatio="none"
                style={{ width: "100%", height: `${totalHeight}px`, display: "block", cursor: canSeek ? "pointer" : "default", touchAction: "none" }}
                onPointerDown={handlePlotPointerDown}
                onPointerMove={handlePlotPointerMove}
                onPointerUp={handlePlotPointerUp}
                onPointerLeave={handlePlotPointerLeave}
              >
                {ticks.map((t) => (
                  <g key={t}>
                    <line x1={timeToX(t)} x2={timeToX(t)} y1={0} y2={totalHeight} stroke="#333" strokeWidth={1} />
                    <text x={timeToX(t) + 3} y={12} fontSize="9" fill="#666">
                      {formatRelative(t, recStart!)}
                    </text>
                  </g>
                ))}

                {lanes.map((a) => {
                  const y = RULER_H + a.lane * (LANE_H + LANE_GAP);
                  const x = timeToX(a.startTime);
                  const w = Math.max(2, timeToX(a.endTime) - x);
                  return (
                    <g key={a.id}>
                      <rect x={0} y={y} width={PLOT_W} height={LANE_H} fill="#1e1e1e" />
                      <rect x={x} y={y} width={w} height={LANE_H} rx={4} fill={a.color} fillOpacity={0.35} stroke={a.color} strokeWidth={1.5} />
                      <foreignObject x={x} y={y} width={w} height={LANE_H} style={{ pointerEvents: "none" }}>
                        <div
                          style={{
                            width: "100%",
                            height: "100%",
                            display: "flex",
                            alignItems: "center",
                            paddingLeft: "6px",
                            boxSizing: "border-box",
                            fontSize: "10px",
                            color: "#eee",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {a.eventName} · {a.topic}
                        </div>
                      </foreignObject>
                    </g>
                  );
                })}

                {currentTime != undefined && (
                  <g pointerEvents="none">
                    <line x1={timeToX(currentTime)} x2={timeToX(currentTime)} y1={0} y2={totalHeight} stroke="#ffd54a" strokeWidth={2} />
                    <polygon points={`${timeToX(currentTime) - 5},0 ${timeToX(currentTime) + 5},0 ${timeToX(currentTime)},8`} fill="#ffd54a" />
                  </g>
                )}
              </svg>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#888", marginBottom: "0.25rem" }}>
              <span>0:00.000</span>
              <span>{formatRelative(recEnd!, recStart!)}</span>
            </div>
          </>
        )}

        <div style={{ fontSize: "0.75rem", color: "#888", minHeight: "1em" }}>
          {haveRange && !canSeek ? "Click-to-seek isn't supported for this data source." : null}
        </div>
      </div>

      {/* Hover tooltip — rendered here, as a direct child of the whole
          panel (not nested inside the scrollable lane box above), and
          positioned from the cursor's position within the panel rather
          than the lane's time-position. That's what lets it render
          outside the lane box's own overflow-y:auto clipping — it used to
          live inside that box and get cut off at the top/bottom edges. */}
      {hoveredLane && hoverClientPos && (
        <div
          style={{
            position: "absolute",
            left: `${hoverClientPos.x + 14}px`,
            top: `${hoverClientPos.y + 14}px`,
            backgroundColor: "#1e1e1e",
            border: `1px solid ${hoveredLane.color}`,
            borderRadius: "4px",
            padding: "0.4rem 0.6rem",
            fontSize: "0.72rem",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
            zIndex: 5,
          }}
        >
          <div style={{ fontWeight: "bold", color: hoveredLane.color }}>{hoveredLane.eventName}</div>
          <div style={{ color: "#aaa" }}>{hoveredLane.topic}</div>
          <div>
            {formatRelative(hoveredLane.startTime, recStart!)} → {formatRelative(hoveredLane.endTime, recStart!)}
          </div>
        </div>
      )}
    </div>
  );
}

export function initVideoTimelinePanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<VideoTimelinePanel context={context} />);
  return () => {
    root.unmount();
  };
}
