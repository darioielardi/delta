// Jumping to a file (tree click) must preload its diff, so scrolling to a distant
// file doesn't land on a blank card while the fetch starts. In headless render the
// viewport has zero height, so no section auto-mounts — the ONLY way the fetch fires
// is the jump preload, which isolates the behavior under test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const getFileDiff = vi.fn();
vi.mock("../api", () => ({
  api: { getFileDiff: (...a: unknown[]) => getFileDiff(...a) },
  __setInvokeForDev: vi.fn(),
}));

import { VirtualDiffPane } from "./VirtualDiffPane";
import type { FileEntry, Target } from "../types";

const target: Target = { repoPath: "/r", mode: "all-changes" };
const files: FileEntry[] = [
  { path: "near.ts", status: "modified", additions: 3, deletions: 1, binary: false },
  { path: "far.ts", status: "modified", additions: 5, deletions: 2, binary: false },
];
const noop = () => {};

function paneEl(
  jump: { file: string; n: number } | null,
  prefetch: { file: string; n: number } | null = null,
) {
  return (
    <VirtualDiffPane
      target={target}
      files={files}
      theme="light"
      layout="unified"
      viewedFiles={new Set()}
      comments={[]}
      jump={jump}
      prefetch={prefetch}
      onToggleViewed={noop}
      onAddComment={noop}
      onAddFileComment={noop}
      onEditComment={noop}
      onDeleteComment={noop}
      onToggleResolvedComment={noop}
    />
  );
}

describe("VirtualDiffPane jump", () => {
  beforeEach(() => {
    getFileDiff.mockReset();
    getFileDiff.mockResolvedValue({ status: "modified", binary: false, newContent: "x\n" });
  });

  it("preloads a jumped-to file's diff so its card isn't blank on arrival", async () => {
    const { rerender } = render(paneEl(null));
    expect(getFileDiff).not.toHaveBeenCalled(); // nothing mounts in a zero-height viewport

    rerender(paneEl({ file: "far.ts", n: 1 })); // tree click → jump
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith(target, "far.ts"));
  });

  it("preloads a hovered file's diff via the prefetch signal (before any click)", async () => {
    const { rerender } = render(paneEl(null));
    expect(getFileDiff).not.toHaveBeenCalled();

    rerender(paneEl(null, { file: "far.ts", n: 1 })); // tree hover → prefetch
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith(target, "far.ts"));
  });
});
