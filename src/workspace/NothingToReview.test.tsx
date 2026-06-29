import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NothingToReview } from "./NothingToReview";
import { __setInvokeForDev } from "../api";
import type { Target, WorktreeEntry } from "../types";

const TARGET: Target = { repoPath: "/r/demo", worktree: "feat/auth", mode: "all-changes" };

function mockWorktrees(wts: WorktreeEntry[], onInvoke?: (cmd: string, args?: Record<string, unknown>) => void) {
  __setInvokeForDev(async (cmd: string, args?: Record<string, unknown>) => {
    onInvoke?.(cmd, args);
    if (cmd === "list_worktrees") return structuredClone(wts) as never;
    if (cmd === "open_target") return undefined as never;
    throw new Error(`unexpected ${cmd}`);
  });
}

describe("NothingToReview", () => {
  it("lists the repo's other worktrees and opens the picked one", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    mockWorktrees(
      [
        { path: "/r/demo", branch: "feat/auth", isMain: true, lastCommitAt: "2026-06-26T09:30:00Z", dirty: true },
        { path: "/r/demo-main", branch: "main", isMain: false, lastCommitAt: "2026-06-20T12:00:00Z", dirty: false },
        { path: "/r/demo-spike", branch: "spike/x", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false },
      ],
      (cmd, args) => calls.push([cmd, args]),
    );
    render(<NothingToReview target={TARGET} repoName="demo" modeLabel="All changes" />);

    // The "Other worktrees" section renders; the current worktree is excluded.
    expect(await screen.findByText("Other worktrees")).toBeInTheDocument();
    const spike = screen.getByRole("button", { name: /demo-spike/i });
    expect(screen.getByRole("button", { name: /demo-main/i })).toBeInTheDocument();

    fireEvent.click(spike);
    expect(calls).toContainEqual(["open_target", { repoPath: "/r/demo-spike", mode: "all-changes", base: undefined }]);
  });

  it("shows the placeholder when there are no other worktrees", async () => {
    mockWorktrees([{ path: "/r/demo", branch: "feat/auth", isMain: true, lastCommitAt: "2026-06-26T09:30:00Z", dirty: true }]);
    render(<NothingToReview target={TARGET} repoName="demo" modeLabel="All changes" />);

    // Makes clear we checked other worktrees and there are none.
    expect(await screen.findByText("This repository has no other worktrees.")).toBeInTheDocument();
    expect(screen.getByText(/Try a different diff mode/i)).toBeInTheDocument();
    expect(screen.queryByText("Other worktrees")).toBeNull();
    expect(screen.queryByRole("button", { name: /demo-main/i })).toBeNull();
  });
});
