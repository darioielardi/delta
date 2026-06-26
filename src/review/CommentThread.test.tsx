import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommentThread } from "./CommentThread";
import type { Comment } from "../types";

const comments: Comment[] = [
  { id: "c1", scope: "line", anchor: null, body: "**bold** note", stale: true, createdAt: "t", updatedAt: "t" },
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
});
