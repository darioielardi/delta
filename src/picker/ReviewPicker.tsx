// The shared "open a review" picker: one flat, searchable list of recent reviews +
// the current worktrees of known repos, with an "Add a repo…" action at the right
// of the search box. Mounted in two frames — the Home window and the ⌘K overlay —
// which supply their own chrome.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { rankReviews, rankWorktrees } from "./fuzzy";
import { loadPicker, peekPickerCache } from "./pickerData";
import { GitBranch, MessageSquare, TriangleAlert, FolderPlus, Folder } from "lucide-react";
import type { PickerData, PickerWorktree, ReviewEntry, Target } from "../types";

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

/** A repo chip so each row clearly shows which repository the worktree belongs to. */
function repoBadge(repoName: string): ReactNode {
  return (
    <span className="inline-flex max-w-[40%] shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Folder className="size-3 shrink-0 opacity-80" />
      <span className="truncate">{repoName}</span>
    </span>
  );
}

export interface ReviewPickerProps {
  /** Current review's target, excluded from the recents (⌘K frame). Omit on Home. */
  current?: Target;
  onOpenReview: (r: ReviewEntry) => void;
  onOpenWorktree: (w: PickerWorktree) => void;
  onAddRepo: () => void;
  onDeleteReview: (r: ReviewEntry) => void;
}

type Group = "recent" | "worktree";
type Row = { key: string; group: Group; node: ReactNode; onActivate: () => void; onDelete?: () => void };

/** Section label shown on the first row of each "recent"/"worktree" run. */
function groupLabel(g: Group): string {
  return g === "recent" ? "Recent" : "Other worktrees";
}

function recentNode(r: ReviewEntry): ReactNode {
  return (
    <>
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium">{r.target.worktree ?? "(detached)"}</span>
        {repoBadge(r.repoName)}
      </div>
      <span className="ml-auto flex shrink-0 items-center gap-2.5 whitespace-nowrap text-[11px] text-muted-foreground">
        {r.commentCount > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums"><MessageSquare className="size-3.5" />{r.commentCount}</span>
        )}
        {r.staleCount > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums text-amber-500"><TriangleAlert className="size-3.5" />{r.staleCount}</span>
        )}
        <span>{relTime(r.lastOpenedAt)}</span>
      </span>
    </>
  );
}

function worktreeNode(w: PickerWorktree): ReactNode {
  return (
    <>
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium">{w.branch}</span>
        {repoBadge(w.repoName)}
      </div>
      <span className="ml-auto flex shrink-0 items-center gap-2.5 whitespace-nowrap text-[11px] text-muted-foreground">
        {w.dirty && (
          <span className="inline-flex items-center gap-1 text-amber-500" title="Uncommitted changes">
            <span className="size-1.5 rounded-full bg-amber-500" /> uncommitted
          </span>
        )}
        {w.lastCommitAt && <span>{relTime(w.lastCommitAt)}</span>}
      </span>
    </>
  );
}

export function ReviewPicker({ current, onOpenReview, onOpenWorktree, onAddRepo, onDeleteReview }: ReviewPickerProps) {
  // Seed from the module cache so a reopen paints instantly; the effect revalidates.
  const [data, setData] = useState<PickerData | null>(() => peekPickerCache());
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Last real pointer position — ignore scroll-induced mousemove (same coords) so
  // it can't hijack keyboard selection when a row scrolls under a still cursor.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Stale-while-revalidate: cached data (if any) already rendered; refetch to update.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    void loadPicker().then(setData).catch(() => setData((d) => d ?? { recents: [], worktrees: [] }));
  }, []);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Exclude the worktree you're currently viewing — it's not a switch target. Keyed
  // on the worktree path, not mode/base: switching the diff-mode dropdown shouldn't
  // make the current review reappear in the picker.
  const isCurrentWorktree = (path: string) => current != null && path === current.repoPath;

  const recents = data ? rankReviews(data.recents.filter((r) => !isCurrentWorktree(r.target.repoPath)), query) : [];
  const worktrees = data ? rankWorktrees(data.worktrees.filter((w) => !isCurrentWorktree(w.path)), query) : [];

  const rows: Row[] = [
    ...recents.map((r): Row => ({ key: `rev-${r.id}`, group: "recent", node: recentNode(r), onActivate: () => onOpenReview(r), onDelete: () => onDeleteReview(r) })),
    ...worktrees.map((w): Row => ({ key: `wt-${w.path}`, group: "worktree", node: worktreeNode(w), onActivate: () => onOpenWorktree(w) })),
  ];
  const labels = rows.map((row, i) => (i === 0 || rows[i - 1].group !== row.group ? groupLabel(row.group) : null));

  const clampedSel = rows.length === 0 ? 0 : Math.min(sel, rows.length - 1);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${clampedSel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [clampedSel]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(rows.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[clampedSel]?.onActivate();
    } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      rows[clampedSel]?.onDelete?.();
    }
  }

  function onItemMouseMove(e: React.MouseEvent, i: number) {
    const p = lastPointer.current;
    if (p && p.x === e.clientX && p.y === e.clientY) return;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    setSel(i);
  }

  const noRepos = data != null && data.recents.length === 0 && data.worktrees.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 pr-1.5">
        <input
          ref={inputRef}
          autoFocus
          className="h-11 min-w-0 flex-1 bg-transparent px-4 text-[14px] outline-none placeholder:text-muted-foreground/70"
          placeholder="Search reviews & worktrees…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
        />
        <button
          type="button"
          onClick={onAddRepo}
          title="Add a repo…"
          aria-label="Add a repo…"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-muted/40 pl-2.5 pr-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FolderPlus className="size-3.5" /> Add repo
          <kbd className="rounded border border-border/70 bg-background/60 px-1 py-0.5 text-[10px] font-medium leading-none">⌘O</kbd>
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-1.5">
        {data == null ? (
          <div className="px-3 py-8 text-center text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {noRepos ? (
              <>No repos yet — add one above, or run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">delta</code> in a repo.</>
            ) : (
              "No matches"
            )}
          </div>
        ) : (
          rows.map((row, i) => (
            <div key={row.key}>
              {labels[i] && (
                <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{labels[i]}</div>
              )}
              <button
                data-index={i}
                className={`flex w-full min-w-0 items-center gap-2.5 rounded-md px-3 py-2.5 text-left ${i === clampedSel ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"}`}
                onMouseMove={(e) => onItemMouseMove(e, i)}
                onClick={() => row.onActivate()}
              >
                {row.node}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4 border-t border-border/70 px-4 py-1.5 text-[11px] text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>⌘⌫ delete</span>
      </div>
    </div>
  );
}
