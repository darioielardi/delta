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
  // Keyboard selection for the recent list (-1 = nothing highlighted). (#r10)
  const [sel, setSel] = useState(-1);

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

  // Up/down move through recent items; Enter opens the highlighted one. (#r10)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = document.activeElement?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (reviews.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % reviews.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s <= 0 ? reviews.length - 1 : s - 1));
      } else if (e.key === "Enter" && sel >= 0 && sel < reviews.length) {
        e.preventDefault();
        openReview(reviews[sel]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviews.length, sel]);

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

      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 pb-12">
        <div className="flex w-full max-w-md flex-col items-center">
          {/* Brand mark + wordmark */}
          <div className="mb-5 flex size-14 select-none items-center justify-center rounded-2xl squircle bg-gradient-to-br from-primary to-primary/70 text-[28px] font-semibold leading-none text-primary-foreground shadow-lg shadow-primary/25">
            Δ
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">delta</h1>
          <p className="mt-1.5 text-center text-[13px] text-muted-foreground">
            Review diffs. Leave structured comments for agents.
          </p>

          {/* Primary action */}
          <button
            type="button"
            onClick={() => void importRepo()}
            className="squircle mt-8 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground shadow-sm shadow-primary/20 transition-[filter,transform] hover:brightness-110 active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
            <div className="mt-10 w-full">
              <div className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent</div>
              <div className="flex flex-col gap-0.5">
                {reviews.map((r, i) => {
                  const done = r.fileCount > 0 && r.viewedCount >= r.fileCount;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => openReview(r)}
                      onMouseMove={() => setSel(i)}
                      className={`group flex w-full min-w-0 items-start gap-3 rounded-xl px-3 py-2.5 text-left ${i === sel ? "bg-muted/70" : "hover:bg-muted/45"} ${done ? "opacity-55" : ""}`}
                    >
                      {/* Aligned to the branch-name line, not centered. (#r14) */}
                      <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium">{r.target.worktree ?? "(detached)"}</span>
                        <span className="truncate text-[12px] text-muted-foreground">{r.repoName}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 pt-0.5 text-[11px] text-muted-foreground">
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
              <div className="mt-3 flex items-center justify-center gap-3 text-[11px] text-muted-foreground/70">
                <span>↑↓ navigate</span>
                <span>↵ open</span>
              </div>
            </div>
          ) : (
            <p className="mt-10 text-[13px] text-muted-foreground">{registry ? "No recent sessions yet." : "Loading…"}</p>
          )}
        </div>
      </main>
    </div>
  );
}
