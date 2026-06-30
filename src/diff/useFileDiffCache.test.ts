// src/diff/useFileDiffCache.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const getFileDiff = vi.fn();
vi.mock("../api", () => ({ api: { getFileDiff: (...a: unknown[]) => getFileDiff(...a) } }));

import { useFileDiffCache } from "./useFileDiffCache";

const target = { repoPath: "/r", worktree: "main", mode: "all-changes" as const };

describe("useFileDiffCache", () => {
  beforeEach(() => getFileDiff.mockReset());

  it("loads once and caches, clears on demand", async () => {
    getFileDiff.mockResolvedValue({ status: "modified", binary: false });
    const { result } = renderHook(() => useFileDiffCache(target));
    await act(async () => { await result.current.load("a.ts"); });
    expect(result.current.get("a.ts")).toBeTruthy();
    await act(async () => { await result.current.load("a.ts"); }); // cached
    expect(getFileDiff).toHaveBeenCalledTimes(1);
    act(() => result.current.clear());
    expect(result.current.get("a.ts")).toBeUndefined();
  });

  it("re-points + clears when the pinned commit changes (mode stays 'commit')", async () => {
    getFileDiff.mockResolvedValue({ status: "modified", binary: false });
    const tA = { repoPath: "/r", worktree: "main", mode: "commit" as const, commit: "A" };
    const { result, rerender } = renderHook(({ t }) => useFileDiffCache(t), { initialProps: { t: tA } });
    await act(async () => { await result.current.load("x.ts"); });
    expect(getFileDiff).toHaveBeenLastCalledWith(tA, "x.ts");

    // Stepping to another commit keeps mode === "commit"; the store must still reset
    // and refetch against the new commit (else the section renders blank).
    const tB = { ...tA, commit: "B" };
    rerender({ t: tB });
    expect(result.current.get("x.ts")).toBeUndefined(); // cache cleared on commit change
    await act(async () => { await result.current.load("x.ts"); });
    expect(getFileDiff).toHaveBeenLastCalledWith(tB, "x.ts");
    expect(getFileDiff).toHaveBeenCalledTimes(2);
  });
});
