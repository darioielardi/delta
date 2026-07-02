import { describe, it, expect } from "vitest";
import { langFromFilename } from "./lang";

describe("langFromFilename", () => {
  it("returns the lowercased extension of a normal file", () => {
    expect(langFromFilename("src/app/Foo.TSX")).toBe("tsx");
  });

  it("uses only the basename, ignoring dots in the directory path", () => {
    expect(langFromFilename("a.b.c/module.rs")).toBe("rs");
  });

  it("falls back to the basename for extension-less files (Dockerfile, Makefile)", () => {
    expect(langFromFilename("build/Dockerfile")).toBe("dockerfile");
    expect(langFromFilename("Makefile")).toBe("makefile");
  });

  it("returns an empty string when there is no name", () => {
    expect(langFromFilename(null)).toBe("");
    expect(langFromFilename(undefined)).toBe("");
    expect(langFromFilename("")).toBe("");
  });
});
