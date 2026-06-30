// src/workspace/Workspace.test.tsx — opens its target on mount; mode switch re-opens in place
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

const openReview = vi.fn();
const openTarget = vi.fn();
const refreshReview = vi.fn();
const listCommits = vi.fn();
const computeDiff = vi.fn();
vi.mock("../api", () => ({
  api: {
    openReview: (...a: unknown[]) => openReview(...a),
    openTarget: (...a: unknown[]) => openTarget(...a),
    refreshReview: (...a: unknown[]) => refreshReview(...a),
    listCommits: (...a: unknown[]) => listCommits(...a),
    computeDiff: (...a: unknown[]) => computeDiff(...a),
    saveReview: vi.fn(),
    exportReview: vi.fn(),
    getFileDiff: vi.fn(),
    // The empty-session path renders <NothingToReview>, which enumerates the repo's
    // other worktrees; default to none so it shows its placeholder.
    listWorktrees: vi.fn().mockResolvedValue([]),
    showPicker: vi.fn(),
    // Already-installed → the header CLI CTA hides itself, keeping these tests focused.
    cliStatus: vi.fn().mockResolvedValue({ installed: true, path: "/usr/local/bin/delta" }),
    installCli: vi.fn(),
  },
}));

// Capture the "fs:changed" handler the Workspace registers so a test can fire it.
let fsChanged: ((e: { payload: { paths: string[]; gitMeta: boolean } }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: { paths: string[]; gitMeta: boolean } }) => void) => {
    if (name === "fs:changed") fsChanged = cb;
    return Promise.resolve(() => {});
  },
}));

import { Workspace } from "./Workspace";
import type { Target } from "../types";

const target: Target = { repoPath: "/r", mode: "all-changes" };
const minimalSession = {
  review: { id: "x", target: { repoPath: "/r", worktree: "main", mode: "all-changes" }, comments: [], viewed: [], snapshot: { baseOid: "b", capturedAt: "t" }, createdAt: "t", lastOpenedAt: "t", version: 1 },
  summary: { files: [], baseLabel: "main", headLabel: "wt" },
};
const fileSession = {
  ...minimalSession,
  summary: { files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false }], baseLabel: "main", headLabel: "wt" },
};
const COMMITS = [
  { oid: "o0", shortOid: "o0aaaaa", subject: "third", author: "me", time: 3 },
  { oid: "o1", shortOid: "o1bbbbb", subject: "second", author: "me", time: 2 },
  { oid: "o2", shortOid: "o2ccccc", subject: "first", author: "me", time: 1 },
];
const commitTarget: Target = { repoPath: "/r", mode: "commit", commit: "o1" };

describe("Workspace", () => {
  beforeEach(() => {
    openReview.mockReset();
    openTarget.mockReset();
    refreshReview.mockReset();
    listCommits.mockReset().mockResolvedValue([]);
    computeDiff.mockReset().mockResolvedValue({ files: [], baseLabel: "p", headLabel: "c" });
    fsChanged = null;
  });

  it("opens the review for its target on mount", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());
    expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "all-changes", base: undefined });
  });

  it("opens the review on its canonical mode, not 'commit'", async () => {
    // A ?mode=commit cold-start review still opens canonically (branch-vs-base);
    // commit mode is a display overlay, never the persisted review mode.
    openReview.mockResolvedValue(fileSession);
    listCommits.mockResolvedValue(COMMITS);
    render(<Workspace target={commitTarget} />);
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "branch-vs-base", base: undefined }));
    expect(openTarget).not.toHaveBeenCalled();
  });

  it("renders the commit stepper in commit mode and steps to the next commit", async () => {
    openReview.mockResolvedValue(fileSession);
    listCommits.mockResolvedValue(COMMITS);
    computeDiff.mockResolvedValue(fileSession.summary); // pinned commit has files → panes render
    render(<Workspace target={commitTarget} />);

    // Stepper shows the pinned commit's position (o1 is index 1 of 3) + its short oid.
    await waitFor(() => expect(screen.getByTestId("commit-stepper")).toHaveTextContent("2/3"));
    expect(screen.getByRole("button", { name: /diff mode/i })).toHaveTextContent("o1bbbbb");
    expect(openTarget).not.toHaveBeenCalled(); // no window spawned for the overlay

    // Stepping "next" advances to o2 and recomputes that commit's isolated diff.
    computeDiff.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /next commit/i }));
    await waitFor(() => expect(screen.getByTestId("commit-stepper")).toHaveTextContent("3/3"));
    expect(computeDiff).toHaveBeenCalledWith(expect.objectContaining({ mode: "commit", commit: "o2" }));
  });

  it("shows the stepper in 'Last commit' mode too, anchored at the newest commit", async () => {
    openReview.mockResolvedValue(fileSession);
    listCommits.mockResolvedValue(COMMITS);
    render(<Workspace target={{ repoPath: "/r", mode: "last-commit" }} />);
    // Stepper appears at HEAD (index 0 → "1/3") even though no commit is pinned.
    await waitFor(() => expect(screen.getByTestId("commit-stepper")).toHaveTextContent("1/3"));
    // Trigger still reads the canonical mode (not pinned), and no commit diff is fetched.
    expect(screen.getByRole("button", { name: /diff mode/i })).toHaveTextContent("Last commit");
    expect(computeDiff).not.toHaveBeenCalled();
    // Prev is disabled at HEAD; Next (older) is enabled.
    expect(screen.getByRole("button", { name: /previous commit/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next commit/i })).toBeEnabled();
  });

  it("a filesystem change surfaces a Refresh button instead of updating the diff in place (#12)", async () => {
    openReview.mockResolvedValue(fileSession); // showing src/a.ts
    // The re-diff swaps in a differently-named file, so we can tell whether it
    // was applied to the screen or merely staged behind the Refresh button.
    refreshReview.mockResolvedValue({
      ...minimalSession,
      summary: { files: [{ path: "src/zzztest.ts", status: "modified", additions: 2, deletions: 0, binary: false }], baseLabel: "main", headLabel: "wt" },
    });
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

    // No Refresh button until something changes.
    expect(screen.queryByRole("button", { name: /^refresh$/i })).toBeNull();

    // The watcher reports a change to a file we're showing.
    await act(async () => {
      fsChanged?.({ payload: { paths: ["src/a.ts"], gitMeta: false } });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument());
    expect(refreshReview).toHaveBeenCalled();
    // The diff was NOT updated in place — the new file isn't shown yet.
    expect(screen.queryAllByText(/zzztest\.ts/)).toHaveLength(0);

    // Clicking Refresh applies the pending change and clears the button.
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^refresh$/i })).toBeNull());
    await waitFor(() => expect(screen.queryAllByText(/zzztest\.ts/).length).toBeGreaterThan(0));
  });
});
