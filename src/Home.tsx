// Launch window: recent sessions + import. No command palette here — ⌘K is a
// review-window affordance (App only binds it on the review route).
import { useEffect, useState } from "react";
import { api } from "./api";
import { rankReviews } from "./picker/fuzzy";
import { FolderPlus, GitBranch } from "lucide-react";
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

export function Home() {
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
    <div data-testid="home-root" className="flex h-screen flex-col bg-background text-foreground">
      {/* Overlay titlebar: inset past the macOS traffic lights, drag region. */}
      <header
        data-tauri-drag-region
        className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 pl-24 pr-3"
      >
        <span className="text-[13px] font-semibold tracking-tight">delta</span>
        <button
          type="button"
          onClick={() => void importRepo()}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 text-[13px] font-medium hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FolderPlus className="size-3.5 text-muted-foreground" /> Import…
        </button>
      </header>
      {error && (
        <div className="shrink-0 whitespace-pre-wrap bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{error}</div>
      )}
      <main className="min-h-0 flex-1 overflow-auto p-3 text-[13px]">
        {reviews.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center text-muted-foreground">
            <p>{registry ? "No recent sessions." : "Loading…"}</p>
            {registry && <p className="text-[12px]">Import a repository to get started.</p>}
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-0.5">
            <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent</div>
            {reviews.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => openReview(r)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted/60 ${r.fileCount > 0 && r.viewedCount >= r.fileCount ? "opacity-60" : ""}`}
              >
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 whitespace-nowrap font-medium">{r.target.worktree ?? "(detached)"}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{r.repoName}</span>
                <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                  {[r.commentCount ? `💬 ${r.commentCount}` : "", r.staleCount ? `⚠ ${r.staleCount}` : "", relTime(r.lastOpenedAt)]
                    .filter(Boolean)
                    .join("   ")}
                </span>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
