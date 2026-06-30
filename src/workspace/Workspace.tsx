// src/workspace/Workspace.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Kbd } from "@/components/ui/kbd";
import { DeltaMark } from "@/components/DeltaMark";
import { CliInstallButton } from "./CliInstallButton";
import { NothingToReview } from "./NothingToReview";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { FilesPanel } from "../files/FilesPanel";
import { flattenTreeFiles } from "../files/buildTree";
import { VirtualDiffPane } from "../diff/VirtualDiffPane";
import { CommentIndex } from "../review/CommentIndex";
import { prefetchPicker } from "../picker/pickerData";
import { useReview } from "../review/useReview";
import { useResolvedTheme } from "../theme";
import { useDiffLayout } from "../diff/useDiffLayout";
import { useResizableWidth, usePaneResize, PaneResizer, FILE_PANE } from "../lib/resizablePane";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Columns2, Copy, ExternalLink, GitBranch, MessageSquare, RefreshCw, Rows2, Search, Settings } from "lucide-react";
import { getEditorPref } from "../editor";
import { worktreeName } from "../lib/utils";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuCheck,
} from "@/components/ui/dropdown-menu";
import type { Anchor, Comment, CommitMeta, DiffMode, DiffSummary, Review, ReviewSession, Target } from "../types";

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

// Commit mode is a display overlay on top of the canonical mode, so it carries its
// own `commit` URL param (the canonical `mode` param stays put) — a reload restores it.
function syncCommitParam(oid: string | null) {
  const u = new URL(window.location.href);
  if (oid) u.searchParams.set("commit", oid);
  else u.searchParams.delete("commit");
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
  // Resizable, persisted file panel; the divider lives on its right edge.
  const [sidebarWidth, setSidebarWidth] = useResizableWidth(FILE_PANE);
  const fileResize = usePaneResize(FILE_PANE, sidebarWidth, setSidebarWidth, "right");
  // Diff mode is local, controlled state seeded once from the URL-derived target.
  // syncModeParam keeps the URL in sync on every change, so target.mode never
  // diverges from diffMode — the stale-prop case this rule guards can't occur.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [diffMode, setDiffMode] = useState<DiffMode>(target.mode === "commit" ? "branch-vs-base" : target.mode);
  // Commit mode overlay: `commitOid` pins a commit; the review stays on the canonical
  // `diffMode`. `commits` powers the submenu + stepper; `commitSummary` is the pinned diff.
  const [commitOid, setCommitOid] = useState<string | null>(target.commit ?? null);
  const [commits, setCommits] = useState<CommitMeta[]>([]);
  const [commitSummary, setCommitSummary] = useState<DiffSummary | null>(null);
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

  const { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed, toggleResolved } = useReview(null);

  // Auto-refresh plumbing (#9): reviewRef lets the once-mounted fs-watcher
  // listener always refresh the *current* review; sigRef skips no-op state
  // churn; diffInval is the bump-able reload signal handed to the diff pane.
  const reviewRef = useRef(review);
  const summaryRef = useRef(summary);
  const sigRef = useRef("");
  const invalNonce = useRef(0);
  const [diffInval, setDiffInval] = useState<{ paths: string[] | null; n: number } | null>(null);
  // A detected-but-not-applied change to the diff. We never mutate the displayed
  // diff under the user; instead we stash the re-diffed session + the changed
  // paths and surface a Refresh button. Applying it is always explicit. (#12)
  const pendingRef = useRef<{ session: ReviewSession; paths: string[] | null } | null>(null);
  const [pendingRefresh, setPendingRefresh] = useState(false);
  // Keep reviewRef/summaryRef current via an effect (not during render — the
  // compiler forbids ref writes in render, and the listener only reads them on
  // fs events).
  useEffect(() => {
    reviewRef.current = review;
    summaryRef.current = summary;
  }, [review, summary]);

  // Warm the ⌘K picker cache once the review window is up, so the first open is
  // instant (the picker's live worktree enumeration is the slow part).
  useEffect(() => {
    prefetchPicker();
  }, []);

  async function open() {
    try {
      setError(null);
      const session = await api.openReview({ repoPath: target.repoPath, mode: diffMode, base: target.base });
      setReview(session.review);
      setSummary(session.summary);
      setRepoName(session.repoName);
      sigRef.current = reviewSig(session.summary, session.review);
      pendingRef.current = null;
      setPendingRefresh(false);
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

  // The branch's commits power the "Commit ▸" submenu + the stepper. Reloaded on
  // open/refresh (snapshot move) so new commits appear. Best-effort: failure empties it.
  useEffect(() => {
    if (!review) return;
    let cancelled = false;
    void api.listCommits(review.target).then(
      (cs) => { if (!cancelled) setCommits(cs); },
      () => { if (!cancelled) setCommits([]); },
    );
    return () => { cancelled = true; };
    // capturedAt changes on every reconcile, so the submenu refreshes after a commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.target.repoPath, review?.target.base, review?.snapshot.capturedAt]);

  // Commit mode is a display overlay: fetch the pinned commit's isolated diff without
  // touching the persisted review (so untagged comments never re-anchor to one commit).
  // Stepping re-fires via commitOid.
  useEffect(() => {
    // Only fetch when pinned. When not in commit mode `viewSummary` uses `summary`,
    // so a leftover `commitSummary` is never shown — no need to reset it here (a
    // synchronous reset would force an extra render with stale UI between commits).
    if (!review || !commitOid) return;
    let cancelled = false;
    const vt: Target = { ...review.target, mode: "commit", commit: commitOid };
    void api.computeDiff(vt).then(
      (s) => { if (!cancelled) setCommitSummary(s); },
      (e) => { if (!cancelled) setError(String(e)); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitOid, review?.target.repoPath, review?.target.base]);

  // A filesystem change fired: re-diff in the background but DON'T touch the
  // displayed diff. If the result differs from what's on screen (structure via
  // the signature, or a changed file we're showing, or a base/HEAD move), stash
  // it and flip on the Refresh button. Genuine no-ops are ignored. (#12)
  async function onFsChanged(paths: string[], gitMeta: boolean) {
    const cur = reviewRef.current;
    if (!cur) return;
    try {
      const session = await api.refreshReview(cur);
      const sig = reviewSig(session.summary, session.review);
      const shown = new Set((summaryRef.current?.files ?? []).map((f) => f.path));
      const touches = gitMeta || paths.some((p) => shown.has(p));
      if (sig === sigRef.current && !touches) return; // nothing we display changed
      // Merge the changed scope with any already-pending one (null === reload all).
      const prev = pendingRef.current?.paths;
      const incoming: string[] | null = gitMeta ? null : paths.filter((p) => shown.has(p));
      const merged: string[] | null =
        prev === null || incoming === null ? null : Array.from(new Set([...(prev ?? []), ...incoming]));
      pendingRef.current = { session, paths: merged };
      setPendingRefresh(true);
    } catch (e) {
      setError(String(e));
    }
  }

  // Apply the stashed change: swap in the re-diffed session and reload the
  // affected file diffs. The only path that mutates the displayed diff. (#12)
  function applyRefresh() {
    const p = pendingRef.current;
    if (!p) return;
    sigRef.current = reviewSig(p.session.summary, p.session.review);
    setReview(p.session.review);
    setSummary(p.session.summary);
    setRepoName(p.session.repoName);
    setDiffInval({ paths: p.paths, n: ++invalNonce.current });
    pendingRef.current = null;
    setPendingRefresh(false);
  }

  // Manual force-reload (the `r` key): re-diff now and apply immediately,
  // reloading every mounted file. Clears any pending refresh. (#9/#12)
  async function forceRefresh() {
    const cur = reviewRef.current;
    if (!cur) return;
    try {
      const session = await api.refreshReview(cur);
      sigRef.current = reviewSig(session.summary, session.review);
      setReview(session.review);
      setSummary(session.summary);
      setRepoName(session.repoName);
      setDiffInval({ paths: null, n: ++invalNonce.current });
      pendingRef.current = null;
      setPendingRefresh(false);
    } catch (e) {
      setError(String(e));
    }
  }

  // The backend watches this worktree and emits `fs:changed` with the changed
  // paths (or a git-meta flag). We never mutate the displayed diff under the
  // user — instead surface a Refresh button they choose to apply. (#9/#12)
  useEffect(() => {
    if (import.meta.env.VITE_MOCK_IPC) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const un = await listen<{ paths: string[]; gitMeta: boolean }>("fs:changed", (e) => {
          void onFsChanged(e.payload.paths, e.payload.gitMeta);
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

  // A CLI invocation that targets this already-open window with an explicit
  // --mode forwards it here, so we switch in place — focusing alone would ignore
  // the requested mode. Reuses the same path as the toolbar mode switcher.
  useEffect(() => {
    if (import.meta.env.VITE_MOCK_IPC) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const un = await listen<DiffMode>("cli:set-mode", (e) => setDiffMode(e.payload));
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

  // Stable handler identities so FilesPanel/VirtualDiffPane/CommentIndex keep their
  // memoization — otherwise toggling the comments pane (Workspace state) would
  // hand the diff pane new callbacks and re-render every mounted file section.
  const onSelectFile = useCallback((p: string) => setJump({ file: p, n: Date.now() }), []);
  const onVisibleFileChange = useCallback((p: string) => setVisibleFile(p), []);
  const onToggleViewedFile = useCallback((file: string) => toggleViewed(file, ""), [toggleViewed]);
  const onAddComment = useCallback(
    (anchor: Anchor, body: string) => addComment(anchor.endLine != null ? "range" : "line", anchor, body, commitOid),
    [addComment, commitOid],
  );
  const onAddFileComment = useCallback(
    (file: string, body: string) =>
      addComment("file", { file, side: "new", startLine: null, endLine: null, snippet: null }, body, commitOid),
    [addComment, commitOid],
  );
  // Inset panel stays open so the user can move between comments.
  const onJump = useCallback((c: Comment) => {
    if (c.anchor?.file) setJump({ file: c.anchor.file, commentId: c.id, n: Date.now() });
  }, []);

  // Commit-mode navigation. "Last commit" is the same diff as the newest commit, so
  // it steps too (from HEAD / index 0); stepping back to the top returns to last-commit.
  const stepCommit = useCallback((delta: 1 | -1) => {
    const cur = commitOid != null
      ? commits.findIndex((c) => c.oid === commitOid)
      : (diffMode === "last-commit" ? 0 : -1);
    const next = cur + delta;
    if (next < 0 || next >= commits.length) return;
    if (next === 0 && diffMode === "last-commit") {
      setCommitOid(null);
      syncCommitParam(null);
    } else {
      setCommitOid(commits[next].oid);
      syncCommitParam(commits[next].oid);
    }
  }, [commits, commitOid, diffMode]);
  const pickCommit = useCallback((oid: string) => {
    setCommitOid(oid);
    syncCommitParam(oid);
  }, []);
  const exitCommitMode = useCallback((mode: DiffMode) => {
    setCommitOid(null);
    syncCommitParam(null);
    setDiffMode(mode);
    syncModeParam(mode);
  }, []);

  // Stable across renders unless `viewed` actually changes — so toggling the
  // comments pane (or any unrelated Workspace state) doesn't hand DiffPane a new
  // Set and force the whole diff to re-render. (A new Set() here was making every
  // pane open/close re-render all mounted file sections.)
  const viewedFiles = useMemo(
    () => new Set((review?.viewed ?? []).map((v) => v.file)),
    [review?.viewed],
  );
  const allComments = review?.comments ?? [];
  const inCommitMode = commitOid != null;
  const commitIndex = inCommitMode ? commits.findIndex((c) => c.oid === commitOid) : -1;
  // The stepper also shows in "Last commit" mode — it's the newest commit (index 0).
  const isLastCommit = diffMode === "last-commit";
  const stepIndex = inCommitMode ? commitIndex : (isLastCommit ? 0 : -1);
  const stepperVisible = commits.length > 0 && (inCommitMode || isLastCommit);
  // Commit mode renders the pinned commit's isolated diff over the canonical review.
  const viewTarget = useMemo<Target | undefined>(
    () => (review ? (inCommitMode ? { ...review.target, mode: "commit", commit: commitOid! } : review.target) : undefined),
    [review, inCommitMode, commitOid],
  );
  const viewSummary = inCommitMode ? commitSummary : summary;
  // Each mode-context shows its own comments: the current commit's in commit mode, the
  // untagged ones otherwise. The index + Copy still see everything (allComments).
  const comments = useMemo(
    () => (inCommitMode ? allComments.filter((c) => c.commit === commitOid) : allComments.filter((c) => !c.commit)),
    [allComments, inCommitMode, commitOid],
  );
  // General notes were removed; ignore any legacy ones. Counted over ALL comments so
  // "Copy for agents" (which exports everything) stays gated on the true total.
  const commentCount = allComments.filter((c) => c.scope !== "general").length;
  // Per-file comment counts for the tree/list badges, scoped to the visible context. (#1)
  const commentCountsByFile = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) {
      const f = c.anchor?.file;
      if (f && c.scope !== "general") m.set(f, (m.get(f) ?? 0) + 1);
    }
    return m;
  }, [comments]);
  // One canonical order — the tree's depth-first order — so the files list and
  // the diff pane match the tree instead of raw git order. (#3)
  const orderedFiles = flattenTreeFiles(viewSummary?.files ?? []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "r" || e.key === "R") && (e.metaKey || e.ctrlKey)) {
        // ⌘R re-diffs now: apply a pending change if there is one, else force a
        // full reload. preventDefault stops the webview's reload accelerator. (#9/#12)
        e.preventDefault();
        if (pendingRef.current) applyRefresh();
        else void forceRefresh();
      } else if ((e.key === "c" || e.key === "C") && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        // ⌘⇧C copies the agent export, when there's something to copy. (#copy)
        e.preventDefault();
        if (commentCount > 0) void copyForClaude();
      } else if (
        stepperVisible && !e.metaKey && !e.ctrlKey && !e.altKey &&
        // Match the physical key (e.code) so it works on non-US layouts where
        // [ and ] aren't direct keys (e.key would be a different char); keep e.key
        // as a fallback for webviews that don't report code. (#commit-by-commit)
        (e.code === "BracketLeft" || e.code === "BracketRight" || e.key === "[" || e.key === "]")
      ) {
        // …but not while typing in a comment editor.
        const el = e.target as HTMLElement | null;
        if (el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
        e.preventDefault();
        stepCommit(e.code === "BracketRight" || e.key === "]" ? 1 : -1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, stepperVisible, stepCommit]);

  return (
    <div data-testid="app-root" className="flex h-screen flex-col overflow-hidden bg-background text-[13px] text-foreground">
      {/* Overlay titlebar: the macOS traffic lights float over the top-left, so
          inset the controls past them and make the bar a drag region. */}
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-card pl-24 pr-3">
        <button
          type="button"
          onClick={onOpenPalette}
          title="Open command palette (⌘P)"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-muted/40 px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          {(() => {
            const wt = worktreeName(target.repoPath);
            const isMain = !!repoName && wt === repoName;
            return (
              <span className="flex min-w-0 items-center">
                {repoName && !isMain && (
                  <span className="flex shrink-0 items-center font-normal text-muted-foreground">
                    <span className="max-w-[14ch] truncate">{repoName}</span>
                    <span>&nbsp;/&nbsp;</span>
                  </span>
                )}
                <span className="max-w-[20ch] truncate">{isMain ? repoName : wt}</span>
              </span>
            );
          })()}
          {review?.target.worktree ? (
            <span className="ml-1 flex min-w-0 items-center gap-1 border-l border-border/70 pl-2 font-normal text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="max-w-[20ch] truncate">{review.target.worktree}</span>
            </span>
          ) : null}
          <Kbd keys="⌘P" className="ml-1" />
        </button>
        {summary && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Diff mode"
                className="ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-muted/40 pl-2.5 pr-2 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted data-[state=open]:bg-muted"
              >
                {/* Hidden reservers size the trigger to the widest possible label, so
                    its width is constant across every mode; the visible label overlays,
                    left-aligned (the chevron stays put → the stepper never shifts). */}
                <span className="grid justify-items-start">
                  {MODES.map((m) => (
                    <span key={m.id} aria-hidden className="invisible col-start-1 row-start-1 whitespace-nowrap">{m.label}</span>
                  ))}
                  <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-nowrap">Commit <span className="font-mono">0000000</span></span>
                  <span className="col-start-1 row-start-1 whitespace-nowrap">
                    {inCommitMode
                      ? <>Commit <span className="font-mono font-normal text-muted-foreground">{commits[commitIndex]?.shortOid ?? "…"}</span></>
                      : (MODES.find((m) => m.id === diffMode)?.label ?? diffMode)}
                  </span>
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {MODES.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => exitCommitMode(m.id)}>
                    <DropdownMenuCheck checked={!inCommitMode && diffMode === m.id} />
                    {m.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={commits.length === 0}>
                    <DropdownMenuCheck checked={inCommitMode} />
                    Commit
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-72 max-w-[22rem] overflow-y-auto">
                    {commits.map((c) => (
                      <DropdownMenuItem key={c.oid} onSelect={() => pickCommit(c.oid)} className="gap-2.5">
                        <span className="font-mono text-muted-foreground">{c.shortOid}</span>
                        <span className="min-w-0 truncate">{c.subject}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
            {stepperVisible && (
              <div className="ml-1 flex items-center" data-testid="commit-stepper">
                <div className="inline-flex h-7 items-center rounded-md border border-input bg-muted/40">
                  <button
                    type="button" aria-label="Previous commit" title="Previous commit ([)" disabled={stepIndex <= 0}
                    onClick={() => stepCommit(-1)}
                    className="flex h-full w-7 items-center justify-center rounded-l-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <span className="h-3.5 w-px bg-border" />
                  <button
                    type="button" aria-label="Next commit" title="Next commit (])" disabled={stepIndex < 0 || stepIndex >= commits.length - 1}
                    onClick={() => stepCommit(1)}
                    className="flex h-full w-7 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
                <span className="ml-2 font-mono tabular-nums text-[11px] text-muted-foreground">{stepIndex + 1}/{commits.length}</span>
              </div>
            )}
            <div className="ml-auto flex items-center gap-3">
              <CliInstallButton />
              {pendingRefresh && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={applyRefresh}
                  title="The diff changed on disk — click to update (⌘R)"
                  className="h-7 gap-1.5 px-2.5 text-[13px] border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-400 dark:hover:text-amber-300"
                >
                  <RefreshCw className="size-3.5" /> Refresh
                  <Kbd keys="⌘R" className="border-amber-600/30 bg-amber-500/15 text-amber-700 dark:border-amber-400/30 dark:text-amber-300" />
                </Button>
              )}
              <ToggleGroup
                type="single"
                size="sm"
                value={layout}
                onValueChange={(v) => v && setLayout(v as "unified" | "split")}
                className="gap-0.5 rounded-md bg-muted/70 p-0.5"
              >
                <ToggleGroupItem value="unified" aria-label="Unified" title="Unified view" className="size-6 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"><Rows2 className="size-3.5" /></ToggleGroupItem>
                <ToggleGroupItem value="split" aria-label="Split" title="Split view" className="size-6 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"><Columns2 className="size-3.5" /></ToggleGroupItem>
              </ToggleGroup>
              <Button size="sm" variant="outline" aria-label={`Comments (${commentCount})`} aria-pressed={indexOpen} className="h-7 gap-1.5 px-2.5 text-[13px] text-muted-foreground hover:text-foreground aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-primary dark:aria-pressed:bg-primary/10" onClick={() => setIndexOpen((o) => !o)}>
                <MessageSquare className="size-4" /> {commentCount}
              </Button>
              <Button
                size="sm"
                className="h-7 min-w-[11.75rem] justify-center gap-1.5 px-2.5 text-[13px] transition-colors"
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
                  <><Copy className="size-3.5" /> Copy for agents{commentCount > 0 && <Kbd keys="⌘⇧C" className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground/90" />}</>
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
          onClick={() => { void api.openInEditor(getEditorPref(), target.repoPath).catch((e) => setError(String(e))); }}
          title="Open repository in editor"
          aria-label="Open repository in editor"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-transparent dark:hover:bg-input/30"
        >
          <ExternalLink className="size-4" />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings (⌘,)"
          aria-label="Settings"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-transparent dark:hover:bg-input/30"
        >
          <Settings className="size-4" />
        </button>
      </header>
      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{error}</div>
      )}
      <div className="flex min-h-0 flex-1">
        {viewSummary && review ? (
          orderedFiles.length === 0 ? (
            <NothingToReview
              target={review.target}
              repoName={repoName}
              modeLabel={inCommitMode ? `commit ${commits[commitIndex]?.shortOid ?? ""}`.trim() : (MODES.find((m) => m.id === diffMode)?.label ?? diffMode)}
            />
          ) : (
          <>
            <aside style={{ width: sidebarWidth }} className="relative flex min-h-0 shrink-0 flex-col">
              <FilesPanel
                files={orderedFiles}
                selected={visibleFile}
                onSelect={onSelectFile}
                viewedFiles={viewedFiles}
                onToggleViewed={onToggleViewedFile}
                commentCounts={commentCountsByFile}
              />
              <PaneResizer edge="right" label="Resize file panel" {...fileResize} />
            </aside>
            <main className="min-h-0 min-w-0 flex-1 -ml-1.5">
              <VirtualDiffPane
                target={viewTarget!}
                files={orderedFiles}
                theme={theme}
                layout={layout}
                viewedFiles={viewedFiles}
                comments={comments}
                jump={jump}
                invalidate={diffInval}
                onVisibleFileChange={onVisibleFileChange}
                onToggleViewed={onToggleViewedFile}
                onAddComment={onAddComment}
                onAddFileComment={onAddFileComment}
                onEditComment={updateCommentBody}
                onDeleteComment={deleteComment}
                onToggleResolvedComment={toggleResolved}
              />
            </main>
            <CommentIndex
              open={indexOpen}
              onOpenChange={setIndexOpen}
              comments={allComments}
              onJump={onJump}
            />
          </>
          )
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
            {error ? (
              <div className="flex flex-col items-center gap-3">
                <CircleAlert className="size-6 text-destructive/80" />
                <p className="text-[13px]">Couldn’t open this review.</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <DeltaMark className="size-14" />
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
