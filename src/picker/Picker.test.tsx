import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Picker } from "./Picker";
import { __setInvokeForDev } from "../api";
import type { Registry } from "../types";

const REG: Registry = {
  version: 1,
  repos: [
    { id: "r1", root: "/r/demo", name: "demo", defaultBranch: "main", worktrees: [{ path: "/r/demo", branch: "main", isMain: true }] },
  ],
  reviews: [
    { id: "abc", repoName: "demo", target: { repoPath: "/r/demo", worktree: "feat/auth", mode: "all-changes" }, lastOpenedAt: "2026-06-26T10:00:00Z", commentCount: 3, staleCount: 1, viewedCount: 0, fileCount: 7 },
    { id: "def", repoName: "demo", target: { repoPath: "/r/demo", worktree: "main", mode: "uncommitted" }, lastOpenedAt: "2026-06-25T09:00:00Z", commentCount: 0, staleCount: 0, viewedCount: 0, fileCount: 2 },
  ],
};

describe("Picker", () => {
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  beforeEach(() => {
    calls = [];
    __setInvokeForDev(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "list_registry") return structuredClone(REG) as never;
      return undefined as never;
    });
  });

  it("renders recency-ordered rows and opens on Enter", async () => {
    render(<Picker />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_target")).toBe(true));
    expect(calls.find((c) => c.cmd === "open_target")?.args).toMatchObject({ repoPath: "/r/demo", mode: "all-changes" });
    await waitFor(() => expect(calls.some((c) => c.cmd === "hide_picker")).toBe(true));
  });

  it("filters as you type", async () => {
    render(<Picker />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "uncommitted" } });
    await waitFor(() => expect(screen.queryByText("feat/auth")).not.toBeInTheDocument());
    expect(screen.getByText("main")).toBeInTheDocument();
  });
});
