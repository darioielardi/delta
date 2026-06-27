import { useSyncExternalStore } from "react";

// Which diff renderer to use. "classic" is the @git-diff-view-based DiffPane;
// "virtual" is the experimental row-virtualized VirtualDiffPane (unified-only for
// now). Lets the renderer be A/B'd in the real app, where there's no URL bar.
export type DiffRenderer = "classic" | "virtual";

const KEY = "delta:diffRenderer";

function read(): DiffRenderer {
  try {
    // A `?renderer=` URL param wins as an explicit override (handy for a quick
    // browser A/B); otherwise the persisted preference, else classic.
    const url = new URLSearchParams(location.search).get("renderer");
    if (url === "virtual" || url === "classic") return url;
    const v = localStorage.getItem(KEY);
    if (v === "virtual" || v === "classic") return v;
  } catch {
    /* no window / storage */
  }
  return "classic";
}

// Module-level store (mirrors theme.ts): every consumer in a window stays in sync
// via useSyncExternalStore, and the `storage` listener propagates changes across
// the app's webviews (shared origin/localStorage).
let current: DiffRenderer = typeof window !== "undefined" ? read() : "classic";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setDiffRenderer(next: DiffRenderer): void {
  if (next === current) return;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    current = read();
    emit();
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useDiffRenderer(): [DiffRenderer, (r: DiffRenderer) => void] {
  const r = useSyncExternalStore(subscribe, () => current, () => "classic" as DiffRenderer);
  return [r, setDiffRenderer];
}
