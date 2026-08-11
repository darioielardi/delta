// Is a split row's side a changed line? (#split-changed)
//
// @git-diff-view pairs a change block's deletions with its additions row by row,
// so a split row can carry a line number on BOTH sides and still be a delete/add
// pair rather than context. The only reliable signal is the model line's diff
// *type*.
//
// It is NOT the presence of `diff.changes` (the word-level intra-line range):
// core's `getDiffRange` computes that only when a change block has exactly as
// many additions as deletions, and bails out otherwise. Keying "changed" off it
// therefore rendered the paired rows of every unbalanced block (one line replaced
// by eight, say) as plain context — no red/green tint, no accent — while the
// unpaired remainder below them highlighted fine. Unified was never affected: it
// derives add/del/ctx from line-number presence alone.
import { checkDiffLineIncludeChange } from "@git-diff-view/file";
import type { SplitLineItem } from "@git-diff-view/react";

export const splitSideChanged = (line: SplitLineItem | undefined): boolean =>
  line?.lineNumber != null && checkDiffLineIncludeChange(line.diff);

// A split row is changed if either side is (a delete, an add, or a paired both).
export const splitRowChanged = (left: SplitLineItem | undefined, right: SplitLineItem | undefined): boolean =>
  splitSideChanged(left) || splitSideChanged(right);
