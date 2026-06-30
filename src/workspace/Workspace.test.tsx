// src/workspace/Workspace.test.tsx — opens its target on mount; mode switch re-opens in place
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

const openReview = vi.fn();
const openTarget = vi.fn();
const refreshReview = vi.fn();
vi.mock("../api", () => ({
  api: {
    openReview: (...a: unknown[]) => openReview(...a),
    openTarget: (...a: unknown[]) => openTarget(...a),
    refreshReview: (...a: unknown[]) => refreshReview(...a),
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

// Capture the event handlers the Workspace registers so tests can fire them.
let fsChanged: ((e: { payload: { paths: string[]; gitMeta: boolean } }) => void) | null = null;
let setMode: ((e: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: never }) => void) => {
    if (name === "fs:changed") fsChanged = cb as never;
    if (name === "cli:set-mode") setMode = cb as never;
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

describe("Workspace", () => {
  beforeEach(() => {
    openReview.mockReset();
    openTarget.mockReset();
    refreshReview.mockReset();
    fsChanged = null;
    setMode = null;
  });

  it("opens the review for its target on mount", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());
    expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "all-changes", base: undefined });
  });

  it("switching mode re-opens in place (openReview, not a new window)", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());
    openReview.mockClear();

    fireEvent.change(screen.getByRole("combobox", { name: /diff mode/i }), { target: { value: "uncommitted" } });
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "uncommitted", base: undefined }));
    expect(openTarget).not.toHaveBeenCalled();
  });

  it("applies an explicit --mode forwarded from the CLI in place (cli:set-mode)", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());
    openReview.mockClear();

    act(() => setMode?.({ payload: "uncommitted" }));
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "uncommitted", base: undefined }));
    expect(openTarget).not.toHaveBeenCalled();
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
