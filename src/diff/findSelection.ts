// src/diff/findSelection.ts
//
// Turns the current text selection into a value to prefill the ⌘F find box with,
// mirroring editors that seed find from the selection. Returns null to skip the
// prefill. Multi-line selections are rejected because in-code find matches
// per-line (VirtualDiffPane), so a query with a newline would match nothing. (#find)
export function findPrefillFromSelection(selected: string): string | null {
  const trimmed = selected.trim();
  if (!trimmed) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}
