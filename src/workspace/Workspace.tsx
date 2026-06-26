// src/workspace/Workspace.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../api";
import { FilesPanel } from "../files/FilesPanel";
import { DiffPane } from "../diff/DiffPane";
import { CommentIndex } from "../review/CommentIndex";
import { useReview } from "../review/useReview";
import { useSystemTheme } from "../theme";
import { useDiffLayout } from "../diff/useDiffLayout";
import { ArrowRight, Check, ChevronDown, Columns2, Copy, GitBranch, MessageSquare, RefreshCw, Rows2, Search } from "lucide-react";
import type { Anchor, Comment, DiffMode, DiffSummary, Target } from "../types";

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

export function Workspace({ target, onOpenPalette }: { target: Target; onOpenPalette?: () => void }) {
  const theme = useSystemTheme();
  const [layout, setLayout] = useDiffLayout();
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
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed } = useReview(null);

  async function open() {
    try {
      setError(null);
      const session = await api.openReview({ repoPath: target.repoPath, mode: diffMode, base: target.base });
      setReview(session.review);
      setSummary(session.summary);
      setRepoName(session.repoName);
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

  async function refresh() {
    if (!review) return;
    try {
      const session = await api.refreshReview(review);
      setReview(session.review);
      setSummary(session.summary);
      setRepoName(session.repoName);
    } catch (e) {
      setError(String(e));
    }
  }

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "2" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIndexOpen((o) => !o);
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        const tag = document.activeElement?.tagName ?? "";
        const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
        if (!typing) void refresh();
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
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
                onClick={() => setLayout(layout === "unified" ? "split" : "unified")}
                title={layout === "unified" ? "Switch to split view" : "Switch to unified view"}
                aria-label="Toggle split/unified diff"
              >
                {layout === "split" ? <Columns2 className="size-4" /> : <Rows2 className="size-4" />}
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Comments (${commentCount})`} aria-pressed={indexOpen} className="h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground aria-pressed:text-foreground" onClick={() => setIndexOpen((o) => !o)}>
                <MessageSquare className="size-4" /> {commentCount}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2.5 text-[13px] text-muted-foreground hover:text-foreground" onClick={refresh}>
                <RefreshCw className="size-3.5" /> Refresh
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1.5 px-3 text-[13px] transition-colors"
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
                  <><Copy className="size-3.5" /> Copy for Claude</>
                )}
              </Button>
            </div>
          </>
        )}
      </header>
      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{error}</div>
      )}
      <div className="flex min-h-0 flex-1">
        {summary && review ? (
          <>
            <aside className="flex w-80 min-h-0 shrink-0 flex-col border-r border-border/70 bg-muted/20">
              <FilesPanel
                files={summary.files}
                selected={null}
                onSelect={onSelectFile}
                viewedFiles={viewedFiles}
                onToggleViewed={onToggleViewedFile}
              />
            </aside>
            <main className="min-h-0 min-w-0 flex-1">
              <DiffPane
                target={review.target}
                files={summary.files}
                comments={comments}
                viewedFiles={viewedFiles}
                theme={theme}
                layout={layout}
                jump={jump}
                onToggleViewed={onToggleViewedFile}
                onAddComment={onAddComment}
                onAddFileComment={onAddFileComment}
                onEditComment={updateCommentBody}
                onDeleteComment={deleteComment}
              />
            </main>
            <CommentIndex
              open={indexOpen}
              onOpenChange={setIndexOpen}
              comments={comments}
              onJump={onJump}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-muted-foreground">{error ? "Couldn’t open this review." : "Loading review…"}</p>
          </div>
        )}
      </div>
    </div>
  );
}
