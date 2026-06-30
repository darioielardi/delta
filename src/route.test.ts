import { describe, it, expect } from "vitest";
import { resolveRoute } from "./route";

describe("resolveRoute", () => {
  it("routes a non-review label to home", () => {
    expect(resolveRoute("home", "")).toEqual({ kind: "home" });
  });

  it("routes a review label + params to a review target", () => {
    const r = resolveRoute("review-0123456789abcdef", "?repo=%2Fr%2Fp&mode=uncommitted&base=main");
    expect(r).toEqual({ kind: "review", target: { repoPath: "/r/p", mode: "uncommitted", base: "main" } });
  });

  it("supports a mock ?view=review override with no Tauri label", () => {
    const r = resolveRoute(null, "?view=review&repo=%2Fr&mode=all-changes");
    expect(r).toEqual({ kind: "review", target: { repoPath: "/r", mode: "all-changes", base: undefined } });
  });

  it("parses the commit oid into the target", () => {
    const r = resolveRoute("review-x", "?view=review&repo=%2Fr&mode=commit&commit=a1b2c3d");
    expect(r).toEqual({ kind: "review", target: { repoPath: "/r", mode: "commit", base: undefined, commit: "a1b2c3d" } });
  });

  it("falls back to all-changes for an unknown mode", () => {
    const r = resolveRoute("review-x", "?repo=%2Fr&mode=bogus");
    expect(r.kind).toBe("review");
    if (r.kind === "review") expect(r.target.mode).toBe("all-changes");
  });

  it("defaults to home with no label and no params", () => {
    expect(resolveRoute(null, "")).toEqual({ kind: "home" });
  });
});
