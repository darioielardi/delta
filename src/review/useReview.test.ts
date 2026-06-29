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

  it("addComment with an empty body is an in-memory draft (no save) (#r2)", () => {
    const { result } = renderHook(() => useReview(base));
    act(() => { result.current.addComment("line", null, ""); });
    expect(result.current.review!.comments).toHaveLength(1);
    expect(saveMock).not.toHaveBeenCalled(); // not persisted until explicitly saved
  });

  it("updateCommentBody saves immediately on explicit save (#r2)", async () => {
    const { result } = renderHook(() => useReview(base));
    act(() => { result.current.addComment("line", null, ""); }); // draft, no save
    const id = result.current.review!.comments[0].id;
    saveMock.mockReset();
    act(() => { result.current.updateCommentBody(id, "edited body"); });
    expect(result.current.review!.comments[0].body).toBe("edited body");
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  });

  it("toggleViewed saves immediately", () => {
    const { result } = renderHook(() => useReview(base));
    saveMock.mockReset();
    act(() => { result.current.toggleViewed("a.ts", "h1"); });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("toggleResolved flips resolved and saves immediately", async () => {
    const { result } = renderHook(() => useReview(base));
    act(() => result.current.addComment("line", null, "fix this"));
    const id = result.current.review!.comments[0].id;
    saveMock.mockReset();
    act(() => result.current.toggleResolved(id));
    expect(result.current.review!.comments[0].resolved).toBe(true);
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    act(() => result.current.toggleResolved(id));
    expect(result.current.review!.comments[0].resolved).toBe(false);
  });
});
