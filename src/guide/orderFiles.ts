// src/guide/orderFiles.ts
//
// Order a diff's files to follow the walkthrough's reading sequence — each group's
// files in group order, then anything unplaced, then ignored (noise) last — so
// scrolling the diff advances through the guide's steps. Natural order until the
// walkthrough arrives. Shared by the standalone Guide window and the in-place
// walkthrough mode in the review workspace.
import type { FileEntry, Walkthrough } from "../types";

export function orderFilesForDiff(all: FileEntry[], walkthrough: Walkthrough | null): FileEntry[] {
  if (!walkthrough) return all;
  const byPath = new Map(all.map((f) => [f.path, f]));
  const seen = new Set<string>();
  const out: FileEntry[] = [];
  for (const g of [...walkthrough.groups].sort((a, b) => a.order - b.order)) {
    for (const wf of g.files) {
      const e = byPath.get(wf.path);
      if (e && !seen.has(wf.path)) { seen.add(wf.path); out.push(e); }
    }
  }
  const ignored = new Set(walkthrough.ignored.map((i) => i.path));
  for (const f of all) if (!seen.has(f.path) && !ignored.has(f.path)) { seen.add(f.path); out.push(f); }
  for (const f of all) if (!seen.has(f.path)) { out.push(f); }
  return out;
}
