import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewReviewDrill } from "./NewReviewDrill";
import { __setInvokeForDev } from "../api";
import type { RepoEntry } from "../types";

const repo: RepoEntry = {
  id: "r1",
  root: "/r/demo",
  name: "demo",
  defaultBranch: "main",
  worktrees: [{ path: "/r/demo", branch: "main", isMain: true }],
};

describe("NewReviewDrill", () => {
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  beforeEach(() => {
    calls = [];
    __setInvokeForDev(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "list_worktrees") return [{ path: "/r/demo", branch: "main", isMain: true }] as never;
      return undefined as never;
    });
  });

  it("single-worktree repo advances to mode and opens the target", async () => {
    render(<NewReviewDrill repos={[repo]} onClose={() => {}} onReposChanged={() => {}} />);
    fireEvent.click(screen.getByText("demo"));
    await waitFor(() => expect(screen.getByTestId("drill-modes")).toBeInTheDocument());
    fireEvent.click(screen.getByText("All changes"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_target")).toBe(true));
    const call = calls.find((c) => c.cmd === "open_target");
    expect(call?.args).toMatchObject({ repoPath: "/r/demo", mode: "all-changes" });
  });
});
