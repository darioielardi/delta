// The shared "open a review" picker: one flat, searchable list of recent reviews +
// the current worktrees of known repos + an "Add a repo…" action. Mounted in two
// frames — the Home window and the ⌘K overlay — which supply their own chrome.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { rankReviews, rankWorktrees } from "./fuzzy";
import { GitBranch, MessageSquare, TriangleAlert, FolderPlus } from "lucide-react";
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

export interface ReviewPickerProps {
  /** Current review's target, excluded from the recents (⌘K frame). Omit on Home. */
  current?: Target;
  onOpenReview: (r: ReviewEntry) => void;
  onOpenWorktree: (w: PickerWorktree) => void;
  onAddRepo: () => void;
  onDeleteReview: (r: ReviewEntry) => void;
}

type Group = "recent" | "worktree" | "action";
type Row = { key: string; group: Group; node: ReactNode; onActivate: () => void; onDelete?: () => void };

/** Section label shown on the first row of each "recent"/"worktree" run. */
function groupLabel(g: Group): string | null {
  return g === "recent" ? "Recent" : g === "worktree" ? "Other worktrees" : null;
}

function recentNode(r: ReviewEntry): ReactNode {
  return (
    <>
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 whitespace-nowrap font-medium">{r.target.worktree ?? "(detached)"}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{r.repoName}</span>
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
        <span className="shrink-0 whitespace-nowrap font-medium">{w.branch}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{w.repoName}</span>
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
  const [data, setData] = useState<PickerData | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Last real pointer position — ignore scroll-induced mousemove (same coords) so
  // it can't hijack keyboard selection when a row scrolls under a still cursor.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Async fetch — setState runs after await, a normal data-fetch effect.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    void (async () => {
      try {
        setData(await api.listPicker());
      } catch {
        setData({ recents: [], worktrees: [] });
      }
    })();
  }, []);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isCurrent = (r: ReviewEntry) =>
    current != null &&
    r.target.repoPath === current.repoPath &&
    r.target.mode === current.mode &&
    (r.target.base ?? null) === (current.base ?? null);

  const recents = data ? rankReviews(data.recents.filter((r) => !isCurrent(r)), query) : [];
  const worktrees = data ? rankWorktrees(data.worktrees, query) : [];

  const rows: Row[] = [
    ...recents.map((r): Row => ({ key: `rev-${r.id}`, group: "recent", node: recentNode(r), onActivate: () => onOpenReview(r), onDelete: () => onDeleteReview(r) })),
    ...worktrees.map((w): Row => ({ key: `wt-${w.path}`, group: "worktree", node: worktreeNode(w), onActivate: () => onOpenWorktree(w) })),
    {
      key: "__add",
      group: "action",
      node: (
        <>
          <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">Add a repo…</span>
        </>
      ),
      onActivate: onAddRepo,
    },
  ];

  // Section label on the first row of each "recent" / "worktree" run.
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

  const emptyKnown = data != null && recents.length === 0 && worktrees.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      <div className="relative shrink-0 border-b border-border/70">
        <input
          ref={inputRef}
          autoFocus
          className="h-11 w-full bg-transparent px-4 text-[14px] outline-none placeholder:text-muted-foreground/70"
          placeholder="Search reviews & worktrees…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
        />
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-1.5">
        {data == null ? (
          <div className="px-3 py-8 text-center text-muted-foreground">Loading…</div>
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
        {emptyKnown && (
          <div className="px-3 pb-3 pt-1 text-center text-[12px] text-muted-foreground">
            No repos yet — add one above, or run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">delta</code> in a repo.
          </div>
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
