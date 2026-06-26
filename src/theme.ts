import { useEffect, useState, useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "delta.theme";
const mql = () => window.matchMedia("(prefers-color-scheme: dark)");

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

// Module-level store: every hook consumer in a window stays in sync, and the
// `storage` listener below propagates a change made in one window to the others
// (Tauri webviews share one origin/localStorage).
let pref: ThemePref = typeof window !== "undefined" ? readPref() : "system";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getThemePref(): ThemePref {
  return pref;
}

export function setThemePref(next: ThemePref): void {
  if (next === pref) return;
  pref = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const v = e.newValue;
    pref = v === "light" || v === "dark" || v === "system" ? v : "system";
    emit();
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const p = useSyncExternalStore(subscribe, getThemePref, () => "system" as ThemePref);
  return [p, setThemePref];
}

const resolve = (p: ThemePref, systemDark: boolean): "light" | "dark" =>
  p === "system" ? (systemDark ? "dark" : "light") : p;

/** Resolved light/dark, reacting to OS changes while the preference is "system". */
export function useResolvedTheme(): "light" | "dark" {
  const [p] = useThemePref();
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== "undefined" ? mql().matches : false,
  );
  useEffect(() => {
    const m = mql();
    const on = () => setSystemDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return resolve(p, systemDark);
}

/** Apply the resolved theme's `.dark` class to <html>. Call once at the app root
 *  so every window (home + review) honors the preference. Returns the resolved
 *  theme for convenience. */
export function useApplyTheme(): "light" | "dark" {
  const resolved = useResolvedTheme();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);
  return resolved;
}
