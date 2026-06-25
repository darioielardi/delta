import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const computeDiff = vi.fn();
const getFileDiff = vi.fn();
vi.mock("../api", () => ({ api: { computeDiff: (...a: unknown[]) => computeDiff(...a), getFileDiff: (...a: unknown[]) => getFileDiff(...a) } }));
// DiffView is exercised in its own test; stub it here to keep this test about wiring.
vi.mock("../diff/DiffView", () => ({ DiffView: () => <div data-testid="diffview" /> }));

import { Workspace } from "./Workspace";

describe("Workspace", () => {
  beforeEach(() => { computeDiff.mockReset(); getFileDiff.mockReset(); });

  it("loads files after Open and refetches on mode change", async () => {
    computeDiff.mockResolvedValue({ files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, binary: false }], baseLabel: "main", headLabel: "feat" });
    render(<Workspace />);
    fireEvent.change(screen.getByPlaceholderText(/repo path/i), { target: { value: "/r" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await waitFor(() => expect(screen.getByText(/1 files/)).toBeInTheDocument()); // FilesPanel header (arborist rows need layout; see Task 7 note)
    expect(computeDiff).toHaveBeenCalledWith({ repoPath: "/r", mode: "all-changes" });

    // ToggleGroupItems render role="radio" in this shadcn version (confirmed Task 7)
    fireEvent.click(screen.getByRole("radio", { name: /uncommitted/i }));
    await waitFor(() => expect(computeDiff).toHaveBeenCalledWith({ repoPath: "/r", mode: "uncommitted" }));
  });
});
