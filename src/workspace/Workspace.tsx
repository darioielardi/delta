// src/workspace/Workspace.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { FilesPanel } from "../files/FilesPanel";
import { flattenTreeFiles } from "../files/buildTree";
import { DiffPane } from "../diff/DiffPane";
import { VirtualDiffPane } from "../diff/VirtualDiffPane";
import { useDiffRenderer } from "../diff/useDiffRenderer";
import { CommentIndex } from "../review/CommentIndex";
import { useReview } from "../review/useReview";
import { useResolvedTheme } from "../theme";
import { useDiffLayout } from "../diff/useDiffLayout";
import { ArrowRight, Check, ChevronDown, CircleAlert, Columns2, Copy, GitBranch, MessageSquare, Rows2, Search, Settings } from "lucide-react";
import type { Anchor, Comment, DiffMode, DiffSummary, Review, Target } from "../types";

const MODES: { id: DiffMode; label: string }[] = [
  { id: "all-changes", label: "All changes" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "last-commit", label: "Last commit" },
  { id: "branch-vs-base", label: "Branch vs base" },
];

// Keep the URL's `mode` param in sync so a window reload restores the current
// mode. (Fresh opens from the picker restore the review's persisted last mode.)
function syncModeParam(next: DiffMode) {
  const u = new URL(window.location.href);
  u.searchParams.set("mode", next);
  window.history.replaceState(null, "", u);
}

// A content signature of what the diff UI renders, so auto-refresh can skip
// state churn when a filesystem event didn't actually change anything. (#9)
function reviewSig(s: DiffSummary | null, r: Review | null): string {
  return JSON.stringify({
    files: s?.files,
    base: s?.baseLabel,
    head: s?.headLabel,
    // OIDs only — `capturedAt` churns every refresh and would defeat the skip.
    oids: r ? [r.snapshot.baseOid, r.snapshot.headOid] : null,
    stale: r?.comments?.map((c) => [c.id, c.stale]),
    viewed: r?.viewed,
  });
}

export function Workspace({ target, onOpenPalette, onOpenSettings }: { target: Target; onOpenPalette?: () => void; onOpenSettings?: () => void }) {
  const theme = useResolvedTheme();
  const [layout, setLayout] = useDiffLayout();
  const [diffRenderer] = useDiffRenderer();
  // Diff mode is local, controlled state seeded once from the URL-derived target.
  // syncModeParam keeps the URL in sync on every change, so target.mode never
  // diverges from diffMode — the stale-prop case this rule guards can't occur.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [diffMode, setDiffMode] = useState<DiffMode>(target.mode);
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [repoName, setRepoName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [indexOpen, setIndexOpen] = useState(false);
  // Jump target for the diff pane. `n` is a nonce so re-selecting the same
  // file/comment still re-fires the scroll effect; `commentId` lets the pane
  // scroll to the exact comment, not just the file top.
  const [jump, setJump] = useState<{ file: string; commentId?: string; n: number } | null>(null);
  // The file currently at the top of the diff viewport (scroll-spy → tree). (#r3)
  const [visibleFile, setVisibleFile] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // DiffPane registers its prefetch fn here; the tree calls it on hover. (#perf)
  // The ref lives here (not passed down for the child to mutate) so the child
  // registers through a stable setter instead of writing to a prop.
  const prefetchRef = useRef<((path: string) => void) | null>(null);
  const registerPrefetch = useCallback((fn: ((path: string) => void) | null) => { prefetchRef.current = fn; }, []);

  const { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed } = useReview(null);

  // Auto-refresh plumbing (#9): reviewRef lets the once-mounted fs-watcher
  // listener always refresh the *current* review; sigRef skips no-op state
  // churn; diffInval is the bump-able reload signal handed to the diff pane.
  const reviewRef = useRef(review);
  const sigRef = useRef("");
  const invalNonce = useRef(0);
  const [diffInval, setDiffInval] = useState<{ paths: string[] | null; n: number } | null>(null);
  // Keep reviewRef current via an effect (not during render — the compiler
  // forbids ref writes in render, and the listener only reads it on fs events).
  useEffect(() => {
    reviewRef.current = review;
  }, [review]);

  async function open() {
    try {
      setError(null);
      const session = await api.openReview({ repoPath: target.repoPath, mode: diffMode, base: target.base });
      setReview(session.review);
      setSummary(session.summary);
      setRepoName(session.repoName);
      sigRef.current = reviewSig(session.summary, session.review);
    } catch (e) {
      setError(String(e));
      setSummary(null);
      setReview(null);
    }
  }

  useEffect(() => {
    // Async bootstrap — openReview setState happens after `await`, not synchronously;
    // standard fetch-on-target-change, not a cascading-render anti-pattern.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.repoPath, diffMode, target.base]);

  // Recompute the diff + reconcile comments, updating UI state only when content
  // actually changed, and tell the diff pane which files to reload. `which` is
  // "all" (base shifted) or the specific changed paths. (#9)
  async function doRefresh(which: "all" | string[]) {
    const cur = reviewRef.current;
    if (!cur) return;
    try {
      const session = await api.refreshReview(cur);
      const sig = reviewSig(session.summary, session.review);
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setReview(session.review);
        setSummary(session.summary);
        setRepoName(session.repoName);
      }
      setDiffInval({ paths: which === "all" ? null : which, n: ++invalNonce.current });
    } catch (e) {
      setError(String(e));
    }
  }

  // Live auto-refresh: the backend watches this worktree and emits `fs:changed`
  // with the changed paths (or a git-meta flag) — re-diff in place, no button. (#9)
  useEffect(() => {
    if (import.meta.env.VITE_MOCK_IPC) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const un = await listen<{ paths: string[]; gitMeta: boolean }>("fs:changed", (e) => {
          void doRefresh(e.payload.gitMeta ? "all" : e.payload.paths);
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        /* not running under Tauri */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flashCopy(state: "ok" | "err") {
    setCopyState(state);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState("idle"), 1800);
  }

  async function copyForClaude() {
    if (!review) return;
    try {
      setError(null);
      const md = await api.exportReview(review);
      await navigator.clipboard.writeText(md);
      flashCopy("ok");
    } catch (e) {
      setError(String(e));
      flashCopy("err");
    }
  }

  // Stable handler identities so FilesPanel/DiffPane/CommentIndex keep their
  // memoization — otherwise toggling the comments pane (Workspace state) would
  // hand DiffPane new callbacks and re-render every mounted file section.
  const onSelectFile = useCallback((p: string) => setJump({ file: p, n: Date.now() }), []);
  // Hover-prefetch: the tree calls this when the pointer rests on a file row; the
  // diff pane builds that file's model ahead of the click so opening is instant.
  // Routed through a ref (filled by DiffPane) so hovering never re-renders the
  // pane. (#perf)
  const onPrefetch = useCallback((p: string) => prefetchRef.current?.(p), []);
  const onVisibleFileChange = useCallback((p: string) => setVisibleFile(p), []);
  const onToggleViewedFile = useCallback((file: string) => toggleViewed(file, ""), [toggleViewed]);
  const onAddComment = useCallback(
    (anchor: Anchor, body: string) => addComment(anchor.endLine != null ? "range" : "line", anchor, body),
    [addComment],
  );
  const onAddFileComment = useCallback(
    (file: string, body: string) =>
      addComment("file", { file, side: "new", startLine: null, endLine: null, snippet: null }, body),
    [addComment],
  );
  // Inset panel stays open so the user can move between comments.
  const onJump = useCallback((c: Comment) => {
    if (c.anchor?.file) setJump({ file: c.anchor.file, commentId: c.id, n: Date.now() });
  }, []);

  // Stable across renders unless `viewed` actually changes — so toggling the
  // comments pane (or any unrelated Workspace state) doesn't hand DiffPane a new
  // Set and force the whole diff to re-render. (A new Set() here was making every
  // pane open/close re-render all mounted file sections.)
  const viewedFiles = useMemo(
    () => new Set((review?.viewed ?? []).map((v) => v.file)),
    [review?.viewed],
  );
  const comments = review?.comments ?? [];
  // General notes were removed; ignore any legacy ones in the count/export gate.
  const commentCount = comments.filter((c) => c.scope !== "general").length;
  // One canonical order — the tree's depth-first order — so the files list and
  // the diff pane match the tree instead of raw git order. (#3)
  const orderedFiles = flattenTreeFiles(summary?.files ?? []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "2" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIndexOpen((o) => !o);
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        // The diff auto-refreshes; `r` stays as a manual force-reload. (#9)
        const tag = document.activeElement?.tagName ?? "";
        const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
        if (!typing) void doRefresh("all");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  return (
    <div data-testid="app-root" className="flex h-screen flex-col overflow-hidden bg-background text-[13px] text-foreground">
      {/* Overlay titlebar: the macOS traffic lights float over the top-left, so
          inset the controls past them and make the bar a drag region. */}
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 pl-24 pr-3">
        <button
          type="button"
          onClick={onOpenPalette}
          title="Open command palette (⌘K)"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-muted/40 px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Search className="size-3.5 text-muted-foreground" />
          {repoName || target.repoPath.split("/").filter(Boolean).pop()}
          {review?.target.worktree ? (
            <span className="ml-0.5 flex items-center gap-1 font-normal text-muted-foreground">
              <GitBranch className="size-3" />
              {review.target.worktree}
            </span>
          ) : null}
        </button>
        {summary && (
          <>
            <div className="relative ml-1">
              <select
                aria-label="Diff mode"
                value={diffMode}
                onChange={(e) => { const next = e.target.value as DiffMode; setDiffMode(next); syncModeParam(next); }}
                className="h-7 appearance-none rounded-md border border-input bg-muted/40 pl-2.5 pr-7 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus:bg-background"
              >
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            <span className="flex items-center gap-1 rounded-lg squircle bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
              {summary.baseLabel}
              <ArrowRight className="size-3 opacity-50" />
              {summary.headLabel}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <ToggleGroup
                type="single"
                size="sm"
                value={layout}
                onValueChange={(v) => v && setLayout(v as "unified" | "split")}
                className="gap-0.5 rounded-md bg-muted/70 p-0.5"
              >
                <ToggleGroupItem value="unified" aria-label="Unified" title="Unified view" className="size-6 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"><Rows2 className="size-3.5" /></ToggleGroupItem>
                <ToggleGroupItem value="split" aria-label="Split" title="Split view" className="size-6 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"><Columns2 className="size-3.5" /></ToggleGroupItem>
              </ToggleGroup>
              <Button size="sm" variant="ghost" aria-label={`Comments (${commentCount})`} aria-pressed={indexOpen} className="h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground aria-pressed:text-foreground" onClick={() => setIndexOpen((o) => !o)}>
                <MessageSquare className="size-4" /> {commentCount}
              </Button>
              <Button
                size="sm"
                className="h-7 min-w-[9.5rem] justify-center gap-1.5 px-3 text-[13px] transition-colors"
                style={
                  copyState === "ok"
                    ? { backgroundColor: "#059669", color: "#fff" }
                    : copyState === "err"
                      ? { backgroundColor: "var(--destructive)", color: "#fff" }
                      : undefined
                }
                onClick={copyForClaude}
                disabled={commentCount === 0}
                title={commentCount === 0 ? "No comments to copy" : undefined}
              >
                {copyState === "ok" ? (
                  <><Check className="size-3.5" /> Copied</>
                ) : copyState === "err" ? (
                  <><Copy className="size-3.5" /> Failed</>
                ) : (
                  <><Copy className="size-3.5" /> Copy for agents</>
                )}
              </Button>
            </div>
          </>
        )}
        {/* Settings sits last on the right; the spacer keeps it edge-aligned even
            before the summary (and its toolbar) has loaded. (#5) */}
        {!summary && <div className="ml-auto" />}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings (⌘,)"
          aria-label="Settings"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Settings className="size-4" />
        </button>
      </header>
      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{error}</div>
      )}
      <div className="flex min-h-0 flex-1">
        {summary && review ? (
          <>
            <aside className="flex w-80 min-h-0 shrink-0 flex-col border-r border-border/70 bg-muted/20">
              <FilesPanel
                files={orderedFiles}
                selected={visibleFile}
                onSelect={onSelectFile}
                onPrefetch={onPrefetch}
                viewedFiles={viewedFiles}
                onToggleViewed={onToggleViewedFile}
              />
            </aside>
            <main className="min-h-0 min-w-0 flex-1">
              {diffRenderer === "virtual" ? (
                <VirtualDiffPane
                  target={review.target}
                  files={orderedFiles}
                  theme={theme}
                  layout={layout}
                  viewedFiles={viewedFiles}
                  comments={comments}
                  jump={jump}
                  onVisibleFileChange={onVisibleFileChange}
                  onToggleViewed={onToggleViewedFile}
                  onAddComment={onAddComment}
                  onAddFileComment={onAddFileComment}
                  onEditComment={updateCommentBody}
                  onDeleteComment={deleteComment}
                />
              ) : (
                <DiffPane
                  target={review.target}
                  files={orderedFiles}
                  comments={comments}
                  viewedFiles={viewedFiles}
                  theme={theme}
                  layout={layout}
                  jump={jump}
                  invalidate={diffInval}
                  registerPrefetch={registerPrefetch}
                  onVisibleFileChange={onVisibleFileChange}
                  onToggleViewed={onToggleViewedFile}
                  onAddComment={onAddComment}
                  onAddFileComment={onAddFileComment}
                  onEditComment={updateCommentBody}
                  onDeleteComment={deleteComment}
                />
              )}
            </main>
            <CommentIndex
              open={indexOpen}
              onOpenChange={setIndexOpen}
              comments={comments}
              onJump={onJump}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
            {error ? (
              <div className="flex flex-col items-center gap-3">
                <CircleAlert className="size-6 text-destructive/80" />
                <p className="text-[13px]">Couldn’t open this review.</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="flex size-12 select-none items-center justify-center rounded-2xl squircle bg-gradient-to-br from-primary to-primary/70 text-[22px] font-semibold leading-none text-primary-foreground shadow-lg shadow-primary/25">
                  Δ
                </div>
                <div className="flex flex-col items-center gap-2.5">
                  <span className="text-[13px]">Computing delta…</span>
                  <div className="relative h-1 w-32 overflow-hidden rounded-full bg-muted">
                    <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary/70 [animation:delta-indeterminate_1.1s_ease-in-out_infinite]" />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
