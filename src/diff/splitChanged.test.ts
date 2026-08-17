// Regression: split view left changed rows untinted whenever a change block
// replaced N lines with M != N lines. @git-diff-view only fills in the
// word-level `diff.changes` range for balanced blocks, and the old predicate
// read "changed" off that range — so the paired delete/add row at the top of an
// unbalanced block reported itself as context on both sides. (#split-changed)
import { describe, it, expect } from "vitest";
import { toDiffFile } from "./toDiffFile";
import { splitRowChanged, splitSideChanged } from "./splitChanged";

// Rows of a built split model as `[oldChanged, newChanged]` per row, so a case
// reads as the tint the two columns should paint.
function splitFlags(oldContent: string, newContent: string) {
  const f = toDiffFile({ status: "modified", binary: false, oldFileName: "a.ts", newFileName: "a.ts", oldContent, newContent });
  f.buildSplitDiffLines();
  const rows: [boolean, boolean][] = [];
  for (let i = 0; i < f.splitLineLength; i++) {
    rows.push([splitSideChanged(f.getSplitLeftLine(i)), splitSideChanged(f.getSplitRightLine(i))]);
  }
  return rows;
}

describe("splitSideChanged", () => {
  it("tints both sides of the paired row when one line is replaced by many", () => {
    // 1 deletion vs 4 additions — unbalanced, so core computes no intra-line
    // range at all, and the model pairs the deletion with the first addition.
    const rows = splitFlags(
      "ctx\nexport function f(a: A) {\nbody\n",
      "ctx\n/** doc */\nexport function f(\n  a: A,\n): R {\nbody\n",
    );
    expect(rows).toEqual([
      [false, false], // ctx
      [true, true],   // del `export function f(a: A) {` paired with add `/** doc */`
      [false, true],  // add
      [false, true],  // add
      [false, true],  // add
      [false, false], // body
    ]);
  });

  it("tints both sides of a balanced one-for-one modification", () => {
    expect(splitFlags("ctx\nold\nbody\n", "ctx\nnew\nbody\n")).toEqual([
      [false, false],
      [true, true],
      [false, false],
    ]);
  });

  it("tints only the side that has a line for pure adds and pure deletes", () => {
    expect(splitFlags("ctx\nbody\n", "ctx\nadded\nbody\n")).toEqual([
      [false, false],
      [false, true],
      [false, false],
    ]);
    expect(splitFlags("ctx\ngone\nbody\n", "ctx\nbody\n")).toEqual([
      [false, false],
      [true, false],
      [false, false],
    ]);
  });

  it("leaves an unchanged file with no changed rows", () => {
    expect(splitFlags("a\nb\nc\n", "a\nb\nc\n").some(([l, r]) => l || r)).toBe(false);
  });
});

describe("splitRowChanged", () => {
  it("is true when either side changed", () => {
    expect(splitRowChanged(undefined, undefined)).toBe(false);
    expect(splitRowChanged({}, {})).toBe(false);
  });
});
