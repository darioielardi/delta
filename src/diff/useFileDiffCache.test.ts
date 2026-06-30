// src/diff/useFileDiffCache.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const getFileDiff = vi.fn();
vi.mock("../api", () => ({ api: { getFileDiff: (...a: unknown[]) => getFileDiff(...a) } }));

import { useFileDiffCache } from "./useFileDiffCache";
import type { Target } from "../types";

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

  it("drops a load that resolves after the target changed — no stale/blank write", async () => {
    const tA: Target = { repoPath: "/r", worktree: "main", mode: "commit", commit: "A" };
    const tB: Target = { repoPath: "/r", worktree: "main", mode: "all-changes" };

    // The load against tA stays in flight until we resolve it by hand.
    let resolveA!: (v: unknown) => void;
    getFileDiff.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));

    const { result, rerender } = renderHook(({ t }) => useFileDiffCache(t), { initialProps: { t: tA } });
    const loadA = result.current.load("x.ts"); // in flight against tA
    rerender({ t: tB }); // commit → all-changes: the store resets mid-flight

    // tA's diff arrives late. It was fetched against the old commit (where the file
    // may not even appear → "not in diff" → blank), so it must NOT land in the cache.
    await act(async () => { resolveA({ status: "modified", binary: false }); await loadA; });
    expect(result.current.get("x.ts")).toBeUndefined();
  });

  it("reloads mounted (subscribed) files against the new target on a mode switch", async () => {
    getFileDiff.mockResolvedValue({ status: "modified", binary: false });
    const tA: Target = { repoPath: "/r", worktree: "main", mode: "commit", commit: "A" };
    const tB: Target = { repoPath: "/r", worktree: "main", mode: "all-changes" };

    const { result, rerender } = renderHook(({ t }) => useFileDiffCache(t), { initialProps: { t: tA } });
    // A mounted file section subscribes to its path (mirrors useSyncExternalStore).
    act(() => { result.current.subscribe("x.ts", () => {}); });
    await act(async () => { await result.current.load("x.ts"); });
    expect(getFileDiff).toHaveBeenLastCalledWith(tA, "x.ts");

    // Switching mode resets the store. A file still on screen must refetch against
    // the new target right away — IntersectionObserver won't re-fire for a section
    // that never left the viewport, so the store must re-drive the load itself. (#stale)
    await act(async () => { rerender({ t: tB }); });
    expect(getFileDiff).toHaveBeenLastCalledWith(tB, "x.ts");
  });
});
