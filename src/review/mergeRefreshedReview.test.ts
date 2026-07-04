import { describe, it, expect } from "vitest";
import { mergeRefreshedReview } from "./mergeRefreshedReview";
import type { Comment, Review } from "../types";

const note = (id: string, body: string, stale = false): Comment => ({
  id,
  scope: "general",
  anchor: null,
  body,
  stale,
  resolved: false,
  createdAt: "t",
  updatedAt: "t",
});

const review = (comments: Comment[], extra: Partial<Review> = {}): Review => ({
  version: 1,
  id: "x",
  target: { repoPath: "/r", worktree: "main", mode: "all-changes" },
  snapshot: { baseOid: "b", headOid: null, capturedAt: "t" },
  comments,
  viewed: [],
  createdAt: "t",
  lastOpenedAt: "t",
  ...extra,
});

describe("mergeRefreshedReview", () => {
  it("keeps a comment added since the refresh session was computed", () => {
    const prev = review([note("c1", "first"), note("c2", "added since")]);
    const incoming = review([note("c1", "first")]); // refresh never saw c2
    const merged = mergeRefreshedReview(prev, incoming);
    expect(merged.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("does not resurrect a comment deleted since the refresh session was computed", () => {
    const prev = review([note("c1", "first")]); // c2 deleted locally
    const incoming = review([note("c1", "first"), note("c2", "stale")]);
    const merged = mergeRefreshedReview(prev, incoming);
    expect(merged.comments.map((c) => c.id)).toEqual(["c1"]);
  });

  it("overlays re-anchored staleness from the refresh but keeps the live body", () => {
    const prev = review([note("c1", "edited body")]);
    const incoming = review([note("c1", "old body", true)]); // reconcile marked it stale
    const merged = mergeRefreshedReview(prev, incoming);
    expect(merged.comments[0].body).toBe("edited body");
    expect(merged.comments[0].stale).toBe(true);
  });

  it("adopts the refreshed snapshot and other diff-derived state", () => {
    const prev = review([note("c1", "x")], {
      snapshot: { baseOid: "old", headOid: null, capturedAt: "t0" },
    });
    const incoming = review([note("c1", "x")], {
      snapshot: { baseOid: "new", headOid: "h", capturedAt: "t1" },
    });
    const merged = mergeRefreshedReview(prev, incoming);
    expect(merged.snapshot).toEqual({ baseOid: "new", headOid: "h", capturedAt: "t1" });
  });
});
