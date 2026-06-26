import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { rankReviews } from "./fuzzy";
import { Folder, GitBranch, MessageSquare, TriangleAlert } from "lucide-react";
import type { Registry, RepoEntry, ReviewEntry, WorktreeEntry } from "../types";

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

/** Display-only: collapse a $HOME prefix to "~". Never use the result as a path. */
function tildify(path: string, home?: string | null): string {
  if (home && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}

type Page = { kind: "root" } | { kind: "repo" } | { kind: "worktree"; repo: RepoEntry };

type Item = {
  key: string;
  leading?: ReactNode;
  primary: string;
  badge?: string;
  subtitle?: string; // second line (e.g. path) — renders a taller, two-line row
  secondary?: string; // inline secondary (single-line rows)
  meta?: ReactNode;
  dim?: boolean;
  onActivate: () => void;
  onDelete?: () => void;
};

// Mounted only while open (App conditionally renders it), so every open gets fresh
// state — no open prop, no reset effects.
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [page, setPage] = useState<Page>({ kind: "root" });
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Last real pointer position. Scrolling the list under a stationary cursor
  // fires `mousemove` with *unchanged* coordinates; we ignore those so keyboard
  // navigation doesn't get hijacked when the selected row scrolls into view (#15).
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  async function reload() {
    try {
      setRegistry(await api.listRegistry());
    } catch (e) {
      setError(String(e));
    }
  }

  // Navigate between palette pages, resetting the query + selection (event-path
  // state updates, not render/effect — keeps the React Compiler happy).
  function goto(p: Page) {
    setQuery("");
    setSel(0);
    setPage(p);
  }

  // Side effects only: load the registry once on mount, and focus the input.
  useEffect(() => {
    // Async fetch — setRegistry runs after `await`, not synchronously, so this is a
    // normal data-fetch effect, not a cascading-render anti-pattern.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    inputRef.current?.focus();
  }, [page]);

  function openReview(r: ReviewEntry) {
    void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
    onClose();
  }
  async function deleteReview(r: ReviewEntry) {
    if (!confirm(`Delete this review of ${r.repoName} · ${r.target.worktree ?? ""}?`)) return;
    try {
      await api.deleteReview(r.id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }
  async function chooseRepo(repo: RepoEntry) {
    setError(null);
    try {
      const wts = await api.listWorktrees(repo.root);
      if (wts.length <= 1) {
        const w = wts[0];
        if (w) {
          void api.openTarget(w.path, "all-changes"); // default mode; switch later in the workspace
          onClose();
        }
      } else {
        setWorktrees(wts);
        goto({ kind: "worktree", repo });
      }
    } catch (e) {
      setError(String(e));
    }
  }
  async function doImport() {
    setError(null);
    try {
      const repo = await api.importRepo();
      if (repo) {
        await reload();
        await chooseRepo(repo);
      }
    } catch (e) {
      setError(String(e));
    }
  }
  function chooseWorktree(w: WorktreeEntry) {
    void api.openTarget(w.path, "all-changes");
    onClose();
  }
  async function install() {
    setError(null);
    try {
      const outcome = await api.installCli();
      setInstallMsg(
        outcome.kind === "linked" ? `Installed at ${outcome.path}` : `${outcome.reason}\n${outcome.command}`,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  const q = query.toLowerCase();
  const match = (s: string) => q === "" || s.toLowerCase().includes(q);
  const home = registry?.home;

  // Find a saved review for a worktree so the picker can surface it (#6).
  function reviewForWorktree(repo: RepoEntry, w: WorktreeEntry): ReviewEntry | undefined {
    return registry?.reviews.find(
      (r) => r.target.repoPath === w.path || (r.repoName === repo.name && r.target.worktree === w.branch),
    );
  }

  let items: Item[] = [];
  let placeholder = "Search reviews…";

  if (page.kind === "root") {
    const reviews = registry ? rankReviews(registry.reviews, query) : [];
    items = reviews.map((r) => ({
      key: r.id,
      leading: <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />,
      primary: r.target.worktree ?? "(detached)",
      secondary: r.repoName,
      meta: (
        <span className="flex items-center gap-2.5">
          {r.commentCount > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums"><MessageSquare className="size-3.5" />{r.commentCount}</span>
          )}
          {r.staleCount > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums text-amber-500"><TriangleAlert className="size-3.5" />{r.staleCount}</span>
          )}
          <span className="whitespace-nowrap">{relTime(r.lastOpenedAt)}</span>
        </span>
      ),
      dim: r.fileCount > 0 && r.viewedCount >= r.fileCount,
      onActivate: () => openReview(r),
      onDelete: () => void deleteReview(r),
    }));
    if (match("new review")) {
      items.push({ key: "__new", primary: "＋ New review", meta: <kbd className="rounded border border-border/70 bg-muted px-1 py-0.5 text-[10px]">⌘N</kbd>, onActivate: () => goto({ kind: "repo" }) });
    }
    if (match("install delta cli")) {
      items.push({ key: "__install", primary: "Install delta CLI", dim: true, onActivate: () => void install() });
    }
  } else if (page.kind === "repo") {
    placeholder = "Pick a repository…";
    items = (registry?.repos ?? [])
      .filter((r) => match(r.name) || match(r.root))
      .map((r) => ({
        key: r.id,
        leading: <Folder className="size-4 shrink-0 text-muted-foreground" />,
        primary: r.name,
        subtitle: tildify(r.root, home),
        meta: r.worktrees.length > 1 ? <span className="whitespace-nowrap">{r.worktrees.length} worktrees</span> : undefined,
        onActivate: () => void chooseRepo(r),
      }));
    if (match("import")) {
      items.push({ key: "__import", leading: <Folder className="size-4 shrink-0 text-muted-foreground" />, primary: "Import a repository…", dim: true, onActivate: () => void doImport() });
    }
  } else {
    placeholder = `Pick a worktree in ${page.repo.name}…`;
    const repo = page.repo;
    // Most-recently-active worktree first (#1).
    const sorted = [...worktrees].sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""));
    items = sorted
      .filter((w) => match(w.branch) || match(w.path))
      .map((w) => {
        const ex = reviewForWorktree(repo, w);
        return {
          key: w.path,
          leading: <GitBranch className="size-4 shrink-0 text-muted-foreground" />,
          primary: w.branch,
          badge: w.isMain ? "main worktree" : undefined,
          subtitle: tildify(w.path, home),
          meta: (
            <span className="flex items-center gap-2.5">
              {w.dirty && (
                <span className="inline-flex items-center gap-1 text-amber-500" title="Uncommitted changes">
                  <span className="size-1.5 rounded-full bg-amber-500" /> uncommitted
                </span>
              )}
              {ex && (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5" title="Saved review">
                  {ex.commentCount > 0 && <span className="inline-flex items-center gap-1 tabular-nums"><MessageSquare className="size-3" />{ex.commentCount}</span>}
                  {ex.fileCount > 0 && <span className="tabular-nums">{ex.viewedCount} / {ex.fileCount} viewed</span>}
                </span>
              )}
              {w.lastCommitAt && <span className="whitespace-nowrap">{relTime(w.lastCommitAt)}</span>}
            </span>
          ),
          onActivate: () => chooseWorktree(w),
        };
      });
  }

  const clampedSel = items.length === 0 ? 0 : Math.min(sel, items.length - 1);

  // Keep the keyboard-selected row scrolled into view when the list overflows.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${clampedSel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [clampedSel]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[clampedSel]?.onActivate();
    } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      items[clampedSel]?.onDelete?.();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (page.kind === "root") onClose();
      else goto({ kind: "root" });
    }
  }

  // Real movement only — ignore scroll-induced mousemove (same coords) so it
  // can't override the keyboard selection mid-scroll. (#15)
  function onItemMouseMove(e: React.MouseEvent, i: number) {
    const p = lastPointer.current;
    if (p && p.x === e.clientX && p.y === e.clientY) return;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    setSel(i);
  }

  return (
    <div
      data-testid="command-palette"
      className="absolute inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[64vh] w-[40rem] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-popover text-[13px] text-popover-foreground shadow-2xl"
        onKeyDown={onKey}
      >
        <div className="relative shrink-0 border-b border-border/70">
          <input
            ref={inputRef}
            autoFocus
            className="h-11 w-full bg-transparent px-4 pr-16 text-[14px] outline-none placeholder:text-muted-foreground/70"
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border/70 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">⌘K</kbd>
        </div>
        {error && <div className="shrink-0 whitespace-pre-wrap bg-destructive/10 px-4 py-1.5 text-[12px] text-destructive">{error}</div>}
        {installMsg && (
          <div className="shrink-0 whitespace-pre-wrap bg-muted/50 px-4 py-1.5 font-mono text-[11px] text-muted-foreground">{installMsg}</div>
        )}
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-1.5">
          {items.length === 0 ? (
            <div className="px-3 py-8 text-center text-muted-foreground">{registry ? "No matches" : "Loading…"}</div>
          ) : (
            items.map((it, i) => (
              <button
                key={it.key}
                data-index={i}
                className={`flex w-full min-w-0 items-center gap-2.5 rounded-md px-3 py-2.5 text-left ${i === clampedSel ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"} ${it.dim ? "opacity-60" : ""}`}
                onMouseMove={(e) => onItemMouseMove(e, i)}
                onClick={() => it.onActivate()}
              >
                {it.leading}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 whitespace-nowrap font-medium">{it.primary}</span>
                    {it.badge && <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{it.badge}</span>}
                    {!it.subtitle && it.secondary && <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{it.secondary}</span>}
                  </div>
                  {it.subtitle && <span className="truncate text-[12px] text-muted-foreground">{it.subtitle}</span>}
                </div>
                {it.meta && <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">{it.meta}</span>}
              </button>
            ))
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4 border-t border-border/70 px-4 py-1.5 text-[11px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>⌘⌫ delete</span>
          <span>esc {page.kind === "root" ? "close" : "back"}</span>
        </div>
      </div>
    </div>
  );
}
