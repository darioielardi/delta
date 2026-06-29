// The review window's empty state: shown when the current worktree has no changes for
// the selected diff mode. Instead of a bare "Nothing to review", it explains *why* and
// offers somewhere to go — the repo's other worktrees, listed like the launcher, so you
// can jump to one that has changes. Falls back to a quiet hint when there are none. (#empty-review)
import { useEffect, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { api } from "../api";
import { worktreeIdentity, worktreeMeta } from "../picker/pickerUi";
import { Kbd } from "@/components/ui/kbd";
import type { Target, WorktreeEntry } from "../types";

export function NothingToReview({ target, repoName, modeLabel }: { target: Target; repoName: string; modeLabel: string }) {
  // null = still loading (hold a quiet placeholder so the hint/list doesn't flash in).
  const [siblings, setSiblings] = useState<WorktreeEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .listWorktrees(target.repoPath)
      .then((wts) => {
        if (cancelled) return;
        // Drop the worktree we're already in; newest-committed first, undated last.
        const others = wts
          .filter((w) => w.path !== target.repoPath)
          .sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""));
        setSiblings(others);
      })
      .catch(() => {
        if (!cancelled) setSiblings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target.repoPath]);

  const branch = target.worktree;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="m-auto flex w-full max-w-md flex-col items-center px-6 py-12">
        <span className="flex size-14 items-center justify-center rounded-2xl squircle bg-muted/60 text-muted-foreground/70">
          <GitCompareArrows className="size-7" strokeWidth={1.5} />
        </span>
        <h2 className="mt-4 text-[15px] font-semibold tracking-tight text-foreground">Nothing to review</h2>
        <p className="mt-1 text-center text-[13px] text-muted-foreground">
          {branch ? (
            <>
              No changes in <span className="font-medium text-foreground/80">{branch}</span> for the {modeLabel} view.
            </>
          ) : (
            <>No changes for the {modeLabel} view.</>
          )}
        </p>

        {siblings == null ? (
          <div className="mt-6 h-10 w-full" aria-hidden />
        ) : siblings.length > 0 ? (
          <div className="mt-7 w-full">
            <div className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Other worktrees
            </div>
            <div className="rounded-xl border border-border bg-card p-1.5 shadow-sm">
              {/* Cap the visible list at 5 rows (50px each + 4px gaps = 266px) and
                  scroll past that, so a repo with many worktrees doesn't grow the card. */}
              <div className="flex max-h-[266px] flex-col gap-1 overflow-y-auto">
                {siblings.map((w) => (
                  <button
                    key={w.path}
                    type="button"
                    onClick={() => void api.openTarget(w.path, "all-changes")}
                    className="flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {worktreeIdentity(repoName, w.path, w.branch)}
                    {worktreeMeta(w)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          // No siblings: state plainly that we looked and the repo has no others, so
          // the empty screen reads as "checked everywhere", not "checked only here".
          <div className="mt-6 flex max-w-xs flex-col items-center gap-1.5 text-center">
            <p className="text-[12.5px] font-medium text-muted-foreground">This repository has no other worktrees.</p>
            <p className="text-[12px] leading-relaxed text-muted-foreground/70">
              Try a different diff mode above, or press <Kbd keys="⌘O" className="bg-background/60" /> to open another
              repository.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
