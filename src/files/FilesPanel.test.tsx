// src/files/FilesPanel.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FilesPanel } from "./FilesPanel";
import type { FileEntry } from "../types";

const files: FileEntry[] = [
  { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
];

describe("FilesPanel", () => {
  it("shows the empty state when there are no files", () => {
    render(<FilesPanel files={[]} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} />);
    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
  });

  it("renders the header, file count, toggle, and tree container", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} />);
    expect(screen.getByText(/1 files/)).toBeInTheDocument();
    expect(screen.getByTestId("files-tree")).toBeInTheDocument();
    // shadcn ToggleGroup renders items as role="radio" within a radiogroup
    expect(screen.getByRole("radio", { name: /list/i })).toBeInTheDocument();
  });

  it("shows the viewed count in the header", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} />);
    expect(screen.getByText(/1\/1 viewed/)).toBeInTheDocument();
  });
});
