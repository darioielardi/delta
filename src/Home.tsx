// Launch window: a borderless, centered launcher — recent sessions + import.
// No command palette here — ⌘K is a review-window affordance (App only binds it
// on the review route). The macOS traffic lights float over the top-left; the
// top strip is an invisible drag region (no header chrome, no border). (#8)
import { useEffect, useState } from "react";
import { api } from "./api";
import { rankReviews } from "./picker/fuzzy";
import { FolderPlus, GitBranch, MessageSquare, Settings, TriangleAlert } from "lucide-react";
import type { Registry, ReviewEntry } from "./types";

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function Home({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Async data fetch on mount — standard, not a cascading-render effect.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    void (async () => {
      try {
        setRegistry(await api.listRegistry());
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const reviews = registry ? rankReviews(registry.reviews, "") : [];

  function openReview(r: ReviewEntry) {
    void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
  }

  async function importRepo() {
    setError(null);
    try {
      const repo = await api.importRepo();
      if (!repo) return;
      const wts = await api.listWorktrees(repo.root);
      const main = wts.find((w) => w.isMain) ?? wts[0];
      if (main) void api.openTarget(main.path, "all-changes");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div data-testid="home-root" className="relative flex h-screen flex-col bg-background text-foreground">
      {/* Invisible drag strip so the floating traffic lights have a drag area and
          centered content never sits under them. No border, no title. */}
      <div data-tauri-drag-region className="h-11 shrink-0" />

      {/* Settings has no header to live in, so float it top-right. (#5/#8) */}
      <button
        type="button"
        onClick={onOpenSettings}
        title="Settings (⌘,)"
        aria-label="Settings"
        className="absolute right-3 top-2.5 z-10 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Settings className="size-4" />
      </button>

      <main className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 pb-12">
        <div className="flex w-full max-w-md flex-col items-center">
          {/* Wordmark + tagline */}
          <h1 className="text-[28px] font-semibold tracking-tight">delta</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Review diffs. Leave structured comments for agents.</p>

          {/* Primary action — big and unmissable. */}
          <button
            type="button"
            onClick={() => void importRepo()}
            className="squircle mt-7 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground shadow-sm transition-[filter,transform] hover:brightness-110 active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <FolderPlus className="size-4" /> Import repository…
          </button>

          {error && (
            <div className="mt-4 w-full whitespace-pre-wrap rounded-lg bg-destructive/10 px-3 py-2 text-center text-[12px] text-destructive">
              {error}
            </div>
          )}

          {/* Recent sessions */}
          {reviews.length > 0 ? (
            <div className="mt-9 w-full">
              <div className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent</div>
              <div className="flex flex-col gap-0.5">
                {reviews.map((r) => {
                  const done = r.fileCount > 0 && r.viewedCount >= r.fileCount;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => openReview(r)}
                      className={`group flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60 ${done ? "opacity-55" : ""}`}
                    >
                      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium">{r.target.worktree ?? "(detached)"}</span>
                        <span className="truncate text-[12px] text-muted-foreground">{r.repoName}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
                        {r.commentCount > 0 && (
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <MessageSquare className="size-3.5" /> {r.commentCount}
                          </span>
                        )}
                        {r.staleCount > 0 && (
                          <span className="inline-flex items-center gap-1 tabular-nums text-amber-500">
                            <TriangleAlert className="size-3.5" /> {r.staleCount}
                          </span>
                        )}
                        <span className="whitespace-nowrap">{relTime(r.lastOpenedAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="mt-9 text-[13px] text-muted-foreground">{registry ? "No recent sessions yet." : "Loading…"}</p>
          )}
        </div>
      </main>
    </div>
  );
}
