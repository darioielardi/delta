import { useCallback, useEffect, useRef, useState } from "react";

export interface PaneConfig {
  key: string; // localStorage key
  min: number;
  max: number;
  def: number; // default width; both panes match the old fixed w-80 (320px)
}

// Mins are set just past where each pane's header stops laying out cleanly: the
// file panel's header (viewed badge + ± counts + view toggles) needs ~262px, the
// comments header far less but its cards want room to stay readable.
export const FILE_PANE: PaneConfig = { key: "delta:sidebarWidth", min: 280, max: 520, def: 320 };
export const COMMENTS_PANE: PaneConfig = { key: "delta:commentsWidth", min: 240, max: 520, def: 320 };

const clamp = (cfg: PaneConfig, w: number) => Math.min(cfg.max, Math.max(cfg.min, Math.round(w)));

function read(cfg: PaneConfig): number {
  const raw = Number(localStorage.getItem(cfg.key));
  return Number.isFinite(raw) && raw > 0 ? clamp(cfg, raw) : cfg.def;
}

// Persisted, cross-window-synced pane width (mirrors useDiffLayout). `persist` is
// passed false during a live drag so we don't thrash localStorage / wake other
// windows on every pointer move — the final width is committed once on release.
export function useResizableWidth(cfg: PaneConfig): [number, (w: number, persist?: boolean) => void] {
  const [width, setWidthState] = useState<number>(() => read(cfg));

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === cfg.key) setWidthState(read(cfg));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [cfg]);

  const setWidth = useCallback((w: number, persist = true) => {
    const next = clamp(cfg, w);
    if (persist) localStorage.setItem(cfg.key, String(next));
    setWidthState(next);
  }, [cfg]);

  return [width, setWidth];
}

// Drag-to-resize gesture for one pane edge. `edge` is the side the handle sits on:
// "right" → pane grows as the pointer moves right (left/file pane); "left" → pane
// grows as the pointer moves left (right/comments pane). Returns the active flag
// (drives the divider styling + suppressing the open/close transition) plus props
// to spread onto the separator element.
export function usePaneResize(
  cfg: PaneConfig,
  width: number,
  setWidth: (w: number, persist?: boolean) => void,
  edge: "left" | "right",
) {
  const [resizing, setResizing] = useState(false);
  const gesture = useRef<{ startX: number; startW: number } | null>(null);
  const liveWidth = useRef(width);
  const dir = edge === "right" ? 1 : -1;

  // While dragging, force a col-resize cursor everywhere and suppress text
  // selection — pointer capture keeps move/up on the handle as the cursor sweeps
  // over the diff. Restored (incl. on unmount) by the cleanup.
  useEffect(() => {
    if (!resizing) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [resizing]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); // don't start a text selection
    gesture.current = { startX: e.clientX, startW: width };
    liveWidth.current = width;
    // Capture keeps move/up on the handle as the cursor leaves the thin grab zone;
    // it can throw if the pointer isn't active, which must not abort the drag.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
    setResizing(true);
  }, [width]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const next = g.startW + dir * (e.clientX - g.startX);
    liveWidth.current = next;
    setWidth(next, false); // live, no persist (avoids localStorage thrash)
  }, [dir, setWidth]);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!gesture.current) return;
    gesture.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setResizing(false);
    setWidth(liveWidth.current, true); // commit the final width
  }, [setWidth]);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    // Arrow toward the grow direction widens; the *dir factor keeps that intuitive
    // on either edge (→ grows the file pane, ← grows the comments pane).
    const step = (e.shiftKey ? 48 : 16) * (e.key === "ArrowRight" ? 1 : -1) * dir;
    setWidth(width + step, true);
  }, [dir, setWidth, width]);

  const separatorProps = {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-valuenow": width,
    "aria-valuemin": cfg.min,
    "aria-valuemax": cfg.max,
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onKeyDown,
  };

  return { resizing, separatorProps };
}

// The draggable divider: a wide, invisible grab zone with a hairline that surfaces
// on hover/focus and, while dragging, deepens to a stronger shade of the same
// neutral (no accent hue). The "right" edge is centered over the boundary; the
// "left" edge sits in the gutter just outside the panel (so it clears a flush
// panel title) and therefore needs a parent that does NOT clip overflow.
export function PaneResizer({
  edge, label, resizing, separatorProps,
}: {
  edge: "left" | "right";
  label: string;
  resizing: boolean;
  separatorProps: ReturnType<typeof usePaneResize>["separatorProps"];
}) {
  const pos = edge === "right"
    ? "right-0 translate-x-1/2 justify-center"
    // Center the hairline in the PAD-width (14px) gutter to the panel's left
    // (~7px off the edge): left-0, then shift the 10px-wide zone left so its
    // center lands at edge − 7. Clears a flush panel title without moving content.
    : "left-0 -translate-x-3 justify-center";
  return (
    <div
      {...separatorProps}
      aria-label={label}
      className={`group/resize absolute inset-y-0 z-10 flex w-2.5 cursor-col-resize touch-none items-stretch focus:outline-none ${pos}`}
    >
      <span
        aria-hidden
        className={`w-px transition-colors ${resizing ? "bg-foreground/30" : "bg-transparent group-hover/resize:bg-border group-focus-visible/resize:bg-border"}`}
      />
    </div>
  );
}
