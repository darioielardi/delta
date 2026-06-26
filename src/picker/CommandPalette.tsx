import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { rankReviews } from "./fuzzy";
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

type Page = { kind: "root" } | { kind: "repo" } | { kind: "worktree"; repo: RepoEntry };

type Item = {
  key: string;
  primary: string;
  badge?: string;
  secondary?: string;
  meta?: string;
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

  let items: Item[] = [];
  let placeholder = "Search reviews…";

  if (page.kind === "root") {
    const reviews = registry ? rankReviews(registry.reviews, query) : [];
    items = reviews.map((r) => ({
      key: r.id,
      primary: r.target.worktree ?? "(detached)",
      secondary: r.repoName,
      meta: [r.commentCount ? `💬 ${r.commentCount}` : "", r.staleCount ? `⚠ ${r.staleCount}` : "", relTime(r.lastOpenedAt)]
        .filter(Boolean)
        .join("   "),
      dim: r.fileCount > 0 && r.viewedCount >= r.fileCount,
      onActivate: () => openReview(r),
      onDelete: () => void deleteReview(r),
    }));
    if (match("new review")) {
      items.push({ key: "__new", primary: "＋ New review", meta: "⌘N", onActivate: () => goto({ kind: "repo" }) });
    }
    if (match("install delta cli")) {
      items.push({ key: "__install", primary: "Install delta CLI", dim: true, onActivate: () => void install() });
    }
  } else if (page.kind === "repo") {
    placeholder = "Pick a repository…";
    items = (registry?.repos ?? [])
      .filter((r) => match(r.name) || match(r.root))
      .map((r) => ({ key: r.id, primary: r.name, secondary: r.root, onActivate: () => void chooseRepo(r) }));
    if (match("import")) {
      items.push({ key: "__import", primary: "Import a repository…", dim: true, onActivate: () => void doImport() });
    }
  } else {
    placeholder = `Pick a worktree in ${page.repo.name}…`;
    items = worktrees
      .filter((w) => match(w.branch) || match(w.path))
      .map((w) => ({
        key: w.path,
        primary: w.branch,
        badge: w.isMain ? "main worktree" : undefined,
        secondary: w.path,
        onActivate: () => chooseWorktree(w),
      }));
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
                className={`flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left ${i === clampedSel ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"} ${it.dim ? "opacity-60" : ""}`}
                onMouseMove={() => setSel(i)}
                onClick={() => it.onActivate()}
              >
                <span className="shrink-0 whitespace-nowrap font-medium">{it.primary}</span>
                {it.badge && <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{it.badge}</span>}
                {it.secondary && <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{it.secondary}</span>}
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
