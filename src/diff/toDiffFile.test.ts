import { describe, it, expect } from "vitest";
import { toDiffFile } from "./toDiffFile";
import type { FileDiff } from "../types";

const fd: FileDiff = {
  oldFileName: "a.ts", oldContent: "const x = 1\n",
  newFileName: "a.ts", newContent: "const x = 2\n",
  status: "modified", binary: false,
};

describe("toDiffFile", () => {
  it("builds a DiffFile with split lines initialized", () => {
    const file = toDiffFile(fd);
    file.buildSplitDiffLines();
    expect(file.splitLineLength).toBeGreaterThan(0);
  });
});
