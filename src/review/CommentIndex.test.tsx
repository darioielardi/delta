import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommentIndex } from "./CommentIndex";
import type { Comment } from "../types";

const comments: Comment[] = [
  { id: "l", scope: "line", anchor: { file: "src/a.ts", side: "new", startLine: 22, endLine: null, snippet: "x" }, body: "line note", stale: true, resolved: false, createdAt: "t", updatedAt: "t" },
];

describe("CommentIndex", () => {
  it("lists anchored comments and jumps on click", () => {
    const onJump = vi.fn();
    render(<CommentIndex open onOpenChange={() => {}} comments={comments} onJump={onJump} />);
    // Path is split so the filename (last segment) is always visible. (#r4)
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/")).toBeInTheDocument();
    expect(screen.getByText(/L22/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("line note"));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: "l" }));
  });

  it("ignores stale on resolved comments — no header count, no entry badge", () => {
    const mixed: Comment[] = [
      { id: "open", scope: "line", anchor: { file: "src/a.ts", side: "new", startLine: 10, endLine: null, snippet: "x" }, body: "open stale", stale: true, resolved: false, createdAt: "t", updatedAt: "t" },
      { id: "res", scope: "line", anchor: { file: "src/b.ts", side: "new", startLine: 20, endLine: null, snippet: "y" }, body: "resolved stale", stale: true, resolved: true, createdAt: "t", updatedAt: "t" },
    ];
    render(<CommentIndex open onOpenChange={() => {}} comments={mixed} onJump={() => {}} />);
    // Header counts only the open stale comment, not the resolved one.
    expect(screen.getByText(/1 stale/)).toBeInTheDocument();
    // Only the open comment carries the "⚠ stale" entry badge.
    expect(screen.getAllByText("⚠ stale")).toHaveLength(1);
  });
});
