import { useSyncExternalStore } from "react";

// Preferred external editor for the "open in editor" actions (#editor). Curated
// list — each maps to a CLI the Rust side launches (jumping to a line where the
// editor's CLI supports it). Persisted in localStorage like the theme.
export type EditorId = "vscode" | "cursor" | "zed" | "sublime" | "intellij";

export const EDITORS: { id: EditorId; label: string }[] = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "sublime", label: "Sublime Text" },
  { id: "intellij", label: "IntelliJ IDEA" },
];

const STORAGE_KEY = "delta.editor";
const DEFAULT: EditorId = "vscode";
const isEditorId = (v: unknown): v is EditorId => EDITORS.some((e) => e.id === v);

function readPref(): EditorId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isEditorId(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

// Module-level store so every consumer stays in sync; the `storage` listener
// propagates a change made in one window to the others (shared origin).
let pref: EditorId = typeof window !== "undefined" ? readPref() : DEFAULT;
const listeners = new Set<() => void>();

export function getEditorPref(): EditorId {
  return pref;
}

export function setEditorPref(next: EditorId): void {
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
    pref = isEditorId(e.newValue) ? e.newValue : DEFAULT;
    listeners.forEach((l) => l());
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useEditorPref(): [EditorId, (e: EditorId) => void] {
  const p = useSyncExternalStore(subscribe, getEditorPref, () => DEFAULT);
  return [p, setEditorPref];
}

export function editorLabel(id: EditorId): string {
  return EDITORS.find((e) => e.id === id)?.label ?? id;
}
