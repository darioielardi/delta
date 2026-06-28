import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewPicker } from "./ReviewPicker";
import { __resetPickerCacheForTest } from "./pickerData";
import { __setInvokeForDev } from "../api";
import type { PickerData, PickerWorktree } from "../types";

const DATA: PickerData = {
  home: "/Users/me",
  recents: [
    { id: "rev1", repoName: "demo", target: { repoPath: "/r/demo", worktree: "feat/auth", mode: "all-changes" }, lastOpenedAt: "2026-06-26T10:00:00Z", commentCount: 3, staleCount: 1, viewedCount: 2, fileCount: 7 },
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

  it("shows an add-repo affordance and a hint when there are no known repos", async () => {
    mock({ recents: [], worktrees: [] });
    render(<ReviewPicker onOpenReview={() => {}} onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no repos yet/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /add a repo/i })).toBeInTheDocument();
  });
});
