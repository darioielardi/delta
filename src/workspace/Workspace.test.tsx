// src/workspace/Workspace.test.tsx — opens its target on mount; mode switch re-opens in place
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const openReview = vi.fn();
const openTarget = vi.fn();
vi.mock("../api", () => ({
  api: {
    openReview: (...a: unknown[]) => openReview(...a),
    openTarget: (...a: unknown[]) => openTarget(...a),
    refreshReview: vi.fn(),
    saveReview: vi.fn(),
    exportReview: vi.fn(),
    getFileDiff: vi.fn(),
    showPicker: vi.fn(),
  },
}));

import { Workspace } from "./Workspace";
import type { Target } from "../types";

const target: Target = { repoPath: "/r", mode: "all-changes" };
const minimalSession = {
  review: { id: "x", target: { repoPath: "/r", worktree: "main", mode: "all-changes" }, comments: [], viewed: [], snapshot: { baseOid: "b", capturedAt: "t" }, createdAt: "t", lastOpenedAt: "t", version: 1 },
  summary: { files: [], baseLabel: "main", headLabel: "wt" },
};

describe("Workspace", () => {
  beforeEach(() => {
    openReview.mockReset();
    openTarget.mockReset();
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
});
