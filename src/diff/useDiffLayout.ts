import { useCallback, useEffect, useState } from "react";
import { track } from "@/analytics";

export type DiffLayout = "unified" | "split";

const KEY = "delta:diffLayout";

function read(): DiffLayout {
  return localStorage.getItem(KEY) === "split" ? "split" : "unified";
}

// Global split/unified preference, shared across all windows of the same origin
// (localStorage is shared) and kept live via the cross-document `storage` event.
export function useDiffLayout(): [DiffLayout, (l: DiffLayout) => void] {
  const [layout, setLayoutState] = useState<DiffLayout>(read);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setLayoutState(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLayout = useCallback((l: DiffLayout) => {
    localStorage.setItem(KEY, l);
    setLayoutState(l);
    track("diff_layout_changed", { layout: l });
  }, []);

  return [layout, setLayout];
}
