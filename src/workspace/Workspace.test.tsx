// src/workspace/Workspace.test.tsx — mock api.openReview and assert bootstrap renders
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const openReview = vi.fn();
vi.mock("../api", () => ({ api: { openReview: (...a: unknown[]) => openReview(...a), refreshReview: vi.fn(), saveReview: vi.fn(), exportReview: vi.fn(), getFileDiff: vi.fn() } }));

import { Workspace } from "./Workspace";

const minimalSession = {
  review: { id: "x", target: { repoPath: "/r", worktree: "main", mode: "all-changes" }, comments: [], viewed: [], snapshot: { baseOid: "b", capturedAt: "t" }, createdAt: "t", lastOpenedAt: "t", version: 1 },
  summary: { files: [], baseLabel: "main", headLabel: "wt" },
};

describe("Workspace", () => {
  beforeEach(() => openReview.mockReset());

  it("opens a review and shows the toolbar", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace />);
    fireEvent.change(screen.getByPlaceholderText("Repo path"), { target: { value: "/r" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for claude/i })).toBeInTheDocument());
    expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "all-changes" });
  });

  it("re-opens when mode is switched", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace />);
    fireEvent.change(screen.getByPlaceholderText("Repo path"), { target: { value: "/r" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for claude/i })).toBeInTheDocument());

    openReview.mockResolvedValue({
      ...minimalSession,
      review: { ...minimalSession.review, target: { ...minimalSession.review.target, mode: "uncommitted" } },
    });
    fireEvent.click(screen.getByRole("radio", { name: /uncommitted/i }));
    await waitFor(() =>
      expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "uncommitted" })
    );
  });
});
