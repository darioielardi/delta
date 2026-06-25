import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const saveMock = vi.fn();
vi.mock("../api", () => ({ api: { saveReview: (...a: unknown[]) => saveMock(...a) } }));

import { useReview } from "./useReview";
import type { Review } from "../types";

const base: Review = {
  version: 1, id: "x",
  target: { repoPath: "/r", worktree: "main", mode: "all-changes" },
  snapshot: { baseOid: "b", headOid: null, capturedAt: "t" },
  comments: [], viewed: [], createdAt: "t", lastOpenedAt: "t",
};

describe("useReview", () => {
  beforeEach(() => saveMock.mockReset());

  it("addComment appends and saves immediately", async () => {
    const { result } = renderHook(() => useReview(base));
    act(() => result.current.addComment("general", null, "a note"));
    expect(result.current.review!.comments).toHaveLength(1);
    expect(result.current.review!.comments[0].body).toBe("a note");
    expect(result.current.review!.comments[0].id).toBeTruthy();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  });

  it("deleteComment removes and saves", async () => {
    const { result } = renderHook(() => useReview(base));
    act(() => result.current.addComment("general", null, "x"));
    const id = result.current.review!.comments[0].id;
    saveMock.mockReset();
    act(() => result.current.deleteComment(id));
    expect(result.current.review!.comments).toHaveLength(0);
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  });

  it("toggleViewed adds then removes a viewed entry", () => {
    const { result } = renderHook(() => useReview(base));
    act(() => result.current.toggleViewed("a.ts", "h1"));
    expect(result.current.review!.viewed).toEqual([{ file: "a.ts", diffHash: "h1" }]);
    act(() => result.current.toggleViewed("a.ts", "h1"));
    expect(result.current.review!.viewed).toEqual([]);
  });
});
