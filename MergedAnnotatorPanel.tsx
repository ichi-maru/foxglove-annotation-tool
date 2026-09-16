// MergedAnnotatorPanel.tsx
//
// EXPERIMENTAL — this is a NEW, separate panel, not a replacement for
// MainPanel.tsx / SignalPlotPanel.tsx. Those two remain the final
// submission panels and are intentionally left untouched. This file
// duplicates their logic on purpose (annotation controls + signal plot,
// laid out side by side) as a UX prototype — see the approved layout
// mockup for the column proportions this follows.
//
// IMPORTANT — DO NOT run this panel and the original "Main Panel" in the
// same layout at the same time. Both publish the "allAnnotations" global
// variable (read by Global Annotation Timeline / Video Indicator); if both
// are mounted together, whichever one renders second silently overwrites
// the other's value. Use one or the other in a given layout, not both.
import { Immutable, PanelExtensionContext, Topic } from "@foxglove/extension";
import { ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchableSelect } from "./SearchableSelect";

// ─── ANNOTATION DATA MODEL (from MainPanel.tsx) ────────────────────────────
type Annotation = {
  id: number;             // Unique ID for the checkbox system
  eventName: string;
  topic: string;
  startTime: number;
  startTimeISO: string;
  endTime: number;
  endTimeISO: string;
  visibleInPlot: boolean; // Opt-in: whether this annotation is shaded in the plot below
};

// Lightweight shape published via the "allAnnotations" global variable —
// only what an external consumer (Global Annotation Timeline, Video
// Indicator) needs. Unlike MainPanel.tsx, this file does NOT also publish
// "savedAnnotations" / "annotationStartTimeNs" / "annotationEndTimeNs" —
// those existed only so the separate Signal Plot panel instance could read
// them back via global variables. Here the plot lives in the same
// component, so it reads `annotations` / `startTime` / `endTime` directly
// as local state — no cross-panel round trip needed. (Confirmed neither
// Global Annotation Timeline nor Video Indicator reads those three, so
// dropping them is safe.)
type PublishedAnnotation = {
  id: number;
  eventName: string;
  topic: string;
  startTime: number;
  endTime: number;
  color: string;
};

// Curated palette for annotation colors — shared by auto-assignment and the
// manual picker below. Deliberately excludes yellow: #ffd54a is the exact
// hex used for the live playhead line on both surfaces of this panel, so
// keeping it out of the assignable set means an annotation color can never
// be mistaken for the playhead crossing through it.
const PALETTE = ["#3388ff", "#ee7744", "#2aa77a", "#4dd0c4", "#b388ff", "#ff6ec7"];
const DEFAULT_COLOR = "#888888";

// ─── SESSION FILE VALIDATION (from MainPanel.tsx) ──────────────────────────
// A saved session is { schemaVersion, savedAt, annotations, eventColors }.
// Scope note: session save/load only covers the annotation side, same as
// the original MainPanel.tsx — it does NOT also persist the Signal Plot
// `series` list. That's still tracked separately (task #7) and would be a
// deliberate follow-up, not something folded silently into this merge.
function isValidAnnotation(v: unknown): v is Annotation {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "number" &&
    Number.isFinite(o.id) &&
    typeof o.eventName === "string" &&
    typeof o.topic === "string" &&
    typeof o.startTime === "number" &&
    Number.isFinite(o.startTime) &&
    typeof o.startTimeISO === "string" &&
    typeof o.endTime === "number" &&
    Number.isFinite(o.endTime) &&
    typeof o.endTimeISO === "string" &&
    typeof o.visibleInPlot === "boolean"
  );
}

function isValidEventColors(v: unknown): v is Record<string, string> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((c) => typeof c === "string");
}

type ParsedSession = { annotations: Annotation[]; eventColors: Record<string, string>; droppedCount: number };

function parseSessionFile(parsed: unknown): ParsedSession | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.annotations)) return null;
  const validAnnotations = obj.annotations.filter(isValidAnnotation);
  const droppedCount = obj.annotations.length - validAnnotations.length;
  if (validAnnotations.length === 0 && obj.annotations.length > 0) return null; // every entry malformed — likely the wrong file entirely
  const eventColors = isValidEventColors(obj.eventColors) ? obj.eventColors : {};
  return { annotations: validAnnotations, eventColors, droppedCount };
}

// ─── SHARED HELPERS (deduped — used by both the annotation side and the
//     plot side, unlike in the two original files where each duplicated
//     its own copy since they're separate panel instances) ─────────────────
function timeToNanos(t: { sec: number; nsec: number }): number {
  return t.sec * 1_000_000_000 + t.nsec;
}

function nanosToTime(ns: number): { sec: number; nsec: number } {
  return { sec: Math.floor(ns / 1_000_000_000), nsec: ns % 1_000_000_000 };
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

// ─── FIELD-PATH HELPERS (from SignalPlotPanel.tsx) ─────────────────────────
function resolveFieldPath(obj: unknown, path: string): number | undefined {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;
}

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

// ─── STREAMING BUCKET DECIMATION (from SignalPlotPanel.tsx) ────────────────
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

// ─── SIGNAL PLOT DATA MODEL (from SignalPlotPanel.tsx) ─────────────────────
type SeriesConfig = {
  id: string;
  topic: string;
  fieldPath: string;
  color: string;
  visible: boolean;
};

type ScaleMode = "independent" | "shared";

const COLORS = ["#3388ff", "#ee7744", "#2aa77a", "#ffd54a", "#b388ff", "#ff6ec7"];

const PLOT_W = 1000;
const PLOT_H = 260;
const PLOT_PAD = 12;

// ─── PANEL COMPONENT ───────────────────────────────────────────────────────
function MergedAnnotatorPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  // ── SHARED STATE (both columns read these) ──
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [recStart, setRecStart] = useState<number | undefined>();
  const [recEnd, setRecEnd] = useState<number | undefined>();
  const [currentTime, setCurrentTime] = useState<number | undefined>();

  // ── ANNOTATION-SIDE STATE (from MainPanel.tsx) ──
  const [selectedTopic, setSelectedTopic] = useState<string>("");
  const [eventName, setEventName] = useState<string>("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const [eventColors, setEventColors] = useState<Record<string, string>>({});
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);

  const dragRowIndexRef = useRef<number | null>(null);
  const dragOverIndexRef = useRef<number | null>(null);
  const rowElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // startTime/endTime double as what the plot column calls the "annotation
  // span" boundary lines — no separate annotationStart/annotationEnd state
  // needed since it's the same component now (previously these crossed
  // panels via context.setVariable / renderState.variables).
  const [startTime, setStartTime] = useState<number | undefined>();
  const [endTime, setEndTime] = useState<number | undefined>();

  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<null | "start" | "end" | "seek">(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // ── PLOT-SIDE STATE (from SignalPlotPanel.tsx) ──
  const [latestByTopic, setLatestByTopic] = useState<Record<string, unknown>>({});
  const [series, setSeries] = useState<SeriesConfig[]>([]);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("independent");
  const [hoveredAnnId, setHoveredAnnId] = useState<number | null>(null);
  const [pinnedAnnIds, setPinnedAnnIds] = useState<Set<number>>(new Set());
  const [addWarning, setAddWarning] = useState<string | null>(null);

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

  const svgRef = useRef<SVGSVGElement | null>(null);
  const isDraggingRef = useRef(false);
  // One shared seek-throttle for both surfaces (the annotation track and
  // the plot) — they can't be dragged at once, so a single timer is enough
  // and simpler than the two independent ones the separate panels had.
  const lastSeekRef = useRef(0);

  // ── FOXGLOVE SETUP — one shared onRender/watch, replacing the two
  //    separate ones MainPanel.tsx and SignalPlotPanel.tsx each had ──
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.topics != undefined) setTopics(renderState.topics);
      if (renderState.startTime != undefined) setRecStart(timeToNanos(renderState.startTime));
      if (renderState.endTime != undefined) setRecEnd(timeToNanos(renderState.endTime));
      if (renderState.currentTime != undefined) setCurrentTime(timeToNanos(renderState.currentTime));

      // Note: no renderState.variables handling here. SignalPlotPanel.tsx
      // reads "annotationStartTimeNs"/"annotationEndTimeNs"/"savedAnnotations"
      // this way because it's a separate panel instance; this file has that
      // data as local state already (startTime/endTime/annotations above).

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
    context.watch("currentTime");
    context.watch("startTime");
    context.watch("endTime");
  }, [context]);

  useEffect(() => { renderDone?.(); }, [renderDone]);

  useEffect(() => {
    if (recStart != undefined && recEnd != undefined && recEnd > recStart) {
      if (startTime == undefined) setStartTime(recStart + (recEnd - recStart) * 0.25);
      if (endTime == undefined) setEndTime(recStart + (recEnd - recStart) * 0.75);
    }
  }, [recStart, recEnd]);

  // Publishes "allAnnotations" only — still needed externally by Global
  // Annotation Timeline and Video Indicator. "savedAnnotations" and the two
  // annotationStart/EndTimeNs variables are dead code in this file (see the
  // type comment on PublishedAnnotation above) since nothing outside this
  // component ever needed them — they only existed to reach the separate
  // Signal Plot panel instance, which is now part of this same component.
  useEffect(() => {
    const toPublished = (a: Annotation): PublishedAnnotation => ({
      id: a.id,
      eventName: a.eventName,
      topic: a.topic,
      startTime: a.startTime,
      endTime: a.endTime,
      color: eventColors[a.eventName] ?? DEFAULT_COLOR,
    });
    context.setVariable("allAnnotations", annotations.map(toPublished));
  }, [context, annotations, eventColors]);

  useEffect(() => {
    return () => {
      context.setVariable("allAnnotations", undefined);
    };
  }, [context]);

  // Live-subscribe to whichever topic is currently being picked for a new
  // series, so we can sample one message and suggest numeric field paths.
  // This is the only context.subscribe call in the merged file — the
  // original MainPanel.tsx called context.subscribe([]) unconditionally,
  // which this subsumes (empty array when pendingTopic is "").
  useEffect(() => {
    context.subscribe(pendingTopic ? [{ topic: pendingTopic }] : []);
  }, [context, pendingTopic]);

  const fieldSuggestions = useMemo(() => {
    const sample = pendingTopic ? latestByTopic[pendingTopic] : undefined;
    return sample ? discoverNumericPaths(sample) : [];
  }, [pendingTopic, latestByTopic]);

  // Unsubscribe every open message-range subscription when the panel unmounts.
  useEffect(() => {
    return () => {
      rangeUnsubs.current.forEach((unsub) => unsub());
      rangeUnsubs.current.clear();
    };
  }, []);

  // ── DRAG MECHANISM (annotation-span track handles) ──
  useEffect(() => {
    function handlePointerMove(e: PointerEvent) {
      const which = dragRef.current;
      if (which == null) return;
      const track = trackRef.current;
      if (track == null || recStart == undefined || recEnd == undefined) return;

      const rect = track.getBoundingClientRect();
      let frac = (e.clientX - rect.left) / rect.width;
      frac = Math.min(1, Math.max(0, frac));

      const t = recStart + frac * (recEnd - recStart);

      if (which === "start") {
        setStartTime(endTime != undefined ? Math.min(t, endTime) : t);
      } else if (which === "end") {
        setEndTime(startTime != undefined ? Math.max(t, startTime) : t);
      } else {
        seekTo(t);
      }
    }
    function handlePointerUp(e: PointerEvent) {
      if (dragRef.current === "seek") {
        const track = trackRef.current;
        if (track != null && recStart != undefined && recEnd != undefined) {
          const rect = track.getBoundingClientRect();
          let frac = (e.clientX - rect.left) / rect.width;
          frac = Math.min(1, Math.max(0, frac));
          seekTo(recStart + frac * (recEnd - recStart), true);
        }
      }
      dragRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [recStart, recEnd, startTime, endTime]);

  function startDrag(which: "start" | "end") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = which;
    };
  }

  function timeToPercent(t: number | undefined): number {
    if (t == undefined || recStart == undefined || recEnd == undefined || recEnd <= recStart) return 0;
    const pct = ((t - recStart) / (recEnd - recStart)) * 100;
    return Math.min(100, Math.max(0, pct));
  }

  // ── CLICK-TO-SEEK / DRAG-TO-SCRUB / HOVER-PREVIEW — shared by both the
  //    annotation track and the plot below, since both now live behind the
  //    same `context`. ──
  const canSeek = typeof context.seekPlayback === "function";

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

  function handleTrackPointerDown(e: React.PointerEvent) {
    if (!canSeek) return;
    const track = trackRef.current;
    if (track == null || recStart == undefined || recEnd == undefined) return;
    dragRef.current = "seek";
    previewAt(undefined);
    const rect = track.getBoundingClientRect();
    let frac = (e.clientX - rect.left) / rect.width;
    frac = Math.min(1, Math.max(0, frac));
    seekTo(recStart + frac * (recEnd - recStart), true);
  }

  function handleTrackPointerMove(e: React.PointerEvent) {
    if (dragRef.current != null) return;
    const track = trackRef.current;
    if (track == null || recStart == undefined || recEnd == undefined) return;
    const rect = track.getBoundingClientRect();
    let frac = (e.clientX - rect.left) / rect.width;
    frac = Math.min(1, Math.max(0, frac));
    previewAt(recStart + frac * (recEnd - recStart));
  }

  function handleTrackPointerLeave() {
    if (dragRef.current == null) previewAt(undefined);
  }

  // ── ANNOTATION BUTTON LOGIC (from MainPanel.tsx) ──
  function handleSetStart() {
    if (currentTime == undefined) return;
    setStartTime(currentTime);
  }

  function handleSetEnd() {
    if (currentTime == undefined) return;
    setEndTime(currentTime);
  }

  function assignColorIfNew(name: string) {
    setEventColors((prev) => {
      if (name in prev) return prev;
      return { ...prev, [name]: PALETTE[Object.keys(prev).length % PALETTE.length]! };
    });
  }

  function recolorEvent(name: string, color: string) {
    setEventColors((prev) => ({ ...prev, [name]: color }));
    setColorPickerFor(null);
  }

  function handleSaveAnnotation() {
    if (selectedTopic === "" || startTime == undefined || endTime == undefined) {
      alert("Please select a topic and set a start/end span on the timeline.");
      return;
    }

    const finalName = eventName !== "" ? eventName : `event_${annotations.length}/${selectedTopic.replace(/^\//, "")}`;
    const newId = Date.now();
    assignColorIfNew(finalName);

    const newAnnotation: Annotation = {
      id: newId,
      eventName: finalName,
      topic: selectedTopic,
      startTime,
      startTimeISO: new Date(startTime / 1_000_000).toISOString(),
      endTime,
      endTimeISO: new Date(endTime / 1_000_000).toISOString(),
      visibleInPlot: false, // opt-in — keeps the plot column from cluttering by default
    };

    setAnnotations([...annotations, newAnnotation]);
    setSelectedIds(new Set(selectedIds).add(newId));
    setEventName("");
  }

  function toggleSelection(id: number) {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  }

  function handleRemoveAnnotation(id: number) {
    const target = annotations.find((a) => a.id === id);
    const label = target ? `"${target.eventName}"` : "this annotation";
    if (!window.confirm(`Remove ${label}? This can't be undone.`)) return;
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function toggleVisibleInPlot(id: number) {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, visibleInPlot: !a.visibleInPlot } : a)));
  }

  function setAllVisibleInPlot(value: boolean) {
    setAnnotations((prev) => prev.map((a) => ({ ...a, visibleInPlot: value })));
  }

  function reorderAnnotations(from: number, to: number) {
    setAnnotations((prev) => {
      const next = [...prev];
      const moved = next.splice(from, 1)[0]!;
      next.splice(to, 0, moved);
      return next;
    });
  }

  function startRowDrag(index: number) {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      dragRowIndexRef.current = index;
      setDragIndex(index);
    };
  }

  useEffect(() => {
    function handlePointerMove(e: PointerEvent) {
      if (dragRowIndexRef.current == null) return;
      let overIndex: number | null = null;
      for (let i = 0; i < annotations.length; i++) {
        const el = rowElsRef.current.get(annotations[i]!.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          overIndex = i;
          break;
        }
      }
      dragOverIndexRef.current = overIndex;
      setDragOverIndex(overIndex);
    }

    function handlePointerUp() {
      const from = dragRowIndexRef.current;
      const to = dragOverIndexRef.current;
      if (from != null && to != null && to !== from) {
        reorderAnnotations(from, to);
      }
      dragRowIndexRef.current = null;
      dragOverIndexRef.current = null;
      setDragIndex(null);
      setDragOverIndex(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [annotations]);

  // ── SESSION SAVE / LOAD (from MainPanel.tsx — annotations + colors only,
  //    see the scope note on parseSessionFile above) ──
  function handleSaveSession() {
    triggerDownload(`annotation_session_${Date.now()}.json`, {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      annotations,
      eventColors,
    });
  }

  function handleLoadSessionClick() {
    importInputRef.current?.click();
  }

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (annotations.length > 0) {
      const ok = window.confirm(
        `Loading a session will replace all ${annotations.length} current annotation(s). This can't be undone. Continue?`
      );
      if (!ok) return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof reader.result === "string" ? reader.result : "");
      } catch {
        alert("Couldn't read that file as JSON — nothing was loaded.");
        return;
      }

      const result = parseSessionFile(parsed);
      if (!result) {
        alert("This file doesn't look like a valid annotation session — nothing was loaded.");
        return;
      }

      const base = Date.now();
      const nextAnnotations = result.annotations.map((a, i) => ({ ...a, id: base + i }));

      setAnnotations(nextAnnotations);
      setSelectedIds(new Set());
      setColorPickerFor(null);

      setEventColors(() => {
        const next = { ...result.eventColors };
        let paletteIndex = Object.keys(next).length;
        for (const a of nextAnnotations) {
          if (!(a.eventName in next)) {
            next[a.eventName] = PALETTE[paletteIndex % PALETTE.length]!;
            paletteIndex += 1;
          }
        }
        return next;
      });

      if (result.droppedCount > 0) {
        alert(
          `Loaded ${nextAnnotations.length} annotation(s). ${result.droppedCount} entr${result.droppedCount === 1 ? "y was" : "ies were"} skipped for being malformed.`
        );
      }
    };
    reader.onerror = () => alert("Couldn't read that file — nothing was loaded.");
    reader.readAsText(file);
  }

  // ── EXPORT LOGIC (from MainPanel.tsx) ──
  function triggerDownload(filename: string, data: object) {
    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleExportJSON() {
    const selected = annotations.filter((a) => selectedIds.has(a.id));
    if (selected.length === 0) return alert("Select at least one annotation.");
    triggerDownload(`annotations_standard_${Date.now()}.json`, {
      exportedAt: new Date().toISOString(),
      totalAnnotations: selected.length,
      annotations: selected,
    });
  }

  function handleExportMCAPConfig() {
    const selected = annotations.filter((a) => selectedIds.has(a.id));
    if (selected.length === 0) return alert("Select at least one annotation.");
    triggerDownload(`mcap_slicer_config_${Date.now()}.json`, {
      instructions: "Run this JSON through the Python MCAP Slicer script.",
      input_mcap: "YOUR_INPUT_FILE.mcap",
      output_mcap: "sliced_output.mcap",
      slice_windows: selected.map((ann) => ({
        event_name: ann.eventName,
        target_topic: ann.topic,
        start_time_ns: ann.startTime,
        end_time_ns: ann.endTime,
      })),
    });
  }

  // ── PLOT-SIDE: FULL-RANGE DATA LOADING (from SignalPlotPanel.tsx) ──
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

  // ── PLOT-SIDE: SERIES MANAGEMENT (from SignalPlotPanel.tsx) ──
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

    const hasSample = latestByTopic[pendingTopic] !== undefined;
    if (hasSample && fieldSuggestions.length === 0) {
      setAddWarning(`"${pendingTopic}" doesn't appear to carry numeric data — "${trimmedField}" is unlikely to plot anything.`);
    } else {
      setAddWarning(null);
    }

    setPendingTopic("");
    setPendingField("");
  }

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
  const startPct = timeToPercent(startTime);
  const endPct = timeToPercent(endTime);
  const currentPct = timeToPercent(currentTime);

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

  function valueToY(v: number, min: number, max: number): number {
    const range = max - min;
    const norm = range > 0 ? (v - min) / range : 0.5;
    return PLOT_H - PLOT_PAD - norm * (PLOT_H - 2 * PLOT_PAD);
  }

  function clientXToTime(clientX: number): number | undefined {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return undefined;
    const fracX = (clientX - rect.left) / rect.width;
    return xToTime(Math.min(1, Math.max(0, fracX)) * PLOT_W);
  }

  function handlePlotPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    setPinnedAnnIds(new Set());
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

  // ── DERIVED DISPLAY DATA (from SignalPlotPanel.tsx) ──
  const seriesDisplay = useMemo(() => {
    let sharedMin = Infinity;
    let sharedMax = -Infinity;
    if (scaleMode === "shared") {
      for (const s of series) {
        if (!s.visible) continue;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, renderTick, scaleMode]);

  // Replaces the "savedAnnotations" global-variable read: the plot's
  // "shaded region" annotations are just this component's own `annotations`
  // filtered to the opt-in subset, computed directly instead of round-
  // tripping through context.setVariable/renderState.variables.
  const plottedAnnotations = useMemo(() => annotations.filter((a) => a.visibleInPlot), [annotations]);
  const hoverCardAnn = hoveredAnnId != null ? plottedAnnotations.find((a) => a.id === hoveredAnnId) ?? null : null;
  const pinnedList = plottedAnnotations.filter((a) => pinnedAnnIds.has(a.id));

  // ── UI (JSX) ─────────────────────────────────────────────────────────────
  // Outer container: fixed height, column direction (title, then the two-
  // column row below). No overflow here — each column scrolls on its own
  // (see col-annotate / col-plot below), matching the approved mockup.
  return (
    <div style={{ padding: "1rem", fontFamily: "sans-serif", height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", userSelect: "none" }}>
      <h2 style={{ marginBottom: "1rem", flexShrink: 0 }}>Ultimate Annotator — Merged (Experimental)</h2>

      {/* Two-column row. minHeight: 0 is required here — without it a flex
          child's overflowY:auto below silently fails to scroll, since flex
          items default to a min-height based on their content. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", flex: 1, minHeight: 0 }}>
        {/* ── LEFT COLUMN — annotation controls, from MainPanel.tsx ── */}
        <div style={{ flex: "1 1 320px", minWidth: "320px", height: "100%", overflowY: "auto", boxSizing: "border-box", paddingRight: "4px" }}>
          {/* SESSION SAVE / LOAD */}
          <div style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid #444" }}>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.3rem" }}>
              <button onClick={handleSaveSession} style={{ flex: 1, padding: "0.5rem", backgroundColor: "#555", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>
                Save Session
              </button>
              <button onClick={handleLoadSessionClick} style={{ flex: 1, padding: "0.5rem", backgroundColor: "#555", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>
                Load Session
              </button>
              <input ref={importInputRef} type="file" accept="application/json,.json" onChange={handleImportFileChange} style={{ display: "none" }} />
            </div>
            <div style={{ fontSize: "0.72rem", color: "#888" }}>
              Captures every annotation and its color, regardless of selection. Loading replaces the current session. (Signal Plot series aren't included — see task #7.)
            </div>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.3rem", fontWeight: "bold" }}>Select Topic</label>
            <SearchableSelect
              items={(topics ?? []).map((topic) => ({ name: topic.name, meta: topic.schemaName }))}
              value={selectedTopic}
              onChange={(next) => { setSelectedTopic(next); setEventName(""); }}
              mode="strict"
              placeholder="-- search topics --"
            />
          </div>

          <div style={{ marginBottom: "0.5rem", fontWeight: "bold" }}>Event span</div>
          {!haveRange ? (
            <div style={{ padding: "1.5rem", textAlign: "center", color: "#888", border: "1px dashed #555", borderRadius: "6px", marginBottom: "1rem" }}>
              No recording loaded — open an MCAP file to see the timeline.
            </div>
          ) : (
            <>
              <div
                ref={trackRef}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerLeave={handleTrackPointerLeave}
                style={{ position: "relative", width: "100%", height: "56px", flexShrink: 0, backgroundColor: "#2a2a2a", border: "1px solid #444", borderRadius: "6px", marginBottom: "0.4rem", cursor: canSeek ? "pointer" : "default" }}
              >
                <div style={{ position: "absolute", top: 0, bottom: 0, left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%`, backgroundColor: "rgba(51, 136, 255, 0.25)", borderLeft: "1px solid rgba(51,136,255,0.6)", borderRight: "1px solid rgba(51,136,255,0.6)" }} />

                {currentTime != undefined && (
                  <div style={{ position: "absolute", top: 0, bottom: 0, left: `${currentPct}%`, width: "2px", backgroundColor: "#ffd54a", transform: "translateX(-1px)", pointerEvents: "none" }}>
                    <div style={{ position: "absolute", top: "-6px", left: "-4px", width: 0, height: 0, borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: "6px solid #ffd54a" }} />
                  </div>
                )}

                <div onPointerDown={startDrag("start")} style={{ position: "absolute", top: 0, bottom: 0, left: `${startPct}%`, width: "12px", transform: "translateX(-6px)", backgroundColor: "#2a7", borderRadius: "3px", cursor: "ew-resize", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ width: "2px", height: "40%", backgroundColor: "rgba(255,255,255,0.7)" }} />
                </div>

                <div onPointerDown={startDrag("end")} style={{ position: "absolute", top: 0, bottom: 0, left: `${endPct}%`, width: "12px", transform: "translateX(-6px)", backgroundColor: "#e74", borderRadius: "3px", cursor: "ew-resize", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ width: "2px", height: "40%", backgroundColor: "rgba(255,255,255,0.7)" }} />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#888", marginBottom: "0.25rem" }}>
                <span>0:00.000</span>
                <span>{formatRelative(recEnd!, recStart!)}</span>
              </div>
              <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "0.75rem", minHeight: "1em" }}>
                {!canSeek ? "Click-to-seek isn't supported for this data source." : null}
              </div>
            </>
          )}

          <div style={{ marginBottom: "1rem", fontSize: "0.85rem" }}>
            <div>Start: <span style={{ color: "#2a7" }}>{startTime != undefined && haveRange ? `${formatRelative(startTime, recStart!)} (${new Date(startTime / 1_000_000).toISOString()})` : "not set"}</span></div>
            <div>End: <span style={{ color: "#e74" }}>{endTime != undefined && haveRange ? `${formatRelative(endTime, recStart!)} (${new Date(endTime / 1_000_000).toISOString()})` : "not set"}</span></div>
            <div style={{ color: "#888" }}>Playhead: {currentTime != undefined && haveRange ? formatRelative(currentTime, recStart!) : "—"}</div>
          </div>

          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
            <button onClick={handleSetStart} style={{ flex: 1, padding: "0.5rem", backgroundColor: "#2a7", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Set Start to Playhead</button>
            <button onClick={handleSetEnd} style={{ flex: 1, padding: "0.5rem", backgroundColor: "#e74", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Set End to Playhead</button>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.3rem", fontWeight: "bold" }}>Event Name (Use identical names to link sensors)</label>
            <input type="text" value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="auto-named on save if left blank" style={{ width: "100%", padding: "0.3rem", boxSizing: "border-box" }} />
          </div>

          <button onClick={handleSaveAnnotation} style={{ width: "100%", padding: "0.5rem", backgroundColor: "#338", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", marginBottom: "0.5rem", fontWeight: "bold" }}>
            Save Annotation
          </button>

          {/* CHECKBOX LIST */}
          <div style={{ flexShrink: 0, borderTop: "1px solid #444", paddingTop: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.5rem" }}>
              <h3 style={{ margin: 0 }}>Saved Annotations ({annotations.length})</h3>
              {annotations.length > 1 && (
                <div style={{ fontSize: "0.75rem" }}>
                  <a onClick={() => setAllVisibleInPlot(true)} style={{ color: "#b388ff", cursor: "pointer", marginRight: "0.6rem" }}>Show all in plot</a>
                  <a onClick={() => setAllVisibleInPlot(false)} style={{ color: "#888", cursor: "pointer" }}>Hide all</a>
                </div>
              )}
            </div>
            {annotations.length === 0 ? (
              <p style={{ color: "#888", fontSize: "0.85rem" }}>No annotations yet. Drag the timeline and click Save!</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {annotations.map((ann, index) => (
                  <div
                    key={ann.id}
                    ref={(el) => {
                      if (el) rowElsRef.current.set(ann.id, el);
                      else rowElsRef.current.delete(ann.id);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.8rem",
                      padding: "0.5rem",
                      backgroundColor: "#1e1e1e",
                      border: dragOverIndex === index && dragIndex !== index ? "1px solid #3388ff" : "1px solid #444",
                      borderTop: dragOverIndex === index && dragIndex !== index ? "2px solid #3388ff" : undefined,
                      borderRadius: "4px",
                      fontSize: "0.85rem",
                      opacity: dragIndex === index ? 0.4 : 1,
                    }}
                  >
                    <span onPointerDown={startRowDrag(index)} style={{ color: "#666", fontSize: "0.85rem", userSelect: "none", flexShrink: 0, cursor: dragIndex === index ? "grabbing" : "grab", touchAction: "none" }} title="Drag to reorder">⋮⋮</span>

                    <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", flexShrink: 0 }}>
                      <button
                        onClick={() => setColorPickerFor((cur) => (cur === ann.eventName ? null : ann.eventName))}
                        title={`Color for all "${ann.eventName}" annotations`}
                        style={{ width: "16px", height: "16px", borderRadius: "50%", backgroundColor: eventColors[ann.eventName] ?? DEFAULT_COLOR, border: "1px solid #555", cursor: "pointer", padding: 0 }}
                      />
                      {colorPickerFor === ann.eventName && (
                        <div style={{ display: "flex", gap: "0.2rem" }}>
                          {PALETTE.map((c) => (
                            <button
                              key={c}
                              onClick={() => recolorEvent(ann.eventName, c)}
                              title={c}
                              style={{
                                width: "14px",
                                height: "14px",
                                borderRadius: "50%",
                                backgroundColor: c,
                                cursor: "pointer",
                                padding: 0,
                                border: c === (eventColors[ann.eventName] ?? DEFAULT_COLOR) ? "2px solid #fff" : "1px solid #555",
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    <input
                      type="checkbox"
                      checked={selectedIds.has(ann.id)}
                      onChange={() => toggleSelection(ann.id)}
                      style={{ transform: "scale(1.3)", cursor: "pointer", margin: "0 0.5rem" }}
                    />
                    <div style={{ flex: 1 }}>
                      {/* Explicit light color — see the same fix already
                          applied in MainPanel.tsx's Saved Annotations list. */}
                      <div style={{ fontWeight: "bold", fontSize: "0.9rem", color: "#f2f2f2" }}>{ann.eventName}</div>
                      <div style={{ color: "#aaa", marginBottom: "0.2rem" }}>Topic: {ann.topic}</div>
                      <div>
                        <span style={{ color: "#2a7", fontWeight: "bold" }}>Start:</span>{" "}
                        <span style={{ color: "#ccc" }}>{ann.startTimeISO.split("T")[1]}</span>
                      </div>
                      <div>
                        <span style={{ color: "#e74", fontWeight: "bold" }}>End:</span>{" "}
                        <span style={{ color: "#ccc" }}>{ann.endTimeISO.split("T")[1]}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => toggleVisibleInPlot(ann.id)}
                      title="Show this annotation as a shaded region in the plot"
                      style={{
                        padding: "0.3rem 0.6rem",
                        backgroundColor: ann.visibleInPlot ? "#553388" : "#333",
                        color: ann.visibleInPlot ? "white" : "#999",
                        border: ann.visibleInPlot ? "1px solid #b388ff" : "1px solid #444",
                        borderRadius: "4px",
                        cursor: "pointer",
                        flexShrink: 0,
                        alignSelf: "flex-start",
                        fontSize: "0.8rem",
                      }}
                    >
                      {ann.visibleInPlot ? "◉ In plot" : "○ Show in plot"}
                    </button>
                    <button
                      onClick={() => handleRemoveAnnotation(ann.id)}
                      style={{ padding: "0.3rem 0.6rem", backgroundColor: "#822", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", flexShrink: 0, alignSelf: "flex-start" }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* DUAL EXPORT BUTTONS */}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid #444" }}>
            <button onClick={handleExportJSON} style={{ flex: 1, padding: "0.6rem", backgroundColor: "#555", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>
              Export Standard JSON
            </button>
            <button onClick={handleExportMCAPConfig} style={{ flex: 1, padding: "0.6rem", backgroundColor: "#822", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>
              Export MCAP Config
            </button>
          </div>
        </div>

        {/* ── RIGHT COLUMN — Signal Plot, from SignalPlotPanel.tsx ── */}
        <div style={{ flex: "1.4 1 380px", minWidth: "380px", height: "100%", overflowY: "auto", boxSizing: "border-box", paddingRight: "4px" }}>
          <h2 style={{ marginBottom: "1rem" }}>Signal Plot</h2>

          {/* ADD SERIES CONTROLS — topic on its own row, field + Add below,
              same two-row split already applied to SignalPlotPanel.tsx. */}
          <div style={{ marginBottom: "0.5rem" }}>
            <div style={{ marginBottom: "0.5rem" }}>
              <SearchableSelect
                items={(topics ?? []).map((topic) => ({ name: topic.name, meta: topic.schemaName }))}
                value={pendingTopic}
                onChange={(next) => { setPendingTopic(next); setPendingField(""); }}
                mode="strict"
                placeholder="-- search topics --"
              />
            </div>

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px" }}>
                <SearchableSelect
                  items={fieldSuggestions.map((f) => ({ name: f }))}
                  value={pendingField}
                  onChange={setPendingField}
                  mode="combobox"
                  placeholder={pendingTopic ? (fieldSuggestions[0] ?? "type a numeric field path, e.g. linear_acceleration.x") : "select a topic first"}
                  disabled={!pendingTopic}
                />
              </div>

              <button
                onClick={handleAddSeries}
                disabled={!pendingTopic || !pendingField}
                style={{ padding: "0.3rem 0.8rem", backgroundColor: "#338", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
              >
                Add
              </button>
            </div>
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
                  {/* Shaded regions for annotations opted into the plot —
                      reads `plottedAnnotations` (local state) directly now,
                      instead of the "savedAnnotations" global variable. */}
                  {plottedAnnotations.map((ann) => {
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
                          e.stopPropagation();
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

                  {/* Current start/end boundary lines — reads startTime/
                      endTime (this component's own state) directly instead
                      of the annotationStartTimeNs/EndTimeNs global variables,
                      so there's no longer even a render-frame of lag between
                      dragging a handle and the plot line moving. */}
                  {startTime != undefined && (
                    <line x1={timeToX(startTime)} x2={timeToX(startTime)} y1={0} y2={PLOT_H} stroke="#2a7" strokeWidth={2} pointerEvents="none" />
                  )}
                  {endTime != undefined && (
                    <line x1={timeToX(endTime)} x2={timeToX(endTime)} y1={0} y2={PLOT_H} stroke="#e74" strokeWidth={2} pointerEvents="none" />
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

              {plottedAnnotations.length > 0 && (
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
                          {/* Unlike SignalPlotPanel.tsx (where this is still
                              deliberately left unfixed — "Keep in View for
                              now"), this brand-new file gets the explicit
                              color from the start since there's no reason to
                              copy a known bug into new code. Revert to no
                              color here if you'd rather this file matched
                              the original exactly. */}
                          <span style={{ fontWeight: "bold", color: "#eee" }}>{ann.eventName}</span>{" "}
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
                        <div style={{ fontWeight: "bold", color: "#eee" }}>
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
      </div>
    </div>
  );
}

export function initMergedAnnotatorPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<MergedAnnotatorPanel context={context} />);
  return () => { root.unmount(); };
}
