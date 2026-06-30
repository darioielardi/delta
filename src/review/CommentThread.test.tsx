import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CommentThread } from "./CommentThread";
import type { Comment } from "../types";

const comments: Comment[] = [
  { id: "c1", scope: "line", anchor: null, body: "**bold** note", stale: true, resolved: false, createdAt: "t", updatedAt: "t" },
];

describe("CommentThread", () => {
  it("renders markdown body + stale label, and confirms before deleting", () => {
    const onDelete = vi.fn();
    render(<CommentThread comments={comments} onEdit={() => {}} onDelete={onDelete} onToggleResolved={() => {}} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    // Delete now opens a confirm dialog rather than deleting immediately.
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith("c1");
  });

  it("cancelling the delete dialog keeps the comment", () => {
    const onDelete = vi.fn();
    render(<CommentThread comments={comments} onEdit={() => {}} onDelete={onDelete} onToggleResolved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /cancel/i }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("removes a just-created empty comment when its editor is cancelled", () => {
    const onDelete = vi.fn();
    const draft: Comment = { id: "n1", scope: "line", anchor: null, body: "", stale: false, resolved: false, createdAt: "t", updatedAt: "t" };
    render(<CommentThread comments={[draft]} onEdit={() => {}} onDelete={onDelete} onToggleResolved={() => {}} />);
    // The empty draft auto-opens its editor; cancelling a never-saved blank
    // comment should remove it entirely (no confirm — it was never saved).
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

  it("resolves, then collapses to a Reopen row", () => {
    const onToggleResolved = vi.fn();
    const openC: Comment[] = [{ id: "c1", scope: "line", anchor: null, body: "note body", stale: false, resolved: false, createdAt: "t", updatedAt: "t" }];
    const { rerender } = render(<CommentThread comments={openC} onEdit={() => {}} onDelete={() => {}} onToggleResolved={onToggleResolved} />);
    fireEvent.click(screen.getByRole("button", { name: /^resolve$/i }));
    expect(onToggleResolved).toHaveBeenCalledWith("c1");
    rerender(<CommentThread comments={[{ ...openC[0], resolved: true }]} onEdit={() => {}} onDelete={() => {}} onToggleResolved={onToggleResolved} />);
    expect(screen.getByRole("button", { name: /^reopen$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.getByText("note body")).toBeInTheDocument();
  });
});
