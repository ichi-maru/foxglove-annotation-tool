import { PanelExtensionContext } from "@foxglove/extension";
import { ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ─── SHARED HELPERS (duplicated from MainPanel.tsx / SignalPlotPanel.tsx on
//     purpose, so each panel file stays self-contained. Pull these into a
//     shared utils.ts if the duplication starts to bother you.) ───────────
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

// ─── DATA MODEL ────────────────────────────────────────────────────────────
// Shape read back from the "allAnnotations" global variable, published by
// the Main Panel — every saved annotation, unfiltered (unlike
// "savedAnnotations", which only carries the "Show in plot" opt-in subset
// for Signal Plot). This panel gives each annotation its own permanent lane
// specifically so it doesn't need that same anti-clutter filter.
// `color` is optional at the type level so a stale Main Panel build (from
// before the color field existed, or a shadowed old extension install —
// see the install-hygiene note in the project handoff) doesn't get its
// entries dropped outright — see isSavedAnnotation below.
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

const DEFAULT_COLOR = "#888888";

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
function GlobalAnnotationTimelinePanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const [recStart, setRecStart] = useState<number | undefined>();
  const [recEnd, setRecEnd] = useState<number | undefined>();
  const [currentTime, setCurrentTime] = useState<number | undefined>();

  const [annotations, setAnnotations] = useState<SavedAnnotation[]>([]);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  // ── FOXGLOVE SETUP ──
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.startTime != undefined) setRecStart(timeToNanos(renderState.startTime));
      if (renderState.endTime != undefined) setRecEnd(timeToNanos(renderState.endTime));
      if (renderState.currentTime != undefined) setCurrentTime(timeToNanos(renderState.currentTime));

      if (renderState.variables != undefined) {
        const raw = renderState.variables.get("allAnnotations");
        setAnnotations(Array.isArray(raw) ? raw.filter(isSavedAnnotation) : []);
      }
    };

    context.watch("startTime");
    context.watch("endTime");
    context.watch("currentTime");
    context.watch("variables");
    context.subscribe([]); // no topic data needed — purely driven by global variables + playback state
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

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

  // ── LANES ──
  // Fixed insertion order: lane index is simply the annotation's position in
  // the published array, which mirrors Main Panel's Saved Annotations list
  // order (including drag-to-reorder there — this panel needs no write-back
  // to support that, it just re-renders whatever order it's given). Two
  // annotations that share an event name (e.g. the same defect seen on two
  // topics) still land in separate lanes even when their time ranges
  // overlap — that's the whole reason for lanes instead of a shared row.
  const lanes = useMemo(
    () => annotations.map((a, index) => ({ ...a, lane: index, color: a.color ?? DEFAULT_COLOR })),
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

  // ── CLICK-TO-SEEK / DRAG-TO-SCRUB / HOVER-PREVIEW ──
  // Same feature-detected pattern as the other two panels: seekPlayback may
  // not be available (e.g. live connections), setPreviewTime always is.
  // Hover-lane detection (for the tooltip) is computed from the SAME x/y as
  // the seek logic below, in one place — not via per-element mouseenter /
  // mouseleave listeners split across an SVG rect and a <foreignObject>'s
  // embedded HTML label. That split is what caused the tooltip flicker in
  // the mockup: crossing the SVG/foreignObject boundary is a known soft
  // spot for browser hit-testing, so the pointer briefly reads as "outside"
  // during the handoff. Computing "what's under the cursor" from raw
  // coordinates sidesteps the issue entirely.
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
  // the top/bottom edges).
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
  return (
    <div ref={panelRef} style={{ padding: "1rem", fontFamily: "sans-serif", height: "100%", boxSizing: "border-box", overflowY: "auto", display: "flex", flexDirection: "column", position: "relative" }}>
      <h2 style={{ marginBottom: "0.25rem" }}>Global Annotation Timeline</h2>
      <div style={{ fontSize: "0.78rem", color: "#888", marginBottom: "1rem" }}>
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
              below has a minWidth floor so its text can never be scaled
              down past legibility (the "blurred when shrunk" bug) — when
              the panel is narrower than that floor, this wrapper scrolls
              sideways instead of squeezing the SVG. */}
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
                // width — below that, text drawn at a fixed viewBox font
                // size (e.g. the lane labels' fontSize:"10px") starts
                // rendering smaller than its authored size and gets
                // blurry, since the whole SVG scales down with it.
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

      {/* Hover tooltip — rendered here, as a direct child of the whole
          panel (not nested inside the scrollable lane box above), and
          positioned from the cursor's position within the panel rather
          than the lane's time-position. That's what lets it render
          outside the lane box's own overflow-y:auto clipping. */}
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

export function initGlobalAnnotationTimelinePanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<GlobalAnnotationTimelinePanel context={context} />);
  return () => {
    root.unmount();
  };
}
