import { useSyncExternalStore } from "react";

// How a review opened from the ⌘K command palette behaves: open a NEW window
// (default) or REPLACE the current review window in place. Persisted in
// localStorage like the theme/editor prefs. Only the in-review palette honors it —
// the launcher always opens a new review window (it has no review to replace).
export type PickerOpenMode = "new-window" | "replace";

const STORAGE_KEY = "delta.pickerOpenMode";
const DEFAULT: PickerOpenMode = "new-window";
const isMode = (v: unknown): v is PickerOpenMode => v === "new-window" || v === "replace";

function readPref(): PickerOpenMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isMode(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

// Module-level store so every consumer stays in sync; the `storage` listener
// propagates a change made in one window to the others (shared origin).
let pref: PickerOpenMode = typeof window !== "undefined" ? readPref() : DEFAULT;
const listeners = new Set<() => void>();

export function getPickerOpenMode(): PickerOpenMode {
  return pref;
}

export function setPickerOpenMode(next: PickerOpenMode): void {
  if (next === pref) return;
  pref = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    pref = isMode(e.newValue) ? e.newValue : DEFAULT;
    listeners.forEach((l) => l());
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function usePickerOpenMode(): [PickerOpenMode, (m: PickerOpenMode) => void] {
  const m = useSyncExternalStore(subscribe, getPickerOpenMode, () => DEFAULT);
  return [m, setPickerOpenMode];
}
