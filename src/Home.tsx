// Launch window: a borderless, centered launcher hosting the shared ReviewPicker —
// recent reviews + the current worktrees of known repos + "Add a repo…". This is
// also the "what next" surface that reappears when the last review window closes.
// The macOS traffic lights float over the top-left; the top strip is an invisible
// drag region (no header chrome, no border). (#8)
import { api } from "./api";
import { ReviewPicker } from "./picker/ReviewPicker";
import { addRepo } from "./picker/pickerActions";
import { DeltaMark } from "@/components/DeltaMark";
import { Settings } from "lucide-react";
import type { PickerWorktree, ReviewEntry } from "./types";

const openReview = (r: ReviewEntry) => void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
const openWorktree = (w: PickerWorktree) => void api.openTarget(w.path, "all-changes");

async function deleteReview(r: ReviewEntry) {
  if (confirm(`Delete this review of ${r.repoName} · ${r.target.worktree ?? ""}?`)) {
    await api.deleteReview(r.id);
  }
}

export function Home({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <div data-testid="home-root" className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Soft accent glow behind the hero — subtle in both themes. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(75%_100%_at_50%_0%,color-mix(in_oklch,var(--primary)_11%,transparent),transparent)]"
      />
      {/* Invisible drag strip so the traffic lights have a drag area. */}
      <div data-tauri-drag-region className="relative h-11 shrink-0" />

      {/* Settings has no header to live in, so float it top-right. (#5/#8) */}
      <button
        type="button"
        onClick={onOpenSettings}
        title="Settings (⌘,)"
        aria-label="Settings"
        className="absolute right-3 top-2.5 z-10 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Settings className="size-4" />
      </button>

      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6 pb-10">
        <div className="flex w-full max-w-lg flex-col items-center">
          {/* Brand mark + wordmark */}
          <DeltaMark className="mb-3 size-12 shadow-lg shadow-black/20" />
          <h1 className="text-[22px] font-semibold tracking-tight">delta</h1>
          <p className="mt-1 text-center text-[13px] text-muted-foreground">Review diffs. Leave structured comments for agents.</p>

          {/* The picker: recents + known-repo worktrees + add-repo. */}
          <div className="mt-6 flex max-h-[58vh] w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-[13px] shadow-sm">
            <ReviewPicker onOpenReview={openReview} onOpenWorktree={openWorktree} onAddRepo={addRepo} onDeleteReview={deleteReview} />
          </div>
        </div>
      </main>
    </div>
  );
}
