import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewPicker } from "./ReviewPicker";
import { __resetPickerCacheForTest } from "./pickerData";
import { __setInvokeForDev } from "../api";
import type { PickerData, PickerWorktree } from "../types";

const DATA: PickerData = {
  home: "/Users/me",
  recents: [
    { id: "rev1", repoName: "demo", target: { repoPath: "/r/demo", worktree: "feat/auth", mode: "all-changes" }, lastOpenedAt: "2026-06-26T10:00:00Z", commentCount: 3, staleCount: 1, resolvedCount: 0, viewedCount: 2, fileCount: 7 },
  ],
  worktrees: [
    { path: "/r/demo-spike", branch: "spike/idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false, repoName: "demo", repoId: "r1" },
  ],
};

function mock(data: PickerData) {
  __setInvokeForDev(async (cmd: string) => {
    if (cmd === "list_picker") return structuredClone(data) as never;
    throw new Error(`unexpected ${cmd}`);
  });
}

describe("ReviewPicker", () => {
  beforeEach(() => __resetPickerCacheForTest());

  it("lists recents and other worktrees, opens a worktree on click", async () => {
    mock(DATA);
    const opened: PickerWorktree[] = [];
    render(
      <ReviewPicker onOpenReview={() => {}} onOpenWorktree={(w) => opened.push(w)} onAddRepo={() => {}} onDeleteReview={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    expect(screen.getByText("spike/idea")).toBeInTheDocument();
    fireEvent.click(screen.getByText("spike/idea"));
    expect(opened.map((w) => w.branch)).toEqual(["spike/idea"]);
  });

  it("filters the list as you type", async () => {
    mock(DATA);
    render(<ReviewPicker onOpenReview={() => {}} onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={() => {}} />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "spike" } });
    await waitFor(() => expect(screen.queryByText("feat/auth")).not.toBeInTheDocument());
    expect(screen.getByText("spike/idea")).toBeInTheDocument();
  });

  it("excludes the current worktree from the list, even when the mode differs", async () => {
    mock(DATA);
    render(
      <ReviewPicker
        current={{ repoPath: "/r/demo", mode: "uncommitted" }}
        onOpenReview={() => {}}
        onOpenWorktree={() => {}}
        onAddRepo={() => {}}
        onDeleteReview={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("spike/idea")).toBeInTheDocument());
    // feat/auth is the worktree we're currently in (different mode) → not a switch target.
    expect(screen.queryByText("feat/auth")).not.toBeInTheDocument();
  });

  it("shows an add-repo affordance and a hint when there are no known repos", async () => {
    mock({ recents: [], worktrees: [] });
    render(<ReviewPicker onOpenReview={() => {}} onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no repos yet/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /add a repo/i })).toBeInTheDocument();
  });

  it("revalidates worktrees when the window regains focus", async () => {
    // A worktree created after the picker mounted (e.g. `git worktree add`) only shows
    // if the picker refetches; returning to the window is that trigger. (#refresh)
    const WITH_NEW: PickerData = {
      ...DATA,
      worktrees: [
        ...DATA.worktrees,
        { path: "/r/demo-fresh", branch: "fresh/wt", isMain: false, lastCommitAt: "2026-06-27T09:00:00Z", dirty: false, repoName: "demo", repoId: "r1" },
      ],
    };
    let calls = 0;
    __setInvokeForDev(async (cmd: string) => {
      if (cmd !== "list_picker") throw new Error(`unexpected ${cmd}`);
      calls += 1;
      return structuredClone(calls === 1 ? DATA : WITH_NEW) as never;
    });
    render(<ReviewPicker onOpenReview={() => {}} onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={() => {}} />);
    await waitFor(() => expect(screen.getByText("spike/idea")).toBeInTheDocument());
    expect(screen.queryByText("fresh/wt")).not.toBeInTheDocument();

    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(screen.getByText("fresh/wt")).toBeInTheDocument());
  });
});
