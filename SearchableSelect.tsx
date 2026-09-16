// SearchableSelect.tsx
import { ReactElement, useEffect, useRef, useState } from "react";

// ─── DATA MODEL ────────────────────────────────────────────────────────────
// `name` is both the display label and the committed value; `meta` is an
// optional secondary label (e.g. a topic's schema name) — shown alongside
// the name AND matched against when filtering, so typing "Imu" finds
// "/imu/data" whether the match is in the name or the schema string.
export type SearchableSelectItem = {
  name: string;
  meta?: string;
};

// "strict"   — value must be one of `items` (topic pickers). Typing alone
//              never commits; only clicking/Enter-ing an existing row does.
// "combobox" — free text is a valid value; `items` are just suggestions,
//              and an extra "Use "<text>"" row appears when nothing matches.
export type SearchableSelectMode = "strict" | "combobox";

type SearchableSelectProps = {
  items: SearchableSelectItem[];
  value: string;
  onChange: (value: string) => void;
  mode: SearchableSelectMode;
  placeholder?: string;
  disabled?: boolean;
};

function filterItems(items: SearchableSelectItem[], query: string): SearchableSelectItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  return items.filter((it) => it.name.toLowerCase().includes(q) || (it.meta ?? "").toLowerCase().includes(q));
}

export function SearchableSelect({ items, value, onChange, mode, placeholder, disabled }: SearchableSelectProps): ReactElement {
  // `query` is what's showing in the input. While the dropdown is open it
  // can diverge from the committed `value` as the user types to filter;
  // they're resynced on commit, on Escape/click-outside (revert), or
  // whenever the controlled `value` changes from outside while closed.
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) setQuery(value);
  }, [value, open]);

  const filtered = filterItems(items, query);
  const exactMatch = filtered.some((it) => it.name.toLowerCase() === query.trim().toLowerCase());
  const showCreateRow = mode === "combobox" && query.trim() !== "" && !exactMatch;

  function commit(next: string) {
    onChange(next);
    setQuery(next);
    setOpen(false);
    setActiveIndex(-1);
  }

  // Click-outside-to-close via a window-level pointerdown listener — the
  // same proven pattern already used for the timeline-handle and
  // row-reorder drag mechanics elsewhere in this codebase, rather than
  // relying on input blur (which races with option clicks below).
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value); // revert unsaved typing, same as Escape
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open, value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const optionCount = filtered.length + (showCreateRow ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(optionCount - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < filtered.length) commit(filtered[activeIndex]!.name);
      else if (activeIndex === filtered.length && showCreateRow) commit(query.trim());
      else if (mode === "combobox" && query.trim() !== "") commit(query.trim());
    } else if (e.key === "Escape") {
      setQuery(value);
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(-1); }}
        onKeyDown={handleKeyDown}
        style={{ width: "100%", padding: "0.4rem", boxSizing: "border-box", backgroundColor: "#222", color: "#eee", border: "1px solid #444", borderRadius: "4px", fontSize: "0.9rem" }}
      />
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0, maxHeight: "220px", overflowY: "auto", backgroundColor: "#1e1e1e", color: "#eee", border: "1px solid #444", borderRadius: "4px", zIndex: 10, boxShadow: "0 4px 12px rgba(0,0,0,0.5)" }}>
          {filtered.length === 0 && (
            <div style={{ padding: "0.5rem 0.6rem", color: "#888", fontSize: "0.8rem", fontStyle: "italic" }}>
              {mode === "strict" ? "No matching topics" : "No existing matches"}
            </div>
          )}
          {filtered.map((it, i) => (
            <div
              key={it.name}
              // onMouseDown (not onClick) + preventDefault so this fires
              // BEFORE the click-outside/blur logic closes the dropdown.
              onMouseDown={(e) => { e.preventDefault(); commit(it.name); }}
              style={{ padding: "0.4rem 0.6rem", cursor: "pointer", fontSize: "0.85rem", display: "flex", justifyContent: "space-between", gap: "0.5rem", backgroundColor: i === activeIndex ? "#2a3a55" : undefined }}
            >
              <span style={{ color: "#eee" }}>{it.name}</span>
              {it.meta && <span style={{ color: "#888", fontSize: "0.75rem", whiteSpace: "nowrap" }}>{it.meta}</span>}
            </div>
          ))}
          {showCreateRow && (
            <div
              onMouseDown={(e) => { e.preventDefault(); commit(query.trim()); }}
              style={{ padding: "0.4rem 0.6rem", cursor: "pointer", fontSize: "0.85rem", color: "#8ab4ff", borderTop: "1px solid #333", backgroundColor: activeIndex === filtered.length ? "#2a3a55" : undefined }}
            >
              Use &quot;{query.trim()}&quot;
            </div>
          )}
        </div>
      )}
    </div>
  );
}