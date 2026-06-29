// Launch window: a borderless, centered launcher hosting the shared ReviewPicker —
// recent reviews + the current worktrees of known repos + "Add a repo…". This is
// also the "what next" surface that reappears when the last review window closes.
// The macOS traffic lights float over the top-left; the top strip is an invisible
// drag region (no header chrome, no border). (#8)
import { useEffect, useState } from "react";
import { api } from "./api";
import { ReviewPicker } from "./picker/ReviewPicker";
import { FirstRun } from "./picker/FirstRun";
import { addRepo } from "./picker/pickerActions";
import { loadPicker, peekPickerCache } from "./picker/pickerData";
import { DeltaMark } from "@/components/DeltaMark";
import { Settings } from "lucide-react";
import type { PickerData, PickerWorktree, ReviewEntry } from "./types";

const openReview = (r: ReviewEntry) => void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
const openWorktree = (w: PickerWorktree) => void api.openTarget(w.path, "all-changes");

async function deleteReview(r: ReviewEntry) {
  if (confirm(`Delete this review of ${r.repoName} · ${r.target.worktree ?? ""}?`)) {
    await api.deleteReview(r.id);
  }
}

export function Home({ onOpenSettings }: { onOpenSettings?: () => void }) {
  // Decide here (not inside ReviewPicker) whether the launcher has anything to
  // list, so the empty state can replace the whole picker — search, list, and
  // footer — with the FirstRun panel. Seeds from the shared cache for an instant
  // first paint; the picker reuses the same cache, so this adds no extra wait.
  const [data, setData] = useState<PickerData | null>(() => peekPickerCache());
  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    void loadPicker().then(setData).catch(() => {});
  }, []);
  const noRepos = data != null && data.recents.length === 0 && data.worktrees.length === 0;

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
          <DeltaMark className="mb-2 size-16" />
          <h1 className="text-[22px] font-semibold tracking-tight">delta</h1>
          <p className="mt-1 text-center text-[13px] text-muted-foreground">Review diffs. Leave structured comments for agents.</p>

          {/* Decide once data is known so neither view flashes the other on a cold
              launch: empty → the FirstRun panel; otherwise the picker (recents +
              known-repo worktrees + add-repo). While the first fetch is in flight
              (data null, cold start) hold a quiet placeholder of the same size. */}
          {data == null ? (
            <div className="mt-6 h-[54vh] w-full" aria-hidden />
          ) : noRepos ? (
            <div className="mt-6 w-full">
              <FirstRun onOpenRepo={() => void addRepo()} />
            </div>
          ) : (
            // Fixed height (not max-h) so the picker's footprint never changes with
            // the result count — the centered hero above it stays put while you
            // search. Sized to fit the min window (560px) without clipping. (#layout)
            <div className="mt-6 flex h-[54vh] w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-[13px] shadow-sm">
              <ReviewPicker onOpenReview={openReview} onOpenWorktree={openWorktree} onAddRepo={addRepo} onDeleteReview={deleteReview} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
