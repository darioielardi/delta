import { describe, it, expect } from "vitest";
import { wrapsByDefault, paneColsFor, visualLinesForCols, buildRowOffsets } from "./wrap";

describe("wrapsByDefault", () => {
  it("wraps prose/text extensions, case-insensitively", () => {
    for (const p of ["README.md", "a/b/notes.MARKDOWN", "x.mdx", "log.txt", "a.text", "doc.rst", "page.adoc"]) {
      expect(wrapsByDefault(p)).toBe(true);
    }
  });
  it("does not wrap code/structured/data or extensionless files", () => {
    for (const p of ["src/App.tsx", "main.rs", "data.json", "conf.yaml", "pic.svg", "Makefile", ".gitignore", "noext"]) {
      expect(wrapsByDefault(p)).toBe(false);
    }
  });
});

describe("paneColsFor", () => {
  it("floors width/chPx, clamped to >=1 when both positive", () => {
    expect(paneColsFor(800, 8)).toBe(100);
    expect(paneColsFor(5, 8)).toBe(1); // floor 0 -> clamp 1
  });
  it("returns 0 for unknown/invalid width or chPx", () => {
    expect(paneColsFor(0, 8)).toBe(0);
    expect(paneColsFor(-10, 8)).toBe(0);
    expect(paneColsFor(800, 0)).toBe(0);
  });
});

describe("visualLinesForCols", () => {
  it("is 1 when the line fits or width is unknown", () => {
    expect(visualLinesForCols(0, 80)).toBe(1);
    expect(visualLinesForCols(80, 80)).toBe(1);
    expect(visualLinesForCols(200, 0)).toBe(1); // unknown paneCols
  });
  it("ceils cols/paneCols when the line overflows", () => {
    expect(visualLinesForCols(81, 80)).toBe(2);
    expect(visualLinesForCols(160, 80)).toBe(2);
    expect(visualLinesForCols(161, 80)).toBe(3);
  });
});

describe("buildRowOffsets", () => {
  it("returns cumulative tops plus a final total", () => {
    expect(buildRowOffsets([1, 1, 1], 22)).toEqual([0, 22, 44, 66]);
    expect(buildRowOffsets([2, 1, 3], 10)).toEqual([0, 20, 30, 60]);
  });
  it("handles the empty case", () => {
    expect(buildRowOffsets([], 22)).toEqual([0]);
  });
});
