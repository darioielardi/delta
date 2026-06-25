import { describe, it, expect } from "vitest";
import { buildExtendData } from "./commentExtendData";
import type { Comment } from "../types";

const c = (id: string, side: "new" | "old", startLine: number): Comment => ({
  id,
  scope: "line",
  anchor: { file: "a.ts", side, startLine, endLine: null, snippet: "x" },
  body: "b",
  stale: false,
  createdAt: "t",
  updatedAt: "t",
});

describe("buildExtendData", () => {
  it("groups comments by side and line number", () => {
    const ext = buildExtendData([c("1", "new", 10), c("2", "new", 10), c("3", "old", 4)]);
    expect(ext.newFile!["10"].data.map((x) => x.id)).toEqual(["1", "2"]);
    expect(ext.oldFile!["4"].data.map((x) => x.id)).toEqual(["3"]);
  });

  it("ignores general comments and anchors without a line", () => {
    const general: Comment = {
      id: "g",
      scope: "general",
      anchor: null,
      body: "b",
      stale: false,
      createdAt: "t",
      updatedAt: "t",
    };
    const ext = buildExtendData([general]);
    expect(ext.newFile).toEqual({});
    expect(ext.oldFile).toEqual({});
  });
});
