import { useEffect, useSyncExternalStore } from "react";

// Code font preferences for the diff/code surfaces, persisted in localStorage like
// the theme/editor prefs. `family` "" means the app's default mono stack;
// otherwise it's a concrete installed family we prepend to that stack. `size`
// drives the diff row geometry (line height is derived to keep the comfortable
// ratio that makes the default 13px render at the long-standing 22px row).

const FAMILY_KEY = "delta.codeFont";
const SIZE_KEY = "delta.codeFontSize";

export const DEFAULT_SIZE = 13;
export const SIZE_OPTIONS = [11, 12, 13, 14, 15, 16, 17, 18];
const MIN_SIZE = SIZE_OPTIONS[0];
const MAX_SIZE = SIZE_OPTIONS[SIZE_OPTIONS.length - 1];

// Mirrors index.css `--font-mono`. A chosen family is prepended to this stack so
// it degrades gracefully if the font is ever uninstalled.
const DEFAULT_MONO_STACK = `ui-monospace, "SF Mono", Menlo, monospace`;

/** The CSS `font-family` value for a chosen family ("" → the default stack). */
export function fontStack(family: string): string {
  return family ? `"${family}", ${DEFAULT_MONO_STACK}` : DEFAULT_MONO_STACK;
}

/** Code line height for a font size — keeps the ratio that maps 13px → 22px (the
 *  long-standing ROW_H), rounded to a whole pixel so row geometry stays exact. */
export function rowHeightFor(size: number): number {
  return Math.round((size * 22) / 13);
}

type CodeFont = { family: string; size: number };

function clampSize(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n))) : DEFAULT_SIZE;
}

function read(): CodeFont {
  let family = "";
  let size = DEFAULT_SIZE;
  try {
    family = localStorage.getItem(FAMILY_KEY) ?? "";
    const s = localStorage.getItem(SIZE_KEY);
    if (s != null) size = clampSize(Number(s));
  } catch {
    /* ignore */
  }
  return { family, size };
}

// Module-level store: every consumer in a window stays in sync, and the `storage`
// listener propagates a change made in one window to the others (shared origin).
let state: CodeFont = typeof window !== "undefined" ? read() : { family: "", size: DEFAULT_SIZE };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getCodeFont(): CodeFont {
  return state;
}

export function setCodeFontFamily(family: string): void {
  if (family === state.family) return;
  state = { ...state, family };
  try {
    localStorage.setItem(FAMILY_KEY, family);
  } catch {
    /* ignore */
  }
  emit();
}

export function setCodeFontSize(size: number): void {
  const next = clampSize(size);
  if (next === state.size) return;
  state = { ...state, size: next };
  try {
    localStorage.setItem(SIZE_KEY, String(next));
  } catch {
    /* ignore */
  }
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== FAMILY_KEY && e.key !== SIZE_KEY) return;
    state = read();
    emit();
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const SERVER_SNAPSHOT: CodeFont = { family: "", size: DEFAULT_SIZE };
export function useCodeFont(): CodeFont {
  return useSyncExternalStore(subscribe, getCodeFont, () => SERVER_SNAPSHOT);
}

/** Apply the code font family globally by overriding `--font-mono` (which the diff
 *  CSS forces onto all code), and expose the size as `--code-fs`. Call once at the
 *  app root so both windows honor it. */
export function useApplyCodeFont(): void {
  const { family, size } = useCodeFont();
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-mono", fontStack(family));
    root.style.setProperty("--code-fs", `${size}px`);
  }, [family, size]);
}

// Monospace families we know how to offer. WKWebView has no Local Font Access API
// (queryLocalFonts is Chromium-only), so we can't enumerate the OS font list —
// instead we probe this curated set by glyph metrics and surface only the ones
// actually installed on the user's machine.
const MONO_CANDIDATES = [
  "SF Mono", "Menlo", "Monaco", "Andale Mono", "Courier New",
  "JetBrains Mono", "Fira Code", "Fira Mono", "Cascadia Code", "Cascadia Mono",
  "Source Code Pro", "IBM Plex Mono", "Hack", "Inconsolata", "Roboto Mono",
  "Ubuntu Mono", "Geist Mono", "Iosevka", "Victor Mono", "Space Mono",
  "DejaVu Sans Mono", "Liberation Mono", "PT Mono", "Anonymous Pro",
  "Operator Mono", "MonoLisa", "Comic Mono",
];

let detected: string[] | null = null;

/** Installed monospace families from the curated candidate set (memoized — the
 *  set can't change within a session). "System Mono" (the default) is always the
 *  first option; these are the concrete families to list after it. */
export function installedMonoFonts(): string[] {
  if (detected) return detected;
  detected = detectFonts(MONO_CANDIDATES).sort((a, b) => a.localeCompare(b));
  return detected;
}

// Width-comparison font detection: a candidate is installed if rendering a probe
// string in `"<candidate>", <generic>` measures differently from the generic
// alone for at least one generic baseline (i.e. the candidate, not the fallback,
// did the rendering). Works in any engine, no permissions.
function detectFonts(candidates: string[]): string[] {
  if (typeof document === "undefined") return [];
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return [];
  const PROBE = "ABCxyz0123ilmW{}()=>;";
  const bases = ["monospace", "serif", "sans-serif"];
  const measure = (family: string) => {
    ctx.font = `72px ${family}`;
    return ctx.measureText(PROBE).width;
  };
  const baseW = bases.map(measure);
  return candidates.filter((f) => bases.some((b, i) => measure(`"${f}", ${b}`) !== baseW[i]));
}
