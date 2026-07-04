// Picker data with revalidate-on-focus. Seeds from the shared cache for an instant
// paint, fetches once on mount, then refetches whenever the window regains focus (or
// becomes visible again). The backend enumerates worktrees live on every list_picker
// call, but a long-lived picker — the Home launcher, or a re-shown webview — only
// ever asked once, so worktrees created after it mounted never appeared. Returning to
// the window is the "it should refresh" trigger. (#refresh)
import { useEffect, useState } from "react";
import { loadPicker, peekPickerCache } from "./pickerData";
import type { PickerData } from "../types";

export function usePickerData(): PickerData | null {
  const [data, setData] = useState<PickerData | null>(() => peekPickerCache());
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const revalidate = () => {
      // Foregrounding fires focus AND visibilitychange together — coalesce into one fetch.
      if (inFlight) return;
      inFlight = true;
      void loadPicker()
        .then((d) => !cancelled && setData(d))
        // Never hang on the "Loading…" state if the first fetch errors with no cache.
        .catch(() => !cancelled && setData((d) => d ?? { recents: [], worktrees: [] }))
        .finally(() => (inFlight = false));
    };
    revalidate();
    const onFocus = () => revalidate();
    const onVisible = () => document.visibilityState === "visible" && revalidate();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return data;
}
