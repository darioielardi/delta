// The ⌘K frame: a top-anchored overlay (the documented exception to centered
// modals) wrapping the shared ReviewPicker. Switch to another review without
// leaving the current one. Mounted only while open (App conditionally renders it),
// so every open gets a fresh ReviewPicker fetch.
import { ReviewPicker } from "./ReviewPicker";
import { addRepo } from "./pickerActions";
import { api } from "../api";
import { getPickerOpenMode } from "../windowMode";
import type { DiffMode, PickerWorktree, ReviewEntry, Target } from "../types";

async function deleteReview(r: ReviewEntry) {
  if (confirm(`Delete this review of ${r.repoName} · ${r.target.worktree ?? ""}?`)) {
    await api.deleteReview(r.id);
  }
}

// Open a target in a new review window (default) or by REPLACING the current one
// in place: re-point this window's fs watcher, then navigate its URL to the new
// target. Label-based routing keeps it a review window, so no reload-to-home. (#replace)
async function openTargetFrom(repoPath: string, mode: DiffMode, base?: string): Promise<void> {
  if (getPickerOpenMode() === "replace") {
    try {
      await api.rewatchWindow(repoPath);
    } catch {
      /* watcher is best-effort; the navigation below is the visible action */
    }
    const u = new URL(window.location.href);
    u.searchParams.set("repo", repoPath);
    u.searchParams.set("mode", mode);
    if (base) u.searchParams.set("base", base);
    else u.searchParams.delete("base");
    window.location.assign(u.toString());
    return;
  }
  await api.openTarget(repoPath, mode, base);
}

export function CommandPalette({ onClose, current }: { onClose: () => void; current?: Target }) {
  const openReview = (r: ReviewEntry) => {
    void openTargetFrom(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
    onClose();
  };
  const openWorktree = (w: PickerWorktree) => {
    void openTargetFrom(w.path, "all-changes");
    onClose();
  };
  const onAddRepo = () => {
    onClose();
    void addRepo();
  };

  return (
    <div
      data-testid="command-palette"
      className="absolute inset-0 z-50 flex items-start justify-center bg-black/40 pt-[16vh] duration-100 data-[open]:animate-in data-[open]:fade-in-0"
      data-open
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[64vh] w-[40rem] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-popover text-[13px] text-popover-foreground shadow-2xl duration-100 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95"
        data-open
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <ReviewPicker
          current={current}
          onOpenReview={openReview}
          onOpenWorktree={openWorktree}
          onAddRepo={onAddRepo}
          onDeleteReview={deleteReview}
        />
      </div>
    </div>
  );
}
