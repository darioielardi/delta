import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { __setInvokeForDev } from "../api";
import type { Registry } from "../types";

const REG: Registry = {
  version: 1,
  repos: [
    { id: "r1", root: "/r/demo", name: "demo", defaultBranch: "main", worktrees: [{ path: "/r/demo", branch: "main", isMain: true }] },
  ],
  reviews: [
    { id: "abc", repoName: "demo", target: { repoPath: "/r/demo", worktree: "feat/auth", mode: "all-changes" }, lastOpenedAt: "2026-06-26T10:00:00Z", commentCount: 3, staleCount: 1, resolvedCount: 1, viewedCount: 0, fileCount: 7 },
    { id: "def", repoName: "demo", target: { repoPath: "/r/demo", worktree: "main", mode: "uncommitted" }, lastOpenedAt: "2026-06-25T09:00:00Z", commentCount: 0, staleCount: 0, resolvedCount: 0, viewedCount: 0, fileCount: 2 },
  ],
};

describe("CommandPalette", () => {
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  beforeEach(() => {
    calls = [];
    __setInvokeForDev(async (cmd) => {
      calls.push({ cmd });
      if (cmd === "list_registry") return structuredClone(REG) as never;
      if (cmd === "list_worktrees") return [{ path: "/r/demo", branch: "main", isMain: true }] as never;
      return undefined as never;
    });
  });

  it("lists recency-ordered reviews with no mode badge, opens on Enter", async () => {
    render(<CommandPalette onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    // Mode is no longer part of review identity — no per-mode badge in the picker.
    expect(screen.queryByText("All changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Uncommitted")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText(/search reviews/i), { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_target")).toBe(true));
  });

  it("filters reviews as you type (by worktree)", async () => {
    render(<CommandPalette onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/search reviews/i), { target: { value: "main" } });
    await waitFor(() => expect(screen.queryByText("feat/auth")).not.toBeInTheDocument());
    expect(screen.getByText("main")).toBeInTheDocument();
  });

  it("new review → pick repo (single worktree) opens all-changes immediately", async () => {
    render(<CommandPalette onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("＋ New review")).toBeInTheDocument());
    fireEvent.click(screen.getByText("＋ New review"));
    await waitFor(() => expect(screen.getByPlaceholderText(/pick a repository/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText("demo"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_target")).toBe(true));
  });
});
