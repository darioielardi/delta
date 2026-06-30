// Picker data source + a tiny stale-while-revalidate cache. Reopening the picker
// (⌘K → close → ⌘K) renders the cached result instantly while a fresh fetch
// updates in the background; the fetch does live git worktree enumeration, which is
// the slow part of opening. prefetchPicker() warms it on a review window's mount so
// even the first open feels instant.
import { api } from "../api";
import type { PickerData } from "../types";

let cache: PickerData | null = null;

/** The current cached picker data, if any — used for an instant first paint. */
export function peekPickerCache(): PickerData | null {
  return cache;
}

/** Fetch picker data and refresh the cache. */
export async function loadPicker(): Promise<PickerData> {
  cache = await api.listPicker();
  return cache;
}

/** Warm the cache ahead of the first ⌘K. Fire-and-forget. */
export function prefetchPicker(): void {
  void loadPicker().catch(() => {});
}

/** Test-only: clear the module cache so each test starts cold. */
export function __resetPickerCacheForTest(): void {
  cache = null;
}
