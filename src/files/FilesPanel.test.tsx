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
    expect(screen.getByTitle("Files viewed")).toHaveTextContent("0 / 1 viewed");
    expect(screen.getByTestId("files-tree")).toBeInTheDocument();
    // shadcn ToggleGroup renders items as role="radio" within a radiogroup
    expect(screen.getByRole("radio", { name: /list/i })).toBeInTheDocument();
  });

  it("shows the viewed count in the header", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} />);
    expect(screen.getByTitle("Files viewed")).toHaveTextContent("1 / 1 viewed");
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

  it("labels a renamed file with its old path via a tooltip", () => {
    const renamed: FileEntry[] = [
      { path: "src/auth/token.ts", oldPath: "src/auth/session.ts", status: "renamed", additions: 0, deletions: 0, binary: false },
    ];
    render(<FilesPanel files={renamed} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} />);
    expect(screen.getByTitle("Renamed from src/auth/session.ts")).toBeInTheDocument();
  });

  it("does not scroll the tree when a folder is collapsed or expanded", () => {
    // Collapsing/expanding a folder reshapes the tree but must not move the
    // scroller — the active file only follows selection/keyboard/scroll-spy,
    // never a folder toggle. (regression: folder toggle yanked the pane back
    // to the out-of-view active file)
    const scrollSpy = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {});
    try {
      const multi: FileEntry[] = [
        { path: "lib/c.ts", status: "modified", additions: 1, deletions: 0, binary: false },
        { path: "lib/d.ts", status: "modified", additions: 1, deletions: 0, binary: false },
        { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false },
        { path: "src/b.ts", status: "modified", additions: 1, deletions: 0, binary: false },
      ];
      // src/a.ts is the active file; lib/ is a sibling folder that doesn't contain it.
      render(<FilesPanel files={multi} selected="src/a.ts" onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} />);
      // Mount scrolls the initially-selected file into view — that's expected; only
      // the folder toggles below must leave the scroller untouched.
      scrollSpy.mockClear();
      fireEvent.click(screen.getByText("lib")); // collapse
      fireEvent.click(screen.getByText("lib")); // expand
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it("prefetches a file's diff after the pointer rests on its row (debounced)", () => {
    vi.useFakeTimers();
    try {
      const onPrefetch = vi.fn();
      render(<FilesPanel files={files} selected={null} onSelect={() => {}} onPrefetch={onPrefetch} viewedFiles={new Set()} onToggleViewed={() => {}} />);
      // mouseOver is what React uses to synthesize onMouseEnter (mouseenter doesn't bubble).
      fireEvent.mouseOver(screen.getByText("a.ts"));
      expect(onPrefetch).not.toHaveBeenCalled(); // debounced, not fired on entry
      vi.advanceTimersByTime(110);
      expect(onPrefetch).toHaveBeenCalledWith("src/a.ts");
    } finally {
      vi.useRealTimers();
    }
  });
});
