// The ⌘K frame: a top-anchored overlay (the documented exception to centered
// modals) wrapping the shared ReviewPicker. Switch to another review without
// leaving the current one. Mounted only while open (App conditionally renders it),
// so every open gets a fresh ReviewPicker fetch.
import { ReviewPicker } from "./ReviewPicker";
import { addRepo } from "./pickerActions";
import { api } from "../api";
import type { PickerWorktree, ReviewEntry, Target } from "../types";

async function deleteReview(r: ReviewEntry) {
  if (confirm(`Delete this review of ${r.repoName} · ${r.target.worktree ?? ""}?`)) {
    await api.deleteReview(r.id);
  }
}

export function CommandPalette({ onClose, current }: { onClose: () => void; current?: Target }) {
  const openReview = (r: ReviewEntry) => {
    void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
    onClose();
  };
  const openWorktree = (w: PickerWorktree) => {
    void api.openTarget(w.path, "all-changes");
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
