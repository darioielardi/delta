import { describe, it, expect } from "vitest";
import { findPrefillFromSelection } from "./findSelection";

describe("findPrefillFromSelection", () => {
  it("returns a single-line selection", () => {
    expect(findPrefillFromSelection("getUserName")).toBe("getUserName");
  });

  it("trims surrounding whitespace", () => {
    expect(findPrefillFromSelection("  getUserName  ")).toBe("getUserName");
  });

  it("keeps a trailing newline out of the query (whole-line selection)", () => {
    expect(findPrefillFromSelection("getUserName\n")).toBe("getUserName");
  });

  it("returns null for an empty selection", () => {
    expect(findPrefillFromSelection("")).toBeNull();
  });

  it("returns null for a whitespace-only selection", () => {
    expect(findPrefillFromSelection("   ")).toBeNull();
  });

  it("returns null for a multi-line selection (per-line matching can't match it)", () => {
    expect(findPrefillFromSelection("const a = 1\nconst b = 2")).toBeNull();
  });
});
