// src/diff/DiffPane.tsx
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronRight, Eye, FileX, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiffView } from "./DiffView";
import { useFileDiffCache } from "./useFileDiffCache";
import { CommentThread } from "../review/CommentThread";
import type { Anchor, Comment, FileEntry, Target } from "../types";
import type { DiffLayout } from "./useDiffLayout";

// Files with at least this many changed lines start collapsed.
const GIANT_CHANGED_LINES = 500;

// Fallback height for a never-yet-rendered file's diff body: px per changed line
// (measured median ~35, fit slope ~45; 42 splits it). Only seeds the scrollbar /
// skeleton / content-visibility intrinsic-size before the file has rendered once.
// Not load-bearing: once a file renders, the browser remembers its real height
// (contain-intrinsic-size: auto), so a wrong estimate just means a slightly-off
// scrollbar for unvisited files, never a scroll jump.
const EST_PER_LINE = 42;

function commentsForFile(comments: Comment[], file: string): Comment[] {
  return comments.filter((c) => c.anchor?.file === file);
}

function FileSection({
  entry, cache, comments, viewed, collapsed, theme, layout, onToggleViewed, onToggleCollapse, onAddComment, onAddFileComment, onEditComment, onDeleteComment, registerRef, requestLoad, estimateHeight, forced, prefetch,
}: {
  entry: FileEntry; cache: ReturnType<typeof useFileDiffCache>;
  comments: Comment[]; viewed: boolean; collapsed: boolean; theme: "light" | "dark"; layout: "unified" | "split";
  onToggleViewed: (file: string) => void;
  onToggleCollapse: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
  registerRef: (file: string, el: HTMLDivElement | null) => void;
  // Velocity-gated load request — see the pane's scheduler. `want` is whether
  // this section currently wants its diff built (near + expanded + not a hidden
  // deleted file). The pane defers the actual load while flinging.
  requestLoad: (path: string, want: boolean) => void;
  // Seed height for the skeleton + content-visibility intrinsic-size.
  estimateHeight: (entry: FileEntry) => number;
  // Jump target: mount this section's diff even when off-screen, so a jump can
  // land on built content (and a jump-to-comment can find the comment node).
  forced: boolean;
  // Hover-prefetch: mount this section ahead of a click so opening it is instant.
  prefetch: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Subscribe to just this file's diff. Only this section re-renders when its
  // own load resolves (or when the target resets) — not the whole pane.
  const subscribe = useCallback((cb: () => void) => cache.subscribe(entry.path, cb), [cache, entry.path]);
  const fd = useSyncExternalStore(subscribe, () => cache.get(entry.path));
  // Within ~2.7 screens of the viewport — triggers the (gated) build.
  const [near, setNear] = useState(false);
  // Latch: once the diff has been mounted we KEEP it mounted. content-visibility
  // (below) makes it cheap to leave in the DOM off-screen, and never unmounting is
  // what kills the regression where scrolling back to a file re-rendered it from a
  // skeleton. The browser, not us, skips the paint of what's off-screen.
  const [built, setBuilt] = useState(false);
  // Deleted files are hidden by default behind a reveal (their diff is just the
  // removed file). Don't load or render it until the user asks.
  const isDeleted = entry.status === "deleted";
  const [revealed, setRevealed] = useState(false);
  const fileComments = comments.filter((c) => c.scope === "file" && c.anchor?.file === entry.path);
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
  const want = !collapsed && (!isDeleted || revealed);
  // Latch built the first time we have data + a reason to show it. Done during
  // render, not via a setState effect (see react.dev "you might not need an
  // effect"): once true it sticks, so scrolling back never re-skeletons the file.
  if (!built && fd && want && (near || forced || prefetch)) setBuilt(true);

  useEffect(() => {
    registerRef(entry.path, ref.current);
    return () => registerRef(entry.path, null);
  }, [entry.path]);

  // Track viewport proximity with a ~2.7-screen margin and request the (gated)
  // load when near. Once built we no longer care about `near` for mounting, but
  // the observer stays cheap and keeps `near` honest for the build latch.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      const isNear = entries.some((e) => e.isIntersecting);
      setNear(isNear);
      requestLoad(entry.path, isNear && want);
    }, { rootMargin: "2000px 0px" });
    io.observe(el);
    return () => {
      io.disconnect();
      requestLoad(entry.path, false);
    };
  }, [entry.path, want, requestLoad]);

  // Seed height for the skeleton + intrinsic-size (real height is remembered by
  // the browser after first render).
  const estPx = estimateHeight(entry);
  const showDiff = !!fd && want && (built || near || forced || prefetch);
  return (
    <div
      ref={ref}
      data-file={entry.path}
      className="border-b border-border/70"
    >
      {/* Opaque (not bg/85 + backdrop-blur): a translucent blurred sticky header
          forces the compositor to re-rasterize + blur the code scrolling beneath
          it every frame — on a long diff that alone halved scroll FPS. Solid bg,
          no filter. */}
      <div className="group sticky top-0 z-10 flex items-center gap-1 border-b border-border/70 bg-background px-3 py-2">
        {/* Full-box collapse target: an absolutely-positioned button fills the
            header including its padding, so hover + click land anywhere in the
            box (not just over the filename). The visible content sits above it
            (pointer-events-none, so clicks fall through to the button); the
            action buttons are `relative` so they stay on top and keep their own
            clicks. Real <button> + aria-expanded preserves keyboard a11y. */}
        <button
          type="button"
          className="absolute inset-0"
          onClick={() => onToggleCollapse(entry.path)}
          aria-label={collapsed ? `expand ${entry.path}` : `collapse ${entry.path}`}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
        />
        <span className={`pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 transition-opacity ${viewed ? "opacity-55 group-hover:opacity-100" : ""}`}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors group-hover:bg-foreground/[0.06] group-hover:text-foreground">
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {dir && <span className="text-muted-foreground">{dir}</span>}
            <span className="font-medium text-foreground">{base}</span>
          </span>
        </span>
        {/* Right actions, left→right: diff counts · add file comment · mark viewed.
            Counts stay pointer-events-none so a header click still collapses. */}
        <span className={`pointer-events-none relative shrink-0 text-[12px] tabular-nums transition-opacity ${viewed ? "opacity-55 group-hover:opacity-100" : ""}`}>
          {entry.additions > 0 && <span className="text-emerald-500">+{entry.additions}</span>}{" "}
          {entry.deletions > 0 && <span className="text-rose-500">−{entry.deletions}</span>}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="relative h-7 shrink-0 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => onAddFileComment(entry.path, "")}
          aria-label={`comment on ${entry.path}`}
          title="Comment on file"
        >
          <MessageSquarePlus className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={`relative h-7 shrink-0 gap-1.5 px-2 text-[12px] ${viewed ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => onToggleViewed(entry.path)}
          aria-label={`viewed ${entry.path}`}
          aria-pressed={viewed}
          title="Mark viewed"
        >
          <span className={`flex size-4 items-center justify-center rounded-[5px] border transition-colors ${viewed ? "border-primary bg-primary text-primary-foreground" : "border-border/80"}`}>
            {viewed && <Check className="size-3" strokeWidth={3} />}
          </span>
          Viewed
        </Button>
      </div>
      {fileComments.length > 0 && (
        <div className="px-3 py-2">
          <CommentThread
            comments={fileComments}
            onEdit={onEditComment}
            onDelete={onDeleteComment}
          />
        </div>
      )}
      {!collapsed && (
        <div className="min-h-8">
          {isDeleted && !revealed ? (
            <div className="flex items-center gap-3 py-4 pl-5 pr-3 text-[13px] text-muted-foreground">
              <FileX className="size-4 shrink-0 text-rose-500/80" />
              <span>File deleted</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                onClick={() => { setRevealed(true); void cache.load(entry.path); }}
              >
                <Eye className="size-4" /> Show deleted content
              </Button>
            </div>
          ) : showDiff ? (
            // Built diff. content-visibility:auto lets the browser skip its layout
            // + paint while off-screen (the perf win windowing gave us) WITHOUT
            // unmounting it — so scrolling back is instant, never a re-skeleton.
            // contain-intrinsic-size: auto seeds the off-screen size from the
            // estimate, then remembers the real height once rendered. (#cv)
            <div className="diff-cv" style={{ ["--cv-h" as string]: `${estPx}px` } as React.CSSProperties}>
              <DiffView
                fileDiff={fd}
                filePath={entry.path}
                layout={layout}
                theme={theme}
                comments={commentsForFile(comments, entry.path)}
                onAddComment={onAddComment}
                onEditComment={onEditComment}
                onDeleteComment={onDeleteComment}
              />
            </div>
          ) : (
            // Not built yet (never reached, or a fling outran the build): a
            // skeleton at the estimated height. Shown at most once per file —
            // once built it never reverts. (#cv)
            <div aria-hidden className="diff-skeleton" style={{ minHeight: estPx }} />
          )}
        </div>
      )}
    </div>
  );
}

// memo so toggling unrelated Workspace state (e.g. the comments pane) skips the
// whole diff pane — its props are kept referentially stable by the parent.
export const DiffPane = memo(function DiffPane({
  target, files, comments, viewedFiles, theme, layout, jump, invalidate, registerPrefetch,
  onToggleViewed, onAddComment, onAddFileComment, onEditComment, onDeleteComment, onVisibleFileChange,
}: {
  target: Target; files: FileEntry[]; comments: Comment[]; viewedFiles: Set<string>;
  theme: "light" | "dark"; layout: DiffLayout; jump?: { file: string; commentId?: string; n: number } | null;
  // Auto-refresh signal: { paths: null } reloads everything, otherwise just the
  // listed files. The nonce re-fires the effect even for a repeat path set. (#9)
  invalidate?: { paths: string[] | null; n: number } | null;
  // Prefetch channel: the parent owns the ref; we register our prefetch fn
  // through this setter so the tree can call it on hover to mount a file's diff
  // ahead of the click (instant open vs a ~250ms render-on-arrival). A setter,
  // not a ref we mutate, keeps prop-mutation out of the component.
  registerPrefetch?: (fn: ((path: string) => void) | null) => void;
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
  // Scroll-spy: the file currently at the top of the viewport. (#r3)
  onVisibleFileChange?: (file: string) => void;
}) {
  const cache = useFileDiffCache(target);

  // Hover-prefetch: mount a file's diff off-screen ahead of a click so opening it
  // is instant. Rendering the table (~250ms on a big file) is the cost; doing it
  // on hover gets it out of the click path. At LOW priority so a real click/scroll
  // interrupts it — a hover never blocks interaction. One at a time; the next
  // hover replaces it. (Built files stay built via the section's latch, so a
  // hovered-then-not-clicked file simply stays mounted, which is fine.)
  const [prefetchPath, setPrefetchPath] = useState<string | null>(null);
  const prefetch = useCallback((path: string) => {
    void cache.load(path);
    startTransition(() => setPrefetchPath(path));
  }, [cache]);
  useEffect(() => {
    registerPrefetch?.(prefetch);
    return () => registerPrefetch?.(null);
  }, [registerPrefetch, prefetch]);

  // Drop + reload changed files (or all, when the base shifted) so the diff
  // tracks the working tree without a manual Refresh. (#9)
  useEffect(() => {
    if (!invalidate) return;
    if (invalidate.paths === null) cache.refreshAll();
    else cache.invalidate(invalidate.paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalidate?.n]);
  const paneRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const jumpTimer = useRef(0);
  const registerRef = (file: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(file, el);
    else sectionRefs.current.delete(file);
  };

  // Per-file seed height for the skeleton + content-visibility intrinsic-size.
  // A plain estimate from the change size — the browser remembers real heights
  // after first render, so this only sizes never-yet-rendered files.
  const estimates = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files) m.set(f.path, Math.max(120, (f.additions + f.deletions) * EST_PER_LINE));
    return m;
  }, [files]);
  const estimateHeight = useCallback((entry: FileEntry) => estimates.get(entry.path) ?? 120, [estimates]);

  // Velocity-gated diff loading. Rendering a file's diff table is the expensive
  // per-file step; firing it the instant a section crosses the IO margin means a
  // fast scroll builds every file it flies past — seconds of main-thread blocking.
  // So sections only *request* a load (near/far); the pane flushes immediately
  // while scrolling slowly or stopped, and defers while flinging so the build
  // storm never lands mid-scroll. cache.load is idempotent, so a path that scrolls
  // away before the flush is simply dropped from the wanted set.
  const wantedRef = useRef<Set<string>>(new Set());
  const velRef = useRef(0);
  const flushTimer = useRef(0);
  const buildTimer = useRef(0);
  // Drain the wanted set a couple files per tick instead of all at once, so the
  // settle band fills progressively rather than freezing in one long task.
  const flushLoads = useCallback(() => {
    clearTimeout(buildTimer.current);
    const drain = () => {
      const pane = paneRef.current;
      // Build nearest-to-viewport first so what you're looking at fills soonest.
      const center = pane ? pane.scrollTop + pane.clientHeight / 2 : 0;
      const pending = [...wantedRef.current].filter((p) => !cache.get(p));
      if (pending.length === 0) return;
      pending.sort((a, b) => {
        const ea = sectionRefs.current.get(a), eb = sectionRefs.current.get(b);
        const da = ea ? Math.abs(ea.offsetTop + ea.offsetHeight / 2 - center) : Infinity;
        const db = eb ? Math.abs(eb.offsetTop + eb.offsetHeight / 2 - center) : Infinity;
        return da - db;
      });
      for (let i = 0; i < 2 && i < pending.length; i++) void cache.load(pending[i]);
      if (pending.length > 2) buildTimer.current = window.setTimeout(drain, 24);
    };
    drain();
  }, [cache]);
  const scheduleFlush = useCallback(() => {
    clearTimeout(flushTimer.current);
    // px/ms: a read-scroll is ~0.2–0.6, a fling is several. Only a genuine fling
    // (the case that would build dozens of fly-past files at once) defers; moderate
    // scrolling builds immediately so it stays ahead of the viewport.
    flushTimer.current = window.setTimeout(flushLoads, velRef.current > 2.5 ? 120 : 0);
  }, [flushLoads]);
  const requestLoad = useCallback((path: string, want: boolean) => {
    if (want) wantedRef.current.add(path);
    else wantedRef.current.delete(path);
    scheduleFlush();
  }, [scheduleFlush]);

  // Track scroll velocity so requestLoad can tell a fling from a read-scroll, and
  // flush once motion settles (the trailing scroll events decay to low velocity).
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    let last = { t: performance.now(), top: pane.scrollTop };
    const onScroll = () => {
      const now = performance.now();
      const top = pane.scrollTop;
      const dt = now - last.t || 16;
      velRef.current = Math.abs(top - last.top) / dt;
      last = { t: now, top };
      scheduleFlush();
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      pane.removeEventListener("scroll", onScroll);
      clearTimeout(flushTimer.current);
      clearTimeout(buildTimer.current);
    };
  }, [scheduleFlush]);

  // Scroll-spy: report the file whose section sits at the top of the viewport so
  // the tree/list can highlight what you're actually looking at. Sections are in
  // file order, so the current one is the last whose top is at/above the pane
  // top. setTimeout-throttled; only fires when the file changes. (#r3)
  const lastVisible = useRef<string | null>(null);
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !onVisibleFileChange) return;
    let timer = 0;
    const compute = () => {
      timer = 0;
      const paneTop = pane.getBoundingClientRect().top;
      let current: string | null = files[0]?.path ?? null;
      for (const f of files) {
        const el = sectionRefs.current.get(f.path);
        if (!el) continue;
        if (el.getBoundingClientRect().top - paneTop <= 8) current = f.path;
        else break;
      }
      if (current && current !== lastVisible.current) {
        lastVisible.current = current;
        onVisibleFileChange(current);
      }
    };
    // setTimeout-throttled (not rAF, which pauses while the window is occluded
    // or the webview is offscreen).
    const onScroll = () => { if (!timer) timer = window.setTimeout(compute, 60); };
    pane.addEventListener("scroll", onScroll, { passive: true });
    compute();
    return () => { pane.removeEventListener("scroll", onScroll); if (timer) clearTimeout(timer); };
  }, [files, onVisibleFileChange]);

  // Collapse is independent of viewed. Explicit user choices override the
  // giant-file default; marking a file viewed collapses it (un-marking expands).
  const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});

  // The current jump target, force-mounted even when off-screen so a jump lands
  // on built content and a jump-to-comment can locate + center the comment node.
  // Only one at a time (the next jump replaces it).
  const [forcedPath, setForcedPath] = useState<string | null>(null);

  // When a file's viewed state flips (tree, list, or diff header), drop any manual
  // collapse override so the section follows viewed — collapse on view, expand on
  // un-view. Without this, jumping to a file (which sets override=false to expand
  // it) blocks the later viewed-collapse. (#1/#2/#11)
  const prevViewed = useRef(viewedFiles);
  useEffect(() => {
    const prev = prevViewed.current;
    prevViewed.current = viewedFiles;
    const flipped = files.filter((f) => viewedFiles.has(f.path) !== prev.has(f.path)).map((f) => f.path);
    if (flipped.length === 0) return;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    setCollapseOverrides((o) => {
      let changed = false;
      const n = { ...o };
      for (const p of flipped) if (p in n) { delete n[p]; changed = true; }
      return changed ? n : o;
    });
  }, [viewedFiles, files]);

  const isGiant = (e: FileEntry) => e.additions + e.deletions >= GIANT_CHANGED_LINES;
  // Collapsed when explicitly overridden, else when viewed (#1) or giant.
  const collapsedFor = (e: FileEntry) => collapseOverrides[e.path] ?? (viewedFiles.has(e.path) || isGiant(e));
  const toggleCollapse = (path: string) => {
    const e = files.find((f) => f.path === path);
    const current = collapseOverrides[path] ?? (e ? viewedFiles.has(path) || isGiant(e) : false);
    setCollapseOverrides((o) => ({ ...o, [path]: !current }));
  };
  // Toggling viewed collapses the file. Anchor the clicked header to its
  // pre-click viewport position so the Viewed button stays under the cursor
  // (no scroll jump) — whether the header was stuck at the top mid-file or sat
  // lower in the pane.
  const handleToggleViewed = (path: string) => {
    const pane = paneRef.current;
    const header = sectionRefs.current.get(path)?.firstElementChild as HTMLElement | undefined;
    const before = pane && header ? header.getBoundingClientRect().top : null;
    onToggleViewed(path); // collapse follows viewed via collapsedFor (#1)
    if (pane && header && before != null) {
      // setTimeout (not rAF) so it still runs if the window is occluded.
      setTimeout(() => {
        const delta = header.getBoundingClientRect().top - before;
        if (Math.abs(delta) > 0.5) pane.scrollTop += delta;
      }, 0);
    }
  };

  // Jump to a file (tree click) or an exact comment (panel click). The nonce
  // re-fires this on every click, even for the same target.
  //
  // Because files now stay mounted (content-visibility skips off-screen paint,
  // it doesn't unmount), off-screen sections keep a stable height — so a single
  // scroll lands the target and *stays* put; no estimate→real "hop" to correct,
  // hence no pin/convergence machinery. We just align the target to the pane top
  // (a couple of passes to cover the forced section's own mount), or center the
  // comment node once it renders.
  useEffect(() => {
    if (!jump) return;
    const { file, commentId } = jump;
    setCollapseOverrides((o) => (o[file] === false ? o : { ...o, [file]: false }));
    setForcedPath(file); // mount an off-screen target so we land on built content
    void cache.load(file);
    const pane = paneRef.current;
    if (!pane) return;

    if (commentId) {
      // Center the comment once its row mounts (extend rows mount a few frames
      // after the diff builds); converge a little as the region settles.
      const centerOn = (node: HTMLElement): number => {
        const pr = pane.getBoundingClientRect();
        const nr = node.getBoundingClientRect();
        const target = Math.max(0, pane.scrollTop + (nr.top - pr.top) - Math.max(0, pane.clientHeight / 2 - nr.height / 2));
        pane.scrollTop = target;
        return target;
      };
      const attempt = (tries: number, lastTarget: number) => {
        const sec = sectionRefs.current.get(file);
        const node = pane.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`) as HTMLElement | null;
        if (node) {
          const target = centerOn(node);
          if (Math.abs(target - lastTarget) > 2 && tries < 40) {
            jumpTimer.current = window.setTimeout(() => attempt(tries + 1, target), 32);
          }
          return;
        }
        if (tries < 40) {
          sec?.scrollIntoView({ behavior: "auto", block: "center" });
          jumpTimer.current = window.setTimeout(() => attempt(tries + 1, lastTarget), 32);
        }
      };
      attempt(0, -1);
      return () => clearTimeout(jumpTimer.current);
    }

    // File jump: align the section header to the pane top. A few passes over
    // ~150ms cover the forced section mounting (which grows it downward, not up,
    // so the header stays put — the passes are just belt-and-suspenders).
    const align = (tries: number) => {
      const sec = sectionRefs.current.get(file);
      if (sec) {
        const drift = sec.getBoundingClientRect().top - pane.getBoundingClientRect().top;
        if (Math.abs(drift) > 1) pane.scrollTop = Math.max(0, pane.scrollTop + drift);
      }
      if (tries < 4) jumpTimer.current = window.setTimeout(() => align(tries + 1), 48);
    };
    align(0);
    return () => clearTimeout(jumpTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.n]);

  return (
    <div ref={paneRef} className="h-full overflow-auto" data-testid="diff-pane">
      {files.map((entry) => (
        <FileSection
          key={entry.path}
          entry={entry}
          cache={cache}
          comments={comments}
          viewed={viewedFiles.has(entry.path)}
          collapsed={collapsedFor(entry)}
          theme={theme}
          layout={layout}
          onToggleViewed={handleToggleViewed}
          onToggleCollapse={toggleCollapse}
          onAddComment={onAddComment}
          onAddFileComment={onAddFileComment}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
          registerRef={registerRef}
          requestLoad={requestLoad}
          estimateHeight={estimateHeight}
          forced={forcedPath === entry.path}
          prefetch={prefetchPath === entry.path}
        />
      ))}
      {/* Small bottom breathing room — not a full viewport, so you can't scroll
          into a blank white screen past the last file. (#7) */}
      <div aria-hidden className="h-16" />
    </div>
  );
});
