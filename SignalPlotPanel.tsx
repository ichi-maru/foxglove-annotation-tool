import { Immutable, PanelExtensionContext, Topic } from "@foxglove/extension";
import { ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchableSelect } from "./SearchableSelect";


// ─── SHARED HELPERS (duplicated from MainPanel.tsx on purpose, so each
//     panel file stays self-contained. Pull these into a shared utils.ts if
//     the duplication starts to bother you.) ───────────────────────────────
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

// ─── FIELD-PATH HELPERS ─────────────────────────────────────────────────────
// Resolves a dot-notation path (e.g. "linear_acceleration.x") against a
// decoded message.
function resolveFieldPath(obj: unknown, path: string): number | undefined {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;
}

// Walks a sample message and returns dot-notation paths to every numeric leaf,
// so the field input can suggest them. Skips arrays/typed arrays for now —
// array-indexed paths (e.g. "data[0]") can be added later if you need them.
function discoverNumericPaths(obj: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj) || ArrayBuffer.isView(obj as ArrayBufferView)) {
    return out;
  }
  if (depth > 4 || out.length > 60) return out;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const val = (obj as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "number") {
      out.push(path);
    } else if (typeof val === "object" && val != null) {
      discoverNumericPaths(val, path, depth + 1, out);
    }
  }
  return out;
}

// ─── STREAMING BUCKET DECIMATION ────────────────────────────────────────────
// Instead of retaining every raw sample (a 27-minute IMU topic at a few
// hundred Hz is hundreds of thousands of full message objects — that's what
// crashed the panel), each series keeps a small FIXED number of time buckets
// spanning the recording. Every incoming sample only updates the min/max of
// the bucket it falls into, so memory and per-point work stay constant no
// matter how long the recording or how fast the topic is.
const NUM_BUCKETS = 1200;

type SeriesBuckets = {
  min: Float64Array;
  max: Float64Array;
  hasData: Uint8Array;
};

function makeEmptyBuckets(): SeriesBuckets {
  return {
    min: new Float64Array(NUM_BUCKETS).fill(Infinity),
    max: new Float64Array(NUM_BUCKETS).fill(-Infinity),
    hasData: new Uint8Array(NUM_BUCKETS),
  };
}

type SeriesRuntime = {
  buckets: SeriesBuckets;
  count: number;
  loading: boolean;
  unsupported: boolean;
};

// ─── DATA MODEL ────────────────────────────────────────────────────────────
type SeriesConfig = {
  id: string;
  topic: string;
  fieldPath: string;
  color: string;
  visible: boolean; // show/hide on the plot without losing loaded data — default true
};

// "independent" (default, matches the panel's original behavior): each
// series auto-scales to its OWN min/max, so it always fills the plot
// height regardless of units — good for comparing shape/timing across
// series that use different units. "shared": every series is plotted
// against one common min/max instead, so relative magnitude is comparable
// across series, at the cost of small-amplitude signals looking flatter.
type ScaleMode = "independent" | "shared";

// Shape read back from the "savedAnnotations" global variable, published by
// the Main Panel's toggleVisibleInPlot / setAllVisibleInPlot controls.
// Global variables are typed as VariableValue at the API boundary, so this
// needs a runtime guard rather than a cast — a malformed or stale entry
// (e.g. from an older Main Panel build) is simply dropped, not crashed on.
type SavedAnnotation = {
  id: number;
  eventName: string;
  topic: string;
  startTime: number;
  endTime: number;
};

function isSavedAnnotation(value: unknown): value is SavedAnnotation {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "number" &&
    typeof v.eventName === "string" &&
    typeof v.topic === "string" &&
    typeof v.startTime === "number" &&
    typeof v.endTime === "number"
  );
}

const COLORS = ["#3388ff", "#ee7744", "#2aa77a", "#ffd54a", "#b388ff", "#ff6ec7"];

const PLOT_W = 1000;
const PLOT_H = 260;
const PLOT_PAD = 12;

// ─── PANEL COMPONENT ───────────────────────────────────────────────────────
function SignalPlotPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const [recStart, setRecStart] = useState<number | undefined>();
  const [recEnd, setRecEnd] = useState<number | undefined>();
  const [currentTime, setCurrentTime] = useState<number | undefined>();

  // Annotation start/end, published by the Main Panel as global variables
  // (context.setVariable) whenever its drag handles or Set-to-Playhead
  // buttons move. undefined until the Main Panel is present and has set them.
  const [annotationStart, setAnnotationStart] = useState<number | undefined>();
  const [annotationEnd, setAnnotationEnd] = useState<number | undefined>();

  // Live samples, keyed by topic — used only to auto-suggest numeric field
  // paths while picking a topic.
  const [latestByTopic, setLatestByTopic] = useState<Record<string, unknown>>({});

  const [series, setSeries] = useState<SeriesConfig[]>([]);

  // Y-axis scale mode — see the ScaleMode type above for what each does.
  const [scaleMode, setScaleMode] = useState<ScaleMode>("independent");

  // Saved annotations read back from the Main Panel's "savedAnnotations"
  // global variable (only entries the user opted into with "Show in plot").
  const [savedAnnotations, setSavedAnnotations] = useState<SavedAnnotation[]>([]);

  // Hover-preview + multi click-to-pin state for the boundary regions below.
  // Only the hovered region gets a floating card (there's only ever one, so
  // it can't overlap itself); pinned regions go into a fixed list instead
  // of stacking more floating cards, so pinning several close-together
  // annotations never visually collides.
  const [hoveredAnnId, setHoveredAnnId] = useState<number | null>(null);
  const [pinnedAnnIds, setPinnedAnnIds] = useState<Set<number>>(new Set());

  // Transient banner shown when Add is clicked on a topic we already know
  // (from an already-sampled message) carries no numeric fields at all.
  const [addWarning, setAddWarning] = useState<string | null>(null);

  // Per-series runtime data lives in a ref and is mutated in place (never
  // copied per-sample) — `renderTick` is bumped on a throttle to trigger
  // redraws that read the latest ref contents.
  const runtimeRef = useRef<Map<string, SeriesRuntime>>(new Map());
  const rangeUnsubs = useRef<Map<string, () => void>>(new Map());
  const [renderTick, setRenderTick] = useState(0);
  const lastFlushRef = useRef<number>(0);

  function requestRedraw(force = false) {
    const now = Date.now();
    if (force || now - lastFlushRef.current > 200) {
      lastFlushRef.current = now;
      setRenderTick((t) => t + 1);
    }
  }

  const [pendingTopic, setPendingTopic] = useState<string>("");
  const [pendingField, setPendingField] = useState<string>("");

  // ── FOXGLOVE SETUP ──
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.topics != undefined) setTopics(renderState.topics);
      if (renderState.startTime != undefined) setRecStart(timeToNanos(renderState.startTime));
      if (renderState.endTime != undefined) setRecEnd(timeToNanos(renderState.endTime));
      if (renderState.currentTime != undefined) setCurrentTime(timeToNanos(renderState.currentTime));

      if (renderState.variables != undefined) {
        const rawStart = renderState.variables.get("annotationStartTimeNs");
        const rawEnd = renderState.variables.get("annotationEndTimeNs");
        setAnnotationStart(typeof rawStart === "number" ? rawStart : undefined);
        setAnnotationEnd(typeof rawEnd === "number" ? rawEnd : undefined);

        const rawSaved = renderState.variables.get("savedAnnotations");
        setSavedAnnotations(Array.isArray(rawSaved) ? rawSaved.filter(isSavedAnnotation) : []);
      }

      if (renderState.currentFrame != undefined && renderState.currentFrame.length > 0) {
        const frame = renderState.currentFrame;
        setLatestByTopic((prev) => {
          const next = { ...prev };
          for (const ev of frame) next[ev.topic] = ev.message;
          return next;
        });
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
    context.watch("startTime");
    context.watch("endTime");
    context.watch("currentTime");
    context.watch("variables");
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // Unsubscribe every open message-range subscription when the panel unmounts.
  useEffect(() => {
    return () => {
      rangeUnsubs.current.forEach((unsub) => unsub());
      rangeUnsubs.current.clear();
    };
  }, []);

  // Live-subscribe to whichever topic the user is currently picking a field
  // for, so we can sample one message and suggest numeric field paths. This
  // is separate from the full-timeline loading below.
  useEffect(() => {
    context.subscribe(pendingTopic ? [{ topic: pendingTopic }] : []);
  }, [context, pendingTopic]);

  const fieldSuggestions = useMemo(() => {
    const sample = pendingTopic ? latestByTopic[pendingTopic] : undefined;
    return sample ? discoverNumericPaths(sample) : [];
  }, [pendingTopic, latestByTopic]);

  // ── FULL-RANGE DATA LOADING (one subscription per series) ──
  // Pulls a series' full-timeline data via subscribeMessageRange, resolving
  // the field and folding each value into its bucket array as it streams in.
  // Raw messages are never retained. Only works for offline sources (an open
  // MCAP file); live connections still only get currentFrame data.
  function ensureRangeSubscription(s: SeriesConfig) {
    if (rangeUnsubs.current.has(s.id)) return;

    if (typeof context.subscribeMessageRange !== "function") {
      runtimeRef.current.set(s.id, { buckets: makeEmptyBuckets(), count: 0, loading: false, unsupported: true });
      requestRedraw(true);
      return;
    }

    runtimeRef.current.set(s.id, { buckets: makeEmptyBuckets(), count: 0, loading: true, unsupported: false });
    requestRedraw(true);

    const start = recStart;
    const end = recEnd;

    const unsubscribe = context.subscribeMessageRange({
      topic: s.topic,
      onNewRangeIterator: async (batchIterator) => {
        // A fresh iterator means prior data for this series is no longer valid.
        const runtime: SeriesRuntime = { buckets: makeEmptyBuckets(), count: 0, loading: true, unsupported: false };
        runtimeRef.current.set(s.id, runtime);
        requestRedraw(true);

        for await (const batch of batchIterator) {
          if (start != undefined && end != undefined && end > start) {
            for (const ev of batch) {
              const v = resolveFieldPath(ev.message, s.fieldPath);
              if (v == undefined) continue;
              const t = timeToNanos(ev.receiveTime);
              const pct = Math.min(1, Math.max(0, (t - start) / (end - start)));
              const idx = Math.min(NUM_BUCKETS - 1, Math.floor(pct * NUM_BUCKETS));
              if (v < runtime.buckets.min[idx]!) runtime.buckets.min[idx] = v;
              if (v > runtime.buckets.max[idx]!) runtime.buckets.max[idx] = v;
              runtime.buckets.hasData[idx] = 1;
              runtime.count += 1;
            }
          }
          requestRedraw();
        }

        runtime.loading = false;
        requestRedraw(true);
      },
    });

    rangeUnsubs.current.set(s.id, unsubscribe);
  }

  // ── SERIES MANAGEMENT ──
  function handleAddSeries() {
    if (pendingTopic === "" || pendingField.trim() === "") {
      alert("Pick a topic and a numeric field to plot.");
      return;
    }
    const trimmedField = pendingField.trim();
    const id = `${pendingTopic}::${trimmedField}::${Date.now()}`;
    const color = COLORS[series.length % COLORS.length]!;
    const newSeries: SeriesConfig = { id, topic: pendingTopic, fieldPath: trimmedField, color, visible: true };
    setSeries((prev) => [...prev, newSeries]);
    ensureRangeSubscription(newSeries);

    // We can only warn immediately if we already have a sampled message for
    // this topic AND it has zero numeric leaves — that's the one case
    // knowable before the range load even starts. A typo'd field path on an
    // otherwise-numeric topic can only be caught once loading finishes (see
    // the legend row below), since that needs the real streamed data.
    const hasSample = latestByTopic[pendingTopic] !== undefined;
    if (hasSample && fieldSuggestions.length === 0) {
      setAddWarning(`"${pendingTopic}" doesn't appear to carry numeric data — "${trimmedField}" is unlikely to plot anything.`);
    } else {
      setAddWarning(null);
    }

    setPendingTopic("");
    setPendingField("");
  }

  // Shows/hides a series without losing its loaded data — default ON,
  // opposite default from the Main Panel's annotation toggle, since adding
  // a series here is already an explicit "I want to look at this" action.
  function toggleSeriesVisible(id: string) {
    setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, visible: !s.visible } : s)));
  }

  function toggleAnnPin(id: number) {
    setPinnedAnnIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRemoveSeries(id: string) {
    setSeries((prev) => prev.filter((s) => s.id !== id));
    const unsub = rangeUnsubs.current.get(id);
    if (unsub) unsub();
    rangeUnsubs.current.delete(id);
    runtimeRef.current.delete(id);
    requestRedraw(true);
  }

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

  function nanosToTime(ns: number): { sec: number; nsec: number } {
    return { sec: Math.floor(ns / 1_000_000_000), nsec: ns % 1_000_000_000 };
  }

  function valueToY(v: number, min: number, max: number): number {
    const range = max - min;
    const norm = range > 0 ? (v - min) / range : 0.5;
    return PLOT_H - PLOT_PAD - norm * (PLOT_H - 2 * PLOT_PAD);
  }

  // ── CLICK-TO-SEEK / DRAG-TO-SCRUB / HOVER-PREVIEW ──
  // seekPlayback is optional (some data sources, e.g. live connections,
  // don't support seeking) so we feature-detect it, same as
  // subscribeMessageRange. setPreviewTime is always available — it's the
  // same hover-preview mechanism the native seek bar and Plot panel use, so
  // hovering here will show a preview marker in other panels too.
  const canSeek = typeof context.seekPlayback === "function";
  const svgRef = useRef<SVGSVGElement | null>(null);
  const isDraggingRef = useRef(false);
  const lastSeekRef = useRef(0);

  function clientXToTime(clientX: number): number | undefined {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return undefined;
    const fracX = (clientX - rect.left) / rect.width;
    return xToTime(Math.min(1, Math.max(0, fracX)) * PLOT_W);
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
    setPinnedAnnIds(new Set()); // clicking empty plot space releases ALL pinned regions
    if (!canSeek) return;
    isDraggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    previewAt(undefined);
    const t = clientXToTime(e.clientX);
    if (t != undefined) seekTo(t, true);
  }

  function handlePlotPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const t = clientXToTime(e.clientX);
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
    const t = clientXToTime(e.clientX);
    if (t != undefined) seekTo(t, true);
  }

  function handlePlotPointerLeave() {
    if (!isDraggingRef.current) previewAt(undefined);
  }

  // ── DERIVED DISPLAY DATA (recomputed whenever renderTick is bumped) ──
  const seriesDisplay = useMemo(() => {
    // In "shared" mode, first find one min/max across every series so they
    // can all be plotted against the same scale.
    let sharedMin = Infinity;
    let sharedMax = -Infinity;
    if (scaleMode === "shared") {
      for (const s of series) {
        if (!s.visible) continue; // hidden series don't stretch the shared scale
        const runtime = runtimeRef.current.get(s.id);
        if (!runtime) continue;
        for (let i = 0; i < NUM_BUCKETS; i++) {
          if (!runtime.buckets.hasData[i]) continue;
          if (runtime.buckets.min[i]! < sharedMin) sharedMin = runtime.buckets.min[i]!;
          if (runtime.buckets.max[i]! > sharedMax) sharedMax = runtime.buckets.max[i]!;
        }
      }
      if (!Number.isFinite(sharedMin) || !Number.isFinite(sharedMax)) {
        sharedMin = 0;
        sharedMax = 1;
      }
    }

    return series.map((s) => {
      const runtime = runtimeRef.current.get(s.id);
      if (!runtime) {
        return { ...s, bandPoints: "", min: 0, max: 1, count: 0, loading: true, unsupported: false };
      }

      let overallMin: number;
      let overallMax: number;
      if (scaleMode === "shared") {
        overallMin = sharedMin;
        overallMax = sharedMax;
      } else {
        overallMin = Infinity;
        overallMax = -Infinity;
        for (let i = 0; i < NUM_BUCKETS; i++) {
          if (!runtime.buckets.hasData[i]) continue;
          if (runtime.buckets.min[i]! < overallMin) overallMin = runtime.buckets.min[i]!;
          if (runtime.buckets.max[i]! > overallMax) overallMax = runtime.buckets.max[i]!;
        }
        if (!Number.isFinite(overallMin) || !Number.isFinite(overallMax)) {
          overallMin = 0;
          overallMax = 1;
        }
      }

      // Build a closed min/max-band polygon: the "max" edge left-to-right,
      // then the "min" edge back right-to-left.
      const upper: string[] = [];
      const lower: string[] = [];
      for (let i = 0; i < NUM_BUCKETS; i++) {
        if (!runtime.buckets.hasData[i]) continue;
        const x = ((i + 0.5) / NUM_BUCKETS) * PLOT_W;
        upper.push(`${x.toFixed(1)},${valueToY(runtime.buckets.max[i]!, overallMin, overallMax).toFixed(1)}`);
        lower.push(`${x.toFixed(1)},${valueToY(runtime.buckets.min[i]!, overallMin, overallMax).toFixed(1)}`);
      }
      lower.reverse();

      return {
        ...s,
        bandPoints: upper.length > 0 ? `${upper.join(" ")} ${lower.join(" ")}` : "",
        min: overallMin,
        max: overallMax,
        count: runtime.count,
        loading: runtime.loading,
        unsupported: runtime.unsupported,
      };
    });
    // runtimeRef is a ref (mutated in place); renderTick is the deliberate
    // trigger for re-reading it, so it's the real dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, renderTick, scaleMode]);

  const hoverCardAnn = hoveredAnnId != null ? savedAnnotations.find((a) => a.id === hoveredAnnId) ?? null : null;
  const pinnedList = savedAnnotations.filter((a) => pinnedAnnIds.has(a.id));

  // ── UI (JSX) ─────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "1rem", fontFamily: "sans-serif", height: "100%", boxSizing: "border-box", overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <h2 style={{ marginBottom: "1rem" }}>Signal Plot</h2>

      {/* ADD SERIES CONTROLS */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
        {/* Searchable/filterable topic picker — same SearchableSelect used in Main
            Panel's topic select. Wrapped in a div carrying the flex sizing the
            plain <select> used to have directly, since the component doesn't take
            a style prop itself. */}
        <div style={{ flex: "1 1 200px" }}>
          <SearchableSelect
            items={(topics ?? []).map((topic) => ({ name: topic.name, meta: topic.schemaName }))}
            value={pendingTopic}
            onChange={(next) => { setPendingTopic(next); setPendingField(""); }}
            mode="strict"
            placeholder="-- search topics --"
          />
        </div>

        <input
          type="text"
          list="field-suggestions"
          value={pendingField}
          onChange={(e) => setPendingField(e.target.value)}
          placeholder={pendingTopic ? (fieldSuggestions[0] ?? "type a numeric field path, e.g. linear_acceleration.x") : "select a topic first"}
          disabled={!pendingTopic}
          style={{ flex: "1 1 200px", padding: "0.3rem", boxSizing: "border-box" }}
        />
        <datalist id="field-suggestions">
          {fieldSuggestions.map((f) => <option key={f} value={f} />)}
        </datalist>

        <button
          onClick={handleAddSeries}
          disabled={!pendingTopic || !pendingField}
          style={{ padding: "0.3rem 0.8rem", backgroundColor: "#338", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
        >
          Add
        </button>
      </div>
      {pendingTopic !== "" && fieldSuggestions.length === 0 && (
        <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "0.5rem" }}>
          {latestByTopic[pendingTopic] !== undefined
            ? "This topic's messages don't appear to contain any numeric fields — you can still type a field path manually, but it's unlikely to plot."
            : "No sample message seen yet for this topic — play or scrub the timeline to detect fields, or type a field path manually."}
        </div>
      )}

      {addWarning && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.5rem 0.6rem",
            marginBottom: "0.5rem",
            backgroundColor: "#3a2a10",
            border: "1px solid #7a5a1a",
            borderRadius: "4px",
            fontSize: "0.78rem",
            color: "#e0a030",
          }}
        >
          <span>⚠ {addWarning}</span>
          <button
            onClick={() => setAddWarning(null)}
            style={{ background: "none", border: "none", color: "#e0a030", cursor: "pointer", fontSize: "0.9rem" }}
          >
            ×
          </button>
        </div>
      )}

      {/* Y-AXIS SCALE MODE */}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem", fontSize: "0.8rem" }}>
        <span style={{ color: "#888" }}>Y-axis scale:</span>
        <button
          onClick={() => setScaleMode("independent")}
          style={{
            padding: "0.25rem 0.6rem",
            borderRadius: "4px",
            border: "1px solid #444",
            cursor: "pointer",
            backgroundColor: scaleMode === "independent" ? "#338" : "#222",
            color: "white",
          }}
        >
          Independent per series
        </button>
        <button
          onClick={() => setScaleMode("shared")}
          style={{
            padding: "0.25rem 0.6rem",
            borderRadius: "4px",
            border: "1px solid #444",
            cursor: "pointer",
            backgroundColor: scaleMode === "shared" ? "#338" : "#222",
            color: "white",
          }}
        >
          Shared across series
        </button>
      </div>

      {/* PLOT */}
      <div style={{ marginBottom: "0.5rem", fontWeight: "bold" }}>Timeline</div>
      {!haveRange ? (
        <div style={{ padding: "1.5rem", textAlign: "center", color: "#888", border: "1px dashed #555", borderRadius: "6px" }}>
          No recording loaded — open an MCAP file to see the timeline.
        </div>
      ) : (
        <>
          <div style={{ position: "relative", border: "1px solid #444", borderRadius: "6px", backgroundColor: "#2a2a2a", marginBottom: "0.4rem" }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
              preserveAspectRatio="none"
              style={{ width: "100%", height: "260px", display: "block", cursor: canSeek ? "pointer" : "default", touchAction: "none" }}
              onPointerDown={handlePlotPointerDown}
              onPointerMove={handlePlotPointerMove}
              onPointerUp={handlePlotPointerUp}
              onPointerLeave={handlePlotPointerLeave}
            >
              {/* Saved-annotation boundary regions — bottom layer, under the
                  data bands. No inline text label (that caused clutter with
                  long event names) — hover shows a quick preview, click
                  pins it into the fixed list below instead of stacking more
                  floating cards. */}
              {savedAnnotations.map((ann) => {
                const isActive = hoveredAnnId === ann.id || pinnedAnnIds.has(ann.id);
                return (
                  <rect
                    key={ann.id}
                    x={timeToX(ann.startTime)}
                    y={0}
                    width={Math.max(0, timeToX(ann.endTime) - timeToX(ann.startTime))}
                    height={PLOT_H}
                    fill="#b388ff"
                    fillOpacity={isActive ? 0.24 : 0.1}
                    stroke="#b388ff"
                    strokeOpacity={isActive ? 0.8 : 0.4}
                    strokeDasharray="4 3"
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setHoveredAnnId(ann.id)}
                    onMouseLeave={() => setHoveredAnnId((cur) => (cur === ann.id ? null : cur))}
                    onPointerDown={(e) => {
                      e.stopPropagation(); // don't also trigger the seek/drag handler below
                      toggleAnnPin(ann.id);
                    }}
                  />
                );
              })}

              {seriesDisplay
                .filter((s) => s.visible)
                .map((s) =>
                  s.bandPoints !== "" ? (
                    <polygon key={s.id} points={s.bandPoints} fill={s.color} fillOpacity={0.35} stroke={s.color} strokeWidth={1} />
                  ) : null
                )}

              {annotationStart != undefined && (
                <line x1={timeToX(annotationStart)} x2={timeToX(annotationStart)} y1={0} y2={PLOT_H} stroke="#2a7" strokeWidth={2} pointerEvents="none" />
              )}
              {annotationEnd != undefined && (
                <line x1={timeToX(annotationEnd)} x2={timeToX(annotationEnd)} y1={0} y2={PLOT_H} stroke="#e74" strokeWidth={2} pointerEvents="none" />
              )}

              {currentTime != undefined && (
                <g pointerEvents="none">
                  <line
                    x1={timeToX(currentTime)}
                    x2={timeToX(currentTime)}
                    y1={0}
                    y2={PLOT_H}
                    stroke="#ffd54a"
                    strokeWidth={2}
                  />
                  <polygon
                    points={`${timeToX(currentTime) - 5},0 ${timeToX(currentTime) + 5},0 ${timeToX(currentTime)},8`}
                    fill="#ffd54a"
                  />
                </g>
              )}
            </svg>

            {hoverCardAnn && (
              <div
                style={{
                  position: "absolute",
                  left: `${(((timeToX(hoverCardAnn.startTime) + timeToX(hoverCardAnn.endTime)) / 2) / PLOT_W) * 100}%`,
                  top: "8px",
                  transform: "translateX(-50%)",
                  backgroundColor: "#1e1e1e",
                  border: "1px dashed #b388ff",
                  borderRadius: "4px",
                  padding: "0.4rem 0.6rem",
                  fontSize: "0.72rem",
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
                  zIndex: 5,
                }}
              >
                <div style={{ fontWeight: "bold", color: "#b388ff" }}>{hoverCardAnn.eventName}</div>
                <div style={{ color: "#aaa" }}>{hoverCardAnn.topic}</div>
                <div>
                  {formatRelative(hoverCardAnn.startTime, recStart!)} → {formatRelative(hoverCardAnn.endTime, recStart!)}
                </div>
              </div>
            )}
          </div>

          {savedAnnotations.length > 0 && (
            <div style={{ fontSize: "0.7rem", color: "#888", marginBottom: "0.5rem" }}>
              <span style={{ color: "#b388ff" }}>▨</span> saved annotations — hover for a quick peek, click to pin below &nbsp;·&nbsp;
              <span style={{ color: "#2a7" }}> —</span> current start &nbsp;·&nbsp;
              <span style={{ color: "#e74" }}> —</span> current end
            </div>
          )}

          {pinnedList.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontWeight: "bold", fontSize: "0.85rem", marginBottom: "0.4rem" }}>
                Pinned Annotations ({pinnedList.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                {pinnedList.map((ann) => (
                  <div
                    key={ann.id}
                    style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.35rem 0.5rem", backgroundColor: "#1e1e1e", border: "1px solid #b388ff", borderRadius: "4px", fontSize: "0.8rem" }}
                  >
                    <div style={{ width: "10px", height: "10px", borderRadius: "2px", backgroundColor: "#b388ff", flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: "bold" }}>{ann.eventName}</span>{" "}
                      <span style={{ color: "#aaa" }}>
                        · {ann.topic} · {formatRelative(ann.startTime, recStart!)} → {formatRelative(ann.endTime, recStart!)}
                      </span>
                    </div>
                    <button
                      onClick={() => toggleAnnPin(ann.id)}
                      style={{ background: "none", border: "none", color: "#b388ff", cursor: "pointer", fontSize: "0.9rem", padding: "0 0.3rem" }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {haveRange && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#888", marginBottom: "0.25rem" }}>
          <span>0:00.000</span>
          <span>{formatRelative(recEnd!, recStart!)}</span>
        </div>
      )}
      <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "1rem", minHeight: "1em" }}>
        {haveRange && !canSeek ? "Click-to-seek isn't supported for this data source." : null}
      </div>

      {/* LEGEND */}
      <div style={{ borderTop: "1px solid #444", paddingTop: "0.75rem" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>Series ({series.length})</h3>
        {seriesDisplay.length === 0 ? (
          <p style={{ color: "#888", fontSize: "0.85rem" }}>No series yet — pick a topic and field above, then Add.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {seriesDisplay.map((s) => {
              const isEmpty = !s.unsupported && !s.loading && s.count === 0;
              return (
                <div
                  key={s.id}
                  style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.4rem 0.5rem", backgroundColor: "#1e1e1e", border: isEmpty ? "1px solid #7a5a1a" : "1px solid #444", borderRadius: "4px", fontSize: "0.85rem", opacity: s.visible ? 1 : 0.5 }}
                >
                  <div style={{ width: "12px", height: "12px", borderRadius: "2px", backgroundColor: isEmpty ? "transparent" : s.color, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px" }}>
                    {isEmpty ? "⚠" : null}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: "bold" }}>
                      {s.topic} <span style={{ color: "#aaa", fontWeight: "normal" }}>· {s.fieldPath}</span>
                    </div>
                    <div style={{ color: isEmpty ? "#e0a030" : "#888" }}>
                      {s.unsupported
                        ? "this Foxglove version doesn't support subscribeMessageRange — try updating the app"
                        : s.loading
                          ? `loading… ${s.count.toLocaleString()} samples so far`
                          : isEmpty
                            ? "no numeric values found at this field path — nothing plotted"
                            : `range: ${s.min.toFixed(3)} to ${s.max.toFixed(3)} · ${s.count.toLocaleString()} samples`}
                    </div>
                  </div>
                  <button
                    onClick={() => toggleSeriesVisible(s.id)}
                    title={s.visible ? "Hide this series from the plot" : "Show this series on the plot"}
                    style={{
                      padding: "0.2rem 0.5rem",
                      backgroundColor: s.visible ? "#2a3a55" : "#333",
                      color: s.visible ? "#8ab4ff" : "#999",
                      border: s.visible ? "1px solid #3388ff" : "1px solid #444",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "0.78rem",
                    }}
                  >
                    {s.visible ? "◉ Visible" : "○ Hidden"}
                  </button>
                  <button
                    onClick={() => handleRemoveSeries(s.id)}
                    style={{ padding: "0.2rem 0.5rem", backgroundColor: "#822", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function initSignalPlotPanel (context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<SignalPlotPanel context={context} />);
  return () => { root.unmount(); };
}
