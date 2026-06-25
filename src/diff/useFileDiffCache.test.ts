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
});
