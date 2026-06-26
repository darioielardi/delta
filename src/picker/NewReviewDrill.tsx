import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { DiffMode, RepoEntry, WorktreeEntry } from "../types";

const MODES: { id: DiffMode; label: string }[] = [
  { id: "all-changes", label: "All changes" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "last-commit", label: "Last commit" },
  { id: "branch-vs-base", label: "Branch vs base" },
];

type Step = "repo" | "worktree" | "mode";

function rove(e: React.KeyboardEvent, onEscape: () => void) {
  if (e.key === "Escape") {
    e.preventDefault();
    onEscape();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-item]"));
  const idx = items.findIndex((el) => el === document.activeElement);
  const next = e.key === "ArrowDown" ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
  items[next < 0 ? 0 : next]?.focus();
}

export function NewReviewDrill({
  repos,
  onClose,
  onReposChanged,
}: {
  repos: RepoEntry[];
  onClose: () => void;
  onReposChanged: () => void;
}) {
  const [step, setStep] = useState<Step>("repo");
  const [repo, setRepo] = useState<RepoEntry | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [worktree, setWorktree] = useState<WorktreeEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>("button[data-item]")?.focus();
  }, [step]);

  async function pickRepo(r: RepoEntry) {
    setError(null);
    setRepo(r);
    try {
      const wts = await api.listWorktrees(r.root);
      setWorktrees(wts);
      if (wts.length === 1) {
        setWorktree(wts[0]);
        setStep("mode");
      } else {
        setStep("worktree");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function doImport() {
    setError(null);
    try {
      const r = await api.importRepo();
      if (r) {
        onReposChanged();
        await pickRepo(r);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function pickWorktree(w: WorktreeEntry) {
    setWorktree(w);
    setStep("mode");
  }

  async function pickMode(mode: DiffMode) {
    if (!worktree) return;
    setError(null);
    try {
      await api.openTarget(worktree.path, mode);
      await api.hidePicker();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div
      data-testid="new-review-drill"
      className="absolute inset-0 z-10 flex items-start justify-center bg-background/80 pt-16 backdrop-blur-sm"
    >
      <div className="w-[34rem] overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5 text-[12px] font-medium text-muted-foreground">
          <span>
            New review{repo ? ` · ${repo.name}` : ""}
            {step === "mode" && worktree ? ` · ${worktree.branch}` : ""}
          </span>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>
            Cancel
          </button>
        </div>
        {error && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-[12px] text-destructive">
            {error}
          </div>
        )}
        <div ref={listRef} className="max-h-80 overflow-auto p-1.5" onKeyDown={(e) => rove(e, onClose)}>
          {step === "repo" && (
            <div data-testid="drill-repos" className="flex flex-col">
              {repos.map((r) => (
                <button
                  key={r.id}
                  data-item
                  className="flex items-baseline gap-2 rounded-md px-3 py-2 text-left text-[13px] hover:bg-muted focus:bg-muted focus:outline-none"
                  onClick={() => void pickRepo(r)}
                >
                  <span className="font-medium">{r.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{r.root}</span>
                </button>
              ))}
              <button
                data-item
                data-testid="drill-import"
                className="rounded-md px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-muted focus:bg-muted focus:outline-none"
                onClick={() => void doImport()}
              >
                Import…
              </button>
            </div>
          )}
          {step === "worktree" && (
            <div data-testid="drill-worktrees" className="flex flex-col">
              {worktrees.map((w) => (
                <button
                  key={w.path}
                  data-item
                  className="flex items-baseline gap-2 rounded-md px-3 py-2 text-left text-[13px] hover:bg-muted focus:bg-muted focus:outline-none"
                  onClick={() => pickWorktree(w)}
                >
                  <span className="font-medium">{w.branch}</span>
                  {w.isMain && <span className="text-[11px] text-muted-foreground">main worktree</span>}
                  <span className="truncate text-[11px] text-muted-foreground">{w.path}</span>
                </button>
              ))}
            </div>
          )}
          {step === "mode" && (
            <div data-testid="drill-modes" className="flex flex-col">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  data-item
                  className="rounded-md px-3 py-2 text-left text-[13px] hover:bg-muted focus:bg-muted focus:outline-none"
                  onClick={() => void pickMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
