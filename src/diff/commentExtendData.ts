import type { Comment } from "../types";

export interface ExtendData {
  oldFile: Record<string, { data: Comment[] }>;
  newFile: Record<string, { data: Comment[] }>;
}

/** Group line/range comments by side + startLine for git-diff-view's extendData. */
export function buildExtendData(comments: Comment[]): ExtendData {
  const ext: ExtendData = { oldFile: {}, newFile: {} };
  for (const c of comments) {
    const a = c.anchor;
    if (!a || a.startLine == null) continue; // general / file-scope
    const bucket = a.side === "old" ? ext.oldFile : ext.newFile;
    const key = String(a.startLine);
    (bucket[key] ??= { data: [] }).data.push(c);
  }
  return ext;
}
