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
    render(<CommentThread comments={comments} onEdit={() => {}} onDelete={onDelete} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith("c1");
  });

  it("removes a just-created empty comment when its editor is cancelled", () => {
    const onDelete = vi.fn();
    const draft: Comment = { id: "n1", scope: "line", anchor: null, body: "", stale: false, resolved: false, createdAt: "t", updatedAt: "t" };
    render(<CommentThread comments={[draft]} onEdit={() => {}} onDelete={onDelete} />);
    // The empty draft auto-opens its editor; cancelling a never-saved blank
    // comment should remove it entirely rather than leave an empty note.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onDelete).toHaveBeenCalledWith("n1");
  });

  it("keeps a comment that has content when its edit is cancelled", () => {
    const onDelete = vi.fn();
    render(<CommentThread comments={comments} onEdit={() => {}} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});
