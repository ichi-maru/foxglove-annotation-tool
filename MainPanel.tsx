import { Immutable, PanelExtensionContext, Topic, VariableValue } from "@foxglove/extension";
import { ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchableSelect } from "./SearchableSelect";

// ─── DATA MODEL ────────────────────────────────────────────────────────────
type Annotation = {
  id: number;             // Unique ID for the checkbox system
  eventName: string;
  topic: string;
  fieldPath: string;      // Which numeric field within the topic's message this event
                           // is about (e.g. "linear_acceleration.x") — required going
                           // forward for newly created annotations, but "" is accepted
                           // on import from a pre-existing session file that predates
                           // this field (additive field, same treatment category got).
                           // Metadata only: the MCAP Slicer still slices whole
                           // messages/topics, never individual fields.
  startTime: number;      
  startTimeISO: string;   
  endTime: number;        
  endTimeISO: string;
  visibleInPlot: boolean; // Opt-in: whether this annotation is published for the Signal Plot to visualize
  category: string;       // Optional label/tag ("" = none) — pure display, doesn't touch color logic,
                           // filtering, or the allAnnotations publish below (Main-Panel-only for now).
};

// Lightweight shape published via the "savedAnnotations" / "allAnnotations"
// global variables — only what a consumer (Signal Plot, Global Annotation
// Timeline) needs, not the full Annotation (no ISO strings, no
// checkbox/visibility fields).
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
// hex used for the live playhead line on both this panel and Signal Plot, so
// keeping it out of the assignable set means an annotation color can never
// be mistaken for the playhead crossing through it.
// LIMITATION: only 6 colors — a 7th distinct event name cycles back to a
// color already in use unless the user manually spreads them apart via the
// picker.
const PALETTE = ["#3388ff", "#ee7744", "#2aa77a", "#4dd0c4", "#b388ff", "#ff6ec7"];
const DEFAULT_COLOR = "#888888";

// ─── SESSION FILE VALIDATION ────────────────────────────────────────────────
// A saved session is { schemaVersion, savedAt, annotations, eventColors }.
// These guards mirror the isSavedAnnotation pattern used in the other panel
// files: a malformed or hand-edited file is reported, not crashed on, and
// individual malformed entries are dropped rather than rejecting an
// otherwise-good file outright.
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
    typeof o.visibleInPlot === "boolean" &&
    (o.category === undefined || typeof o.category === "string") && // additive field — old session files won't have it
    (o.fieldPath === undefined || typeof o.fieldPath === "string") // additive field — same treatment as category
  );
}

function isValidEventColors(v: unknown): v is Record<string, string> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((c) => typeof c === "string");
}

type ParsedSession = {
  annotations: Annotation[];
  eventColors: Record<string, string>;
  droppedCount: number;
  // Signal Plot's series list, round-tripped opaquely — Main Panel doesn't
  // understand series internals, it just shallow-validates "is this an
  // array" (same treatment as eventColors above) and hands the raw entries
  // to Signal Plot via signalPlotLoadCommand, which does its own full
  // per-entry validation independently. See handover §4.
  signalPlotSeries: unknown[];
};

function parseSessionFile(parsed: unknown): ParsedSession | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.annotations)) return null;
  const validAnnotations = obj.annotations.filter(isValidAnnotation);
  const droppedCount = obj.annotations.length - validAnnotations.length;
  if (validAnnotations.length === 0 && obj.annotations.length > 0) return null; // every entry malformed — likely the wrong file entirely
  const eventColors = isValidEventColors(obj.eventColors) ? obj.eventColors : {};
  const signalPlotSeries = Array.isArray(obj.signalPlotSeries) ? obj.signalPlotSeries : [];
  return { annotations: validAnnotations, eventColors, droppedCount, signalPlotSeries };
}

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

// ─── FIELD-PATH HELPER (duplicated from SignalPlotPanel.tsx on purpose —
//     see that file's header comment for why each panel stays
//     self-contained) ───────────────────────────────────────────────────────
// Walks a sample message and returns dot-notation paths to every numeric
// leaf, so the Sensor Field input can suggest them — same function as
// Signal Plot's, used the same way.
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

// ─── PANEL COMPONENT ───────────────────────────────────────────────────────
function MainPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [selectedTopic, setSelectedTopic] = useState<string>("");
  const [eventName, setEventName] = useState<string>("");
  const [fieldPath, setFieldPath] = useState<string>(""); // pending Sensor Field for the next annotation — required, unlike category
  const [category, setCategory] = useState<string>(""); // pending category for the next annotation

  // Shown as an in-page banner instead of alert() for one-way messages
  // (import/export errors, load results) — NOT the Save Annotation
  // required-field check, which has its own dedicated saveWarning banner
  // right next to that button instead (see below). NOT a native blocking
  // dialog on purpose: Electron has a longstanding, upstream-confirmed bug
  // where alert()/confirm() can leave the renderer's focus/pointer-event
  // routing stuck afterward — dropdowns silently stop responding to clicks
  // until the window loses and regains OS focus (e.g. switching tabs and
  // back). See https://github.com/electron/electron/issues/19977 and
  // https://github.com/electron/electron/issues/40212, both confirmed by
  // an Electron maintainer. An in-page element has no such dialog, so no
  // such focus loss. Cleared automatically the next time a new notice is
  // shown, or manually via the banner's own dismiss button.
  const [notice, setNotice] = useState<string | null>(null);

  // Dedicated to the Save Annotation required-field check specifically —
  // shown right above that button rather than in the shared notice banner
  // at the top of the panel, since this one is inline validation tied to
  // a specific action the user is looking at right when it fires, not a
  // general result/error the user might see from anywhere in the panel.
  const [saveWarning, setSaveWarning] = useState<string | null>(null);

  // Replaces window.confirm() for the two sites that need the user to
  // actually choose (Remove Annotation, Load Session over existing
  // annotations) — same Electron bug as above, but confirm() can't just
  // become a banner since the calling code depends on a synchronous
  // true/false return, which an in-page element can't give. Instead the
  // action to run on confirmation is stashed here and invoked from the
  // banner's own OK button; Cancel (or dismissing) just clears this
  // without running anything.
  const [pendingConfirm, setPendingConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Live samples, keyed by topic — used only to auto-suggest numeric field
  // paths for whichever topic is currently selected. Same pattern as Signal
  // Plot's own latestByTopic, kept independent (Option A: Main Panel
  // discovers fields itself rather than reading them from Signal Plot) so
  // Sensor Field suggestions work regardless of whether Signal Plot is even
  // open, and always match whatever topic THIS panel currently has selected.
  const [latestByTopic, setLatestByTopic] = useState<Record<string, unknown>>({});
  
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set()); // Checkbox State

  // Last-seen value of the "signalPlotSeries" global variable, published
  // continuously by Signal Plot (mirrors how Signal Plot already reads
  // "savedAnnotations"/"allAnnotations" published by this panel — this is
  // the reverse direction). Kept loosely typed on purpose: Main Panel only
  // needs to round-trip this into/out of the saved session file, not
  // understand series internals. Only shallow-validated as "is it an
  // array", same as other passthrough session data.
  const [lastKnownSignalPlotSeries, setLastKnownSignalPlotSeries] = useState<unknown[]>([]);

  // Per-event-name color, keyed so the same event name always gets the same
  // color even across different topics (e.g. "layer_shift" on both an IMU
  // and a camera topic). Auto-assigned from PALETTE the first time a name is
  // seen (see assignColorIfNew); user overrides via the picker persist here
  // too, since that same function only fills in MISSING keys and never
  // overwrites an existing one.
  const [eventColors, setEventColors] = useState<Record<string, string>>({});
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null); // eventName, or null

  // Drag-to-reorder state for the Saved Annotations list. Reordering is
  // display order only — it changes the array position (and therefore which
  // lane an annotation lands in on the Global Annotation Timeline panel),
  // but does not change which annotations are selected/exported, only the
  // sequence they appear in within the exported JSON.
  //
  // Deliberately NOT using native HTML5 drag-and-drop (draggable/dragstart/
  // drop) — that API is inconsistent inside embedded/iframe contexts like a
  // Foxglove panel, and did not work in testing. Instead this reuses the
  // exact same mechanism the timeline start/end handles above already use
  // successfully: plain pointerdown on the drag handle plus window-level
  // pointermove/pointerup listeners, no browser drag subsystem involved.
  const dragRowIndexRef = useRef<number | null>(null);
  const dragOverIndexRef = useRef<number | null>(null);
  const rowElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Timeline State
  const [recStart, setRecStart] = useState<number | undefined>();
  const [recEnd, setRecEnd] = useState<number | undefined>();
  const [currentTime, setCurrentTime] = useState<number | undefined>();
  const [startTime, setStartTime] = useState<number | undefined>();
  const [endTime, setEndTime] = useState<number | undefined>();

  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<null | "start" | "end" | "seek">(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // ── FOXGLOVE SETUP ──
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setTopics(renderState.topics);

      if (renderState.startTime != undefined) setRecStart(timeToNanos(renderState.startTime));
      if (renderState.endTime != undefined) setRecEnd(timeToNanos(renderState.endTime));
      if (renderState.currentTime != undefined) setCurrentTime(timeToNanos(renderState.currentTime));

      // First time this panel reads a global variable rather than only
      // writing one — Signal Plot continuously publishes its own series
      // list here so a session save can capture it. Shallow "is it an
      // array" validation only; Signal Plot re-validates fully on its own
      // side whenever it reads this same data back via signalPlotLoadCommand.
      if (renderState.variables != undefined) {
        const rawSeries = renderState.variables.get("signalPlotSeries");
        setLastKnownSignalPlotSeries(Array.isArray(rawSeries) ? rawSeries : []);
      }

      // Sample messages for whichever topic is currently subscribed (see
      // the "SENSOR FIELD DISCOVERY" effect below) so Sensor Field
      // suggestions can be derived from real message content — same
      // fold-into-record pattern Signal Plot uses for its own
      // latestByTopic.
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
    context.watch("variables");
  }, [context]);

  // ── SENSOR FIELD DISCOVERY ──
  // Live-subscribes to whichever topic is currently selected, so a message
  // can be sampled and its numeric fields suggested for "Sensor Field" —
  // same pattern as Signal Plot's own pendingTopic subscription effect.
  // Separate from the FOXGLOVE SETUP effect above (which only runs once,
  // on mount) since this needs to re-subscribe every time selectedTopic
  // changes.
  useEffect(() => {
    context.subscribe(selectedTopic ? [{ topic: selectedTopic }] : []);
  }, [context, selectedTopic]);

  const fieldSuggestions = useMemo(() => {
    const sample = selectedTopic ? latestByTopic[selectedTopic] : undefined;
    return sample ? discoverNumericPaths(sample) : [];
  }, [selectedTopic, latestByTopic]);

  useEffect(() => { renderDone?.(); }, [renderDone]);

  useEffect(() => {
    if (recStart != undefined && recEnd != undefined && recEnd > recStart) {
      if (startTime == undefined) setStartTime(recStart + (recEnd - recStart) * 0.25);
      if (endTime == undefined) setEndTime(recStart + (recEnd - recStart) * 0.75);
    }
  }, [recStart, recEnd]);

  // Publish the annotation start/end as global variables so other panels
  // (e.g. the Signal Plot panel) can read them via renderState.variables.
  // This fires on every change regardless of *how* startTime/endTime
  // changed (drag, the Set-to-Playhead buttons, or the default above), so
  // there's a single source of truth rather than setVariable calls
  // scattered across every place that can move the handles.
  useEffect(() => {
    if (startTime != undefined) context.setVariable("annotationStartTimeNs", startTime);
  }, [context, startTime]);

  useEffect(() => {
    if (endTime != undefined) context.setVariable("annotationEndTimeNs", endTime);
  }, [context, endTime]);

  // Publishes two views for downstream panels:
  //  - "savedAnnotations": only the opt-in ("Show in plot") subset, for
  //    Signal Plot — unchanged filter, keeps that panel's original
  //    anti-clutter behavior exactly as it was.
  //  - "allAnnotations": every saved annotation, unfiltered, for the Global
  //    Annotation Timeline panel — that panel gives each annotation its own
  //    permanent lane specifically so it doesn't need the same opt-in
  //    filter to avoid clutter.
  // Both carry the resolved `color` so consumers never have to compute or
  // duplicate color logic themselves — this file is the single source of
  // truth for annotation color.
  useEffect(() => {
    const toPublished = (a: Annotation): PublishedAnnotation => ({
      id: a.id,
      eventName: a.eventName,
      topic: a.topic,
      startTime: a.startTime,
      endTime: a.endTime,
      color: eventColors[a.eventName] ?? DEFAULT_COLOR,
    });
    context.setVariable("savedAnnotations", annotations.filter((a) => a.visibleInPlot).map(toPublished));
    context.setVariable("allAnnotations", annotations.map(toPublished));
  }, [context, annotations, eventColors]);

  useEffect(() => {
    return () => {
      context.setVariable("annotationStartTimeNs", undefined);
      context.setVariable("annotationEndTimeNs", undefined);
      context.setVariable("savedAnnotations", undefined);
      context.setVariable("allAnnotations", undefined);
      context.setVariable("signalPlotLoadCommand", undefined);
    };
  }, [context]);

  // ── DRAG MECHANISM (timeline handles) ──
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

  // ── CLICK-TO-SEEK / DRAG-TO-SCRUB / HOVER-PREVIEW ──
  // seekPlayback is optional (some data sources, e.g. live connections,
  // don't support seeking) so it's feature-detected. setPreviewTime is
  // always available and is the same hover-preview signal the native seek
  // bar and Plot panel use, so hovering here shows a preview marker in
  // other panels too. This only fires from clicks that land on the track
  // background — the start/end handles call stopPropagation so grabbing
  // one never also triggers a seek.
  const canSeek = typeof context.seekPlayback === "function";
  const lastSeekRef = useRef(0);

  function nanosToTime(ns: number): { sec: number; nsec: number } {
    return { sec: Math.floor(ns / 1_000_000_000), nsec: ns % 1_000_000_000 };
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
    if (dragRef.current != null) return; // an active drag is handled by the window listener above
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

  // ── BUTTON LOGIC ──
  function handleSetStart() {
    if (currentTime == undefined) return;
    setStartTime(currentTime);
  }

  function handleSetEnd() {
    if (currentTime == undefined) return;
    setEndTime(currentTime);
  }

  // Assigns the next unused palette color to an event name the FIRST time
  // it's seen; a no-op (returns the same map) if the name already has a
  // color, so this never clobbers a manual override from the picker.
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
    if (selectedTopic === "" || fieldPath === "" || startTime == undefined || endTime == undefined) {
      setSaveWarning("Please select a topic, a sensor field, and set a start/end span on the timeline.");
      return;
    }
    setSaveWarning(null); // clear any earlier warning now that the save is actually going through
    
    const finalName = eventName !== "" ? eventName : `event_${annotations.length}/${selectedTopic.replace(/^\//, "")}`;
    const newId = Date.now();
    assignColorIfNew(finalName);

    const newAnnotation: Annotation = {
      id: newId,
      eventName: finalName,
      topic: selectedTopic,
      fieldPath,
      startTime,
      startTimeISO: new Date(startTime / 1_000_000).toISOString(),
      endTime,
      endTimeISO: new Date(endTime / 1_000_000).toISOString(),
      visibleInPlot: false, // opt-in — keeps the Signal Plot from cluttering by default
      category,
    };

    setAnnotations([...annotations, newAnnotation]);
    setSelectedIds(new Set(selectedIds).add(newId)); // Auto-check the box!
    setEventName("");
    setCategory(""); // reset, same as eventName — say the word if you'd rather this stayed sticky across saves
    setFieldPath(""); // reset too — a leftover field path from this annotation shouldn't silently carry into the next one
  }

  function toggleSelection(id: number) {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  }

  // Removes a saved annotation, guarded by a confirmation. Unlike a Signal
  // Plot series (cheap to re-add — just reselect a topic/field), a saved
  // annotation represents precisely-placed handles that aren't cheap to redo.
  function handleRemoveAnnotation(id: number) {
    const target = annotations.find((a) => a.id === id);
    const label = target ? `"${target.eventName}"` : "this annotation";
    setPendingConfirm({
      message: `Remove ${label}? This can't be undone.`,
      onConfirm: () => {
        setAnnotations((prev) => prev.filter((a) => a.id !== id));
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      },
    });
  }

  // Toggles whether a single annotation is published (via savedAnnotations)
  // for Signal Plot visualization. Default off — see handleSaveAnnotation —
  // so the plot doesn't clutter the moment you have more than a couple saved.
  function toggleVisibleInPlot(id: number) {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, visibleInPlot: !a.visibleInPlot } : a)));
  }

  function setAllVisibleInPlot(value: boolean) {
    setAnnotations((prev) => prev.map((a) => ({ ...a, visibleInPlot: value })));
  }

  // Reorders the Saved Annotations list by dragging — display order only
  // (see the comment on dragRowIndexRef above). Lanes on the Global
  // Annotation Timeline panel follow automatically since they're derived
  // from this same array's order; no extra plumbing needed there.
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

  // Global listeners for the row-reorder drag, active for the whole
  // component lifetime (each handler no-ops unless a row drag is actually
  // in progress) — same shape as the timeline handles' own pointermove/
  // pointerup effect above. Hit-testing is done by checking the dragged
  // pointer's Y position against each row's live bounding rect rather than
  // relying on native dragover targets.
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

  // ── SESSION SAVE / LOAD ──
  // Captures the FULL working state (every annotation regardless of
  // selection, plus event colors) so a session can be closed and reopened
  // without losing progress. Distinct from the Export buttons below, which
  // only ever act on the checked subset for handing off to someone else —
  // that filter stays untouched.
  function handleSaveSession() {
    triggerDownload(`annotation_session_${Date.now()}.json`, {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      annotations,
      eventColors,
      // Whatever Signal Plot last published, round-tripped opaquely. Only
      // present if Signal Plot was open at some point this session — see
      // handover §4 "Accepted limitation".
      signalPlotSeries: lastKnownSignalPlotSeries,
    });
  }

  function handleLoadSessionClick() {
    importInputRef.current?.click();
  }

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-selecting the same file still fires onChange next time
    if (!file) return;

    if (annotations.length > 0) {
      setPendingConfirm({
        message: `Loading a session will replace all ${annotations.length} current annotation(s). This can't be undone. Continue?`,
        onConfirm: () => processSessionFile(file),
      });
      return;
    }

    processSessionFile(file);
  }

  // The actual file-read-and-apply logic, split out from
  // handleImportFileChange so it can be invoked either immediately (no
  // existing annotations to lose) or from the pendingConfirm banner's OK
  // button (existing annotations present) — same behavior as before this
  // file's window.confirm() was replaced, just no longer gated by a
  // synchronous return value.
  function processSessionFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof reader.result === "string" ? reader.result : "");
      } catch {
        setNotice("Couldn't read that file as JSON — nothing was loaded.");
        return;
      }

      const result = parseSessionFile(parsed);
      if (!result) {
        setNotice("This file doesn't look like a valid annotation session — nothing was loaded.");
        return;
      }

      // Regenerate ids to guarantee no collision with anything created
      // later in this session — the annotation's real identity for our
      // purposes is its name/topic/times, not this internal number.
      const base = Date.now();
      const nextAnnotations = result.annotations.map((a, i) => ({ ...a, id: base + i, category: a.category ?? "", fieldPath: a.fieldPath ?? "" }));

      setAnnotations(nextAnnotations);
      setSelectedIds(new Set());
      setColorPickerFor(null);

      // Replace the color map with the imported one, then top up any event
      // name that didn't have a saved color (e.g. a session saved before
      // colors existed) with a fresh palette color — same as what happens
      // when a brand-new annotation is created.
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
        setNotice(
          `Loaded ${nextAnnotations.length} annotation(s). ${result.droppedCount} entr${result.droppedCount === 1 ? "y was" : "ies were"} skipped for being malformed.`
        );
      } else {
        setNotice(null); // clear any earlier notice (e.g. a previous failed load) now that this one succeeded cleanly
      }

      // One-shot command for Signal Plot, fired on EVERY load — including an
      // empty array — so loading an older, plot-less session correctly
      // clears Signal Plot's series rather than leaving stale ones behind.
      // loadId lets Signal Plot distinguish "a fresh load just happened"
      // from "the variable still holds whatever was last written" (e.g. on
      // a later panel reopen after the user has since edited their series
      // by hand) — Signal Plot only acts when loadId is new.
      // Cast needed here only: result.signalPlotSeries came straight out of
      // JSON.parse (via parseSessionFile's shallow Array.isArray check), so
      // it's always JSON-safe and satisfies VariableValue structurally —
      // TS just can't verify that through the deliberately-loose `unknown[]`
      // type this panel uses for series it doesn't understand.
      context.setVariable("signalPlotLoadCommand", {
        series: result.signalPlotSeries as VariableValue[],
        loadId: Date.now(),
      });
    };
    reader.onerror = () => setNotice("Couldn't read that file — nothing was loaded.");
    reader.readAsText(file);
  }

  // ── EXPORT LOGIC ──
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
    const selected = annotations.filter(a => selectedIds.has(a.id));
    if (selected.length === 0) { setNotice("Select at least one annotation."); return; }
    triggerDownload(`annotations_standard_${Date.now()}.json`, {
      exportedAt: new Date().toISOString(),
      totalAnnotations: selected.length,
      annotations: selected,
    });
  }

  function handleExportMCAPConfig() {
    const selected = annotations.filter(a => selectedIds.has(a.id));
    if (selected.length === 0) { setNotice("Select at least one annotation."); return; }
    triggerDownload(`mcap_slicer_config_${Date.now()}.json`, {
      instructions: "Run this JSON through the Python MCAP Slicer script.",
      input_mcap: "YOUR_INPUT_FILE.mcap",
      output_mcap: "sliced_output.mcap",
      slice_windows: selected.map(ann => ({
        event_name: ann.eventName,
        target_topic: ann.topic,
        field_path: ann.fieldPath, // metadata only — the slicer still cuts the whole message/topic, this just
                                    // records which specific field the annotator was actually looking at
        start_time_ns: ann.startTime,
        end_time_ns: ann.endTime,
        category: ann.category
      }))
    });
  }

  const haveRange = recStart != undefined && recEnd != undefined && recEnd > recStart;
  const startPct = timeToPercent(startTime);
  const endPct = timeToPercent(endTime);
  const currentPct = timeToPercent(currentTime);
  const existingEventNames = Array.from(new Set(annotations.map((a) => a.eventName))).sort();
  const existingCategories = Array.from(new Set(annotations.map((a) => a.category).filter((c) => c !== ""))).sort();

  // ── UI (JSX) ─────────────────────────────────────────────────────────────
  return (
    <div style={{ height: "100%", boxSizing: "border-box", position: "relative" }}>
      <div style={{ padding: "1rem", fontFamily: "sans-serif", height: "100%", boxSizing: "border-box", overflowY: "auto", display: "flex", flexDirection: "column", userSelect: "none" }}>
      <h2 style={{ marginBottom: "1rem" }}>Ultimate Annotator — Timeline & MCAP</h2>

      {/* In-page replacement for window.confirm()/alert() — see the
          pendingConfirm/notice state declarations above for why. notice
          (the non-modal banner) stays inline here, inside the scrolling
          content — it's a passive message, not something that needs to
          block interaction. pendingConfirm itself renders OUTSIDE this
          inner scrolling div (see below, as a sibling against the OUTER
          non-scrolling frame) — it used to be nested here too, but inset:0
          against a position:relative ancestor sizes to that ancestor's OWN
          box, not its scrolled content height; since this div is the one
          that scrolls (overflowY:auto), an overlay nested inside it only
          ever covered the panel's visible viewport-height, leaving
          anything below the fold (e.g. a long Saved Annotations list)
          outside the dimmed/blocked region and still clickable. Anchoring
          it instead to the outer frame — which has a fixed height and
          never scrolls — makes inset:0 match the panel's true full bounds
          every time, regardless of how tall the content inside is. */}
      {pendingConfirm == null && notice != null && (
        <div style={{ marginBottom: "1rem", padding: "0.5rem 0.6rem", fontSize: "0.8rem", color: "#e0a030", backgroundColor: "#2a2010", border: "1px solid #7a5a1a", borderRadius: "4px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
          <span>{notice}</span>
          <a onClick={() => setNotice(null)} style={{ color: "#e0a030", cursor: "pointer", flexShrink: 0, fontWeight: "bold" }}>✕</a>
        </div>
      )}

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
          Captures every annotation and its color, regardless of selection. Loading replaces the current session.
        </div>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", marginBottom: "0.3rem", fontWeight: "bold" }}>Select Topic</label>
        {/* Searchable/filterable topic picker — replaces the plain <select>.
            "strict" mode: only an existing topic can be committed; typing just
            filters the list down. See SearchableSelect.tsx for the full
            interaction behavior (keyboard nav, click-outside, empty state). */}
        <SearchableSelect
          items={(topics ?? []).map((topic) => ({ name: topic.name, meta: topic.schemaName }))}
          value={selectedTopic}
          onChange={(next) => { setSelectedTopic(next); setEventName(""); setFieldPath(""); }}
          mode="strict"
          placeholder="-- search topics --"
        />
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", marginBottom: "0.3rem", fontWeight: "bold" }}>Sensor Field</label>
        {/* Required, unlike Category below — an annotation is about a specific
            numeric field within the topic's message (e.g.
            "linear_acceleration.x"), not the topic as a whole. Suggestions
            come from a message actually sampled on the selected topic (see
            the "SENSOR FIELD DISCOVERY" subscription effect above) — same
            combobox pattern as Event Name/Category, so typing still works
            even before any suggestions have loaded. Cleared whenever the
            topic changes, since a field path from a different topic's
            schema is meaningless here. */}
        <SearchableSelect
          items={fieldSuggestions.map((f) => ({ name: f }))}
          value={fieldPath}
          onChange={setFieldPath}
          mode="combobox"
          placeholder={selectedTopic ? (fieldSuggestions[0] ?? "type a numeric field path, e.g. linear_acceleration.x") : "select a topic first"}
          disabled={!selectedTopic}
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
            <span>{formatRelative(recEnd, recStart)}</span>
          </div>
          <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "0.75rem", minHeight: "1em" }}>
            {!canSeek ? "Click-to-seek isn't supported for this data source." : null}
          </div>
        </>
      )}

      <div style={{ marginBottom: "1rem", fontSize: "0.85rem" }}>
        <div>Start: <span style={{ color: "#2a7" }}>{startTime != undefined && haveRange ? `${formatRelative(startTime, recStart)} (${new Date(startTime / 1_000_000).toISOString()})` : "not set"}</span></div>
        <div>End: <span style={{ color: "#e74" }}>{endTime != undefined && haveRange ? `${formatRelative(endTime, recStart)} (${new Date(endTime / 1_000_000).toISOString()})` : "not set"}</span></div>
        <div style={{ color: "#888" }}>Playhead: {currentTime != undefined && haveRange ? formatRelative(currentTime, recStart) : "—"}</div>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button onClick={handleSetStart} style={{ flex: 1, padding: "0.5rem", backgroundColor: "#2a7", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Set Start to Playhead</button>
        <button onClick={handleSetEnd} style={{ flex: 1, padding: "0.5rem", backgroundColor: "#e74", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Set End to Playhead</button>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", marginBottom: "0.3rem", fontWeight: "bold" }}>Event Name (Use identical names to link sensors)</label>
        {/* Combobox mode: existing event names (from annotations already
            saved this session) are suggested so you can reuse one to link
            annotations across sensors/topics — but any typed text is still
            a valid value, same as the field-path picker in Signal Plot. */}
        <SearchableSelect
          items={existingEventNames.map((name) => ({ name }))}
          value={eventName}
          onChange={setEventName}
          mode="combobox"
          placeholder="type or pick an existing name — auto-named on save if left blank"
        />
      </div>
      
      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", marginBottom: "0.3rem", fontWeight: "bold" }}>Category (optional)</label>
        {/* Same combobox pattern again — free-form label/tag, not a fixed
            taxonomy. Suggestions are categories already used this session;
            leaving it blank means no category (never auto-filled). */}
        <SearchableSelect
          items={existingCategories.map((name) => ({ name }))}
          value={category}
          onChange={setCategory}
          mode="combobox"
          placeholder="type or pick an existing category — optional"
        />
      </div>

      {saveWarning != null && (
        <div style={{ marginBottom: "0.5rem", padding: "0.5rem 0.6rem", fontSize: "0.8rem", color: "#e0a030", backgroundColor: "#2a2010", border: "1px solid #7a5a1a", borderRadius: "4px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
          <span>{saveWarning}</span>
          <a onClick={() => setSaveWarning(null)} style={{ color: "#e0a030", cursor: "pointer", flexShrink: 0, fontWeight: "bold" }}>✕</a>
        </div>
      )}

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
                  {/* Event name: explicit light color instead of inheriting the page's default text color, which read as grey-on-grey against the dark
                      row background (#1e1e1e). The color swatch button to the left is what carries the event's assigned color — this text stays neutral
                      so it's always legible regardless of which palette color (or the grey DEFAULT_COLOR fallback) the event happens to have. */}
                  <div style={{ fontWeight: "bold", fontSize: "0.9rem", color: "#f2f2f2" }}>{ann.eventName}</div>
                  <div style={{ color: "#aaa", marginBottom: "0.2rem" }}>Topic: {ann.topic}</div>
                  {ann.fieldPath !== "" && (
                    <div style={{ color: "#aaa", marginBottom: "0.2rem" }}>Field: <span style={{ color: "#8ab4ff" }}>{ann.fieldPath}</span></div>
                  )}
                  {ann.category !== "" && (
                  <div style={{ marginBottom: "0.3rem" }}>
                    <span style={{ display: "inline-block", padding: "0.05rem 0.45rem", fontSize: "0.72rem", color: "#ccc", backgroundColor: "#2a2a2a", border: "1px solid #555", borderRadius: "10px" }}>
                      {ann.category}
                    </span>
                  </div>
                  )}
                  {/* Start/End labels keep their green/red accent color; the timestamp VALUE next to each label gets its own explicit light color so it's
                      not the same washed-out grey it was inheriting before. */}
                  <div>
                    <span style={{ color: "#2a7", fontWeight: "bold" }}>Start:</span>{" "}
                    <span style={{ color: "#ccc" }}>{ann.startTimeISO.split('T')[1]}</span>
                  </div>
                  <div>
                    <span style={{ color: "#e74", fontWeight: "bold" }}>End:</span>{" "}
                    <span style={{ color: "#ccc" }}>{ann.endTimeISO.split('T')[1]}</span>
                  </div>
                </div>
                <button
                  onClick={() => toggleVisibleInPlot(ann.id)}
                  title="Show this annotation as a shaded region in the Signal Plot"
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

      {pendingConfirm != null && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "3rem",
            zIndex: 100,
          }}
        >
          <div style={{ width: "85%", maxWidth: "420px", padding: "0.8rem 0.9rem", fontSize: "0.85rem", color: "#f2f2f2", backgroundColor: "#2a1e1e", border: "1px solid #822", borderRadius: "6px", boxShadow: "0 4px 16px rgba(0,0,0,0.5)" }}>
            <div style={{ marginBottom: "0.6rem" }}>{pendingConfirm.message}</div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                onClick={() => { pendingConfirm.onConfirm(); setPendingConfirm(null); }}
                style={{ flex: 1, padding: "0.4rem", backgroundColor: "#822", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold", fontSize: "0.8rem" }}
              >
                OK
              </button>
              <button
                onClick={() => setPendingConfirm(null)}
                style={{ flex: 1, padding: "0.4rem", backgroundColor: "#555", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.8rem" }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function initMainPanel (context: PanelExtensionContext): () => void { 
  const root = createRoot(context.panelElement);
  root.render(<MainPanel context={context} />);
  return () => { root.unmount(); };
}
