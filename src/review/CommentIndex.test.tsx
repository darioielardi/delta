import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommentIndex } from "./CommentIndex";
import type { Comment } from "../types";

const comments: Comment[] = [
  { id: "l", scope: "line", anchor: { file: "src/a.ts", side: "new", startLine: 22, endLine: null, snippet: "x" }, body: "line note", stale: true, createdAt: "t", updatedAt: "t" },
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
});
