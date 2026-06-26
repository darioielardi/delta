// src/files/FilesPanel.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("renders the header, viewed count, toggle, and tree container", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} />);
    expect(screen.getByText(/0\/1 viewed/)).toBeInTheDocument();
    expect(screen.getByTestId("files-tree")).toBeInTheDocument();
    // shadcn ToggleGroup renders items as role="radio" within a radiogroup
    expect(screen.getByRole("radio", { name: /list/i })).toBeInTheDocument();
  });

  it("shows the viewed count in the header", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} />);
    expect(screen.getByText(/1\/1 viewed/)).toBeInTheDocument();
  });

  it("shows the global diff count (sum across files) in the header", () => {
    const multi: FileEntry[] = [
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
      { path: "src/b.ts", status: "modified", additions: 2, deletions: 4, binary: false },
    ];
    render(<FilesPanel files={multi} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} />);
    // Totals: +5 / −5 — values no individual row shows, so they're unique to the header.
    expect(screen.getByText("+5")).toBeInTheDocument();
    expect(screen.getByText("−5")).toBeInTheDocument();
  });

  it("omits the tree-indent spacer in list mode", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} />);
    // Tree mode (default): file rows carry the chevron-column spacer.
    expect(screen.getAllByTestId("tree-indent").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("radio", { name: /list/i }));
    expect(screen.queryByTestId("tree-indent")).not.toBeInTheDocument();
  });

  it("renders the file row and selects it on click", () => {
    const onSelect = vi.fn();
    render(<FilesPanel files={files} selected={null} onSelect={onSelect} viewedFiles={new Set()} onToggleViewed={() => {}} />);
    const leaf = screen.getByText("a.ts"); // tree mode shows the leaf name under src/
    expect(leaf).toBeInTheDocument();
    fireEvent.click(leaf);
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });

  it("toggles viewed via the row affordance", () => {
    const onToggleViewed = vi.fn();
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={onToggleViewed} />);
    fireEvent.click(screen.getByRole("button", { name: /viewed src\/a\.ts/i }));
    expect(onToggleViewed).toHaveBeenCalledWith("src/a.ts");
  });
});
