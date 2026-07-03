import { useSyncExternalStore } from "react";
import { trackEvent } from "@aptabase/tauri";
import { api } from "./api";

// The fixed event taxonomy. Feature names + bucketed/numeric props only — never
// content (no repo names, paths, branches, diff or comment text). (#analytics)
export type EventName =
  | "app_started"
  | "review_opened"
  | "copy_for_agents"
  | "comment_added"
  | "comment_resolved"
  | "diff_layout_changed"
  | "find_used"
  | "cli_installed"
  | "update_applied";

type Props = Record<string, string | number | boolean>;

// --- Are we in a real Tauri webview? (not dev:mock, not Vitest/happy-dom) ---
function isTauri(): boolean {
  return (
    !import.meta.env.VITE_MOCK_IPC &&
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

// --- Build/env permission, resolved once from the backend and cached. ---
let envAllowed = false;
let inited = false;

/** Resolve whether build+env permit telemetry. Idempotent; call once at startup. */
export async function initAnalytics(): Promise<void> {
  if (inited || !isTauri()) return;
  inited = true;
  try {
    envAllowed = await api.telemetryAllowed();
  } catch {
    envAllowed = false;
  }
}

/** Test seam: set the cached build/env permission directly. */
export function __setEnvAllowedForTest(v: boolean): void {
  envAllowed = v;
}

// --- User preference: localStorage-backed, cross-window synced (mirrors theme.ts). ---
export type TelemetryPref = "on" | "off";
const STORAGE_KEY = "delta.telemetry";

function readPref(): TelemetryPref {
  try {
    return localStorage.getItem(STORAGE_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

let pref: TelemetryPref = typeof window !== "undefined" ? readPref() : "on";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getTelemetryPref(): TelemetryPref {
  return pref;
}

export function setTelemetryPref(next: TelemetryPref): void {
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
    pref = e.newValue === "off" ? "off" : "on";
    emit();
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useTelemetryPref(): [TelemetryPref, (p: TelemetryPref) => void] {
  const p = useSyncExternalStore(subscribe, getTelemetryPref, () => "on" as TelemetryPref);
  return [p, setTelemetryPref];
}

// --- The one gate + the fire-and-forget tracker. ---
export function shouldTrack(): boolean {
  return isTauri() && envAllowed && pref !== "off";
}

export function track(event: EventName, props?: Props): void {
  if (!shouldTrack()) return;
  try {
    // Aptabase's trackEvent Props type only accepts string | number. Our public
    // Props type intentionally also allows boolean, for callers' convenience and
    // forward-compatibility, so stringify booleans here at the call boundary
    // before handing off to the SDK. (#analytics)
    const aptabaseProps = props
      ? Object.fromEntries(
          Object.entries(props).map(([k, v]) => [k, typeof v === "boolean" ? String(v) : v]),
        )
      : undefined;
    void trackEvent(event, aptabaseProps);
  } catch {
    /* analytics must never break the app */
  }
}
