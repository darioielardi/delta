import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommentThread } from "./CommentThread";
import type { Comment } from "../types";

const comments: Comment[] = [
  { id: "c1", scope: "line", anchor: null, body: "**bold** note", stale: true, resolved: false, createdAt: "t", updatedAt: "t" },
];

describe("CommentThread", () => {
  it("renders markdown body and a stale badge, and fires delete", () => {
    const onDelete = vi.fn();
    render(<CommentThread comments={comments} onEdit={() => {}} onDelete={onDelete} onToggleResolved={() => {}} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith("c1");
  });

  it("removes a just-created empty comment when its editor is cancelled", () => {
    const onDelete = vi.fn();
    const draft: Comment = { id: "n1", scope: "line", anchor: null, body: "", stale: false, resolved: false, createdAt: "t", updatedAt: "t" };
    render(<CommentThread comments={[draft]} onEdit={() => {}} onDelete={onDelete} onToggleResolved={() => {}} />);
    // The empty draft auto-opens its editor; cancelling a never-saved blank
    // comment should remove it entirely rather than leave an empty note.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onDelete).toHaveBeenCalledWith("n1");
  });

  it("keeps a comment that has content when its edit is cancelled", () => {
    const onDelete = vi.fn();
    render(<CommentThread comments={comments} onEdit={() => {}} onDelete={onDelete} onToggleResolved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("fires onToggleResolved and shows the resolved chip + Reopen", () => {
    const onToggleResolved = vi.fn();
    const open: Comment[] = [{ id: "c1", scope: "line", anchor: null, body: "note", stale: false, resolved: false, createdAt: "t", updatedAt: "t" }];
    const { rerender } = render(<CommentThread comments={open} onEdit={() => {}} onDelete={() => {}} onToggleResolved={onToggleResolved} />);
    fireEvent.click(screen.getByRole("button", { name: /^resolve$/i }));
    expect(onToggleResolved).toHaveBeenCalledWith("c1");
    rerender(<CommentThread comments={[{ ...open[0], resolved: true }]} onEdit={() => {}} onDelete={() => {}} onToggleResolved={onToggleResolved} />);
    expect(screen.getByText(/resolved/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reopen$/i })).toBeInTheDocument();
  });
});
