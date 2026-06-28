import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { __resetPickerCacheForTest } from "./pickerData";
import { __setInvokeForDev } from "../api";
import type { PickerData } from "../types";

const DATA: PickerData = {
  home: "/Users/me",
  recents: [
    { id: "abc", repoName: "demo", target: { repoPath: "/r/demo", worktree: "feat/auth", mode: "all-changes" }, lastOpenedAt: "2026-06-26T10:00:00Z", commentCount: 3, staleCount: 1, viewedCount: 0, fileCount: 7 },
  ],
  worktrees: [
    { path: "/r/demo-spike", branch: "spike/idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false, repoName: "demo", repoId: "r1" },
  ],
};

describe("CommandPalette", () => {
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  beforeEach(() => {
    __resetPickerCacheForTest();
    calls = [];
    __setInvokeForDev(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "list_picker") return structuredClone(DATA) as never;
      return undefined as never;
    });
  });

  it("opens a recent review on click and closes (no mode badge)", async () => {
    let closed = false;
    render(<CommandPalette onClose={() => { closed = true; }} />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    expect(screen.queryByText("All changes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("feat/auth"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_target")).toBe(true));
    expect(closed).toBe(true);
  });

  it("opens an other-worktree with all-changes", async () => {
    render(<CommandPalette onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("spike/idea")).toBeInTheDocument());
    fireEvent.click(screen.getByText("spike/idea"));
    await waitFor(() => {
      const call = calls.find((c) => c.cmd === "open_target");
      expect(call?.args).toMatchObject({ repoPath: "/r/demo-spike", mode: "all-changes" });
    });
  });

  it("escape closes", async () => {
    let closed = false;
    render(<CommandPalette onClose={() => { closed = true; }} />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: "Escape" });
    expect(closed).toBe(true);
  });
});
