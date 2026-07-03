import { describe, it, expect } from "vitest";
import { isMarkdownPath } from "./isMarkdownPath";

describe("isMarkdownPath", () => {
  it("matches .md and .markdown (any case)", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/guide.markdown")).toBe(true);
    expect(isMarkdownPath("CHANGELOG.MD")).toBe(true);
  });

  it("rejects .mdx, other extensions, and extensionless files", () => {
    expect(isMarkdownPath("component.mdx")).toBe(false);
    expect(isMarkdownPath("src/index.ts")).toBe(false);
    expect(isMarkdownPath("notes.txt")).toBe(false);
    expect(isMarkdownPath("README")).toBe(false);
    expect(isMarkdownPath("dir.md/file.ts")).toBe(false);
  });
});
