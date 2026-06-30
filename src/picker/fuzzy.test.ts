import { describe, it, expect } from "vitest";
import { fuzzyMatch, rankReviews, rankWorktrees } from "./fuzzy";
import type { PickerWorktree, ReviewEntry } from "../types";

function entry(id: string, branch: string, repoName: string, lastOpenedAt: string): ReviewEntry {
  return {
    id,
    repoName,
    target: { repoPath: `/r/${repoName}`, worktree: branch, mode: "all-changes" },
    lastOpenedAt,
    commentCount: 0,
    staleCount: 0,
    resolvedCount: 0,
    viewedCount: 0,
    fileCount: 0,
  };
}

describe("fuzzyMatch", () => {
  it("matches a subsequence", () => {
    expect(fuzzyMatch("auth", "feat/auth")).not.toBeNull();
  });
  it("rejects a non-subsequence", () => {
    expect(fuzzyMatch("zzz", "feat/auth")).toBeNull();
  });
  it("empty query scores 0 (matches all)", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
  });
  it("is case-insensitive", () => {
    expect(fuzzyMatch("AUTH", "feat/auth")).not.toBeNull();
  });
});

describe("rankReviews", () => {
  it("empty query sorts by lastOpenedAt desc", () => {
    const a = entry("a", "main", "demo", "2026-06-25T00:00:00Z");
    const b = entry("b", "feat", "demo", "2026-06-26T00:00:00Z");
    expect(rankReviews([a, b], "").map((r) => r.id)).toEqual(["b", "a"]);
  });
  it("filters out non-matches", () => {
    const a = entry("a", "main", "demo", "t");
    const b = entry("b", "feat/auth", "demo", "t");
    expect(rankReviews([a, b], "auth").map((r) => r.id)).toEqual(["b"]);
  });
  it("is searchable by worktree dir, branch, and repo name independently", () => {
    // Distinct tokens per field: worktree dir "hotfix-wt" (from repoPath) ≠ branch
    // "release/2.0" (target.worktree) ≠ repo "acme" — so each query hits one field.
    const r: ReviewEntry = {
      ...entry("x", "release/2.0", "acme", "t"),
      target: { repoPath: "/Users/me/code/hotfix-wt", worktree: "release/2.0", mode: "all-changes" },
    };
    expect(rankReviews([r], "hotfix")).toHaveLength(1); // worktree dir
    expect(rankReviews([r], "release")).toHaveLength(1); // branch
    expect(rankReviews([r], "acme")).toHaveLength(1); // repo
    expect(rankReviews([r], "zzz")).toHaveLength(0);
  });
});

describe("rankWorktrees", () => {
  const wt = (branch: string, repoName: string, lastCommitAt?: string): PickerWorktree => ({
    path: `/r/${branch}`,
    branch,
    isMain: false,
    lastCommitAt,
    dirty: false,
    repoName,
    repoId: "r1",
  });

  it("empty query sorts by lastCommitAt desc", () => {
    const list = [wt("feat/a", "demo", "2026-06-20T00:00:00Z"), wt("feat/b", "demo", "2026-06-26T00:00:00Z")];
    expect(rankWorktrees(list, "").map((w) => w.branch)).toEqual(["feat/b", "feat/a"]);
  });
  it("filters by branch/repo query", () => {
    const list = [wt("feat/a", "demo"), wt("feat/b", "demo")];
    expect(rankWorktrees(list, "feat/a").map((w) => w.branch)).toEqual(["feat/a"]);
  });
  it("is searchable by worktree dir, branch, and repo name independently", () => {
    // worktree dir "spike-wt" (path tail) ≠ branch "feat/login" ≠ repo "acme".
    const w: PickerWorktree = { path: "/Users/me/code/spike-wt", branch: "feat/login", isMain: false, repoName: "acme", repoId: "r1" };
    expect(rankWorktrees([w], "spike")).toHaveLength(1); // worktree dir
    expect(rankWorktrees([w], "login")).toHaveLength(1); // branch
    expect(rankWorktrees([w], "acme")).toHaveLength(1); // repo
    expect(rankWorktrees([w], "zzz")).toHaveLength(0);
  });
});
