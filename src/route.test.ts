import { describe, it, expect } from "vitest";
import { resolveRoute } from "./route";

describe("resolveRoute", () => {
  it("routes the picker label to the picker", () => {
    expect(resolveRoute("picker", "")).toEqual({ kind: "picker" });
  });

  it("routes a review label + params to a review target", () => {
    const r = resolveRoute("review-0123456789abcdef", "?repo=%2Fr%2Fp&mode=uncommitted&base=main");
    expect(r).toEqual({ kind: "review", target: { repoPath: "/r/p", mode: "uncommitted", base: "main" } });
  });

  it("supports a mock ?view=review override with no Tauri label", () => {
    const r = resolveRoute(null, "?view=review&repo=%2Fr&mode=all-changes");
    expect(r).toEqual({ kind: "review", target: { repoPath: "/r", mode: "all-changes", base: undefined } });
  });

  it("falls back to all-changes for an unknown mode", () => {
    const r = resolveRoute("review-x", "?repo=%2Fr&mode=bogus");
    expect(r.kind).toBe("review");
    if (r.kind === "review") expect(r.target.mode).toBe("all-changes");
  });

  it("defaults to picker with no label and no params", () => {
    expect(resolveRoute(null, "")).toEqual({ kind: "picker" });
  });
});
