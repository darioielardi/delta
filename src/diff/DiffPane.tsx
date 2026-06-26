// src/diff/DiffPane.tsx
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronRight, Eye, FileX, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiffView } from "./DiffView";
import { useFileDiffCache } from "./useFileDiffCache";
import { CommentThread } from "../review/CommentThread";
import type { Anchor, Comment, FileEntry, Target } from "../types";
import type { DiffLayout } from "./useDiffLayout";

// Files with at least this many changed lines start collapsed.
const GIANT_CHANGED_LINES = 600;

function commentsForFile(comments: Comment[], file: string): Comment[] {
  return comments.filter((c) => c.anchor?.file === file);
}

function FileSection({
  entry, cache, comments, viewed, collapsed, theme, layout, onToggleViewed, onToggleCollapse, onAddComment, onAddFileComment, onEditComment, onDeleteComment, registerRef,
}: {
  entry: FileEntry; cache: ReturnType<typeof useFileDiffCache>;
  comments: Comment[]; viewed: boolean; collapsed: boolean; theme: "light" | "dark"; layout: "unified" | "split";
  onToggleViewed: (file: string) => void;
  onToggleCollapse: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
  registerRef: (file: string, el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Subscribe to just this file's diff. Only this section re-renders when its
  // own load resolves (or when the target resets) — not the whole pane.
  const subscribe = useCallback((cb: () => void) => cache.subscribe(entry.path, cb), [cache, entry.path]);
  const fd = useSyncExternalStore(subscribe, () => cache.get(entry.path));
  // Viewport proximity (within ~1 screen). Drives eager paint so the diff is
  // ready before it scrolls into view, instead of painting on arrival.
  const [near, setNear] = useState(false);
  // Deleted files are hidden by default behind a reveal (their diff is just the
  // removed file). Don't load or render it until the user asks.
  const isDeleted = entry.status === "deleted";
  const [revealed, setRevealed] = useState(false);
  const fileComments = comments.filter((c) => c.scope === "file" && c.anchor?.file === entry.path);
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;

  useEffect(() => {
    registerRef(entry.path, ref.current);
    return () => registerRef(entry.path, null);
  }, [entry.path]);

  // Track viewport proximity with a ~1-screen margin: load the diff data and
  // mark the section `near` so it paints eagerly (content-visibility below).
  // Without this, content-visibility:auto defers layout/paint until the section
  // actually enters the viewport — a brief blank-then-fill on scroll. Persistent
  // (not disconnect-after-load) so it can also drop back to skipped when the
  // section scrolls far away again. cache.load is idempotent, so re-entry is a
  // no-op once cached.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      const isNear = entries.some((e) => e.isIntersecting);
      setNear(isNear);
      if (isNear && !collapsed && (!isDeleted || revealed)) void cache.load(entry.path);
    }, { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
    // cache has stable identity (useFileDiffCache storeRef); listed to satisfy
    // exhaustive-deps without changing behavior.
  }, [entry.path, collapsed, isDeleted, revealed, cache]);

  // Far sections use content-visibility:auto so the engine skips their
  // layout/paint (keeps scroll smooth and pane-resize reflow cheap). Near ones
  // are forced visible so they're painted ~1 screen before arrival. contain-
  // intrinsic-size seeds a height estimate so the scrollbar stays stable while a
  // section is skipped (the `auto` keyword then remembers the real size).
  const estPx = collapsed ? 48 : Math.min(4000, 80 + (entry.additions + entry.deletions) * 18);
  return (
    <div
      ref={ref}
      data-file={entry.path}
      className="border-b border-border/70"
      style={{ contentVisibility: near ? "visible" : "auto", containIntrinsicSize: `auto ${estPx}px` }}
    >
      <div className={`group sticky top-0 z-10 flex items-center gap-1 border-b border-border/70 bg-background/85 px-3 py-2 backdrop-blur transition-opacity ${viewed ? "opacity-55" : ""}`}>
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
        <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors group-hover:bg-foreground/[0.06] group-hover:text-foreground">
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {dir && <span className="text-muted-foreground">{dir}</span>}
            <span className="font-semibold text-foreground">{base}</span>
          </span>
          <span className="shrink-0 text-[12px] tabular-nums">
            {entry.additions > 0 && <span className="text-emerald-500">+{entry.additions}</span>}{" "}
            {entry.deletions > 0 && <span className="text-rose-500">−{entry.deletions}</span>}
          </span>
        </span>
        {/* Right actions, left→right: diff counts (in the content span above) ·
            mark-as-viewed · add file comment. */}
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
            <div className="flex items-center gap-3 px-3 py-4 text-[13px] text-muted-foreground">
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
          ) : fd ? (
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
          ) : (
            <div className="px-3 py-6 text-[12px] text-muted-foreground">Loading…</div>
          )}
        </div>
      )}
    </div>
  );
}

// memo so toggling unrelated Workspace state (e.g. the comments pane) skips the
// whole diff pane — its props are kept referentially stable by the parent.
export const DiffPane = memo(function DiffPane({
  target, files, comments, viewedFiles, theme, layout, jump,
  onToggleViewed, onAddComment, onAddFileComment, onEditComment, onDeleteComment,
}: {
  target: Target; files: FileEntry[]; comments: Comment[]; viewedFiles: Set<string>;
  theme: "light" | "dark"; layout: DiffLayout; jump?: { file: string; commentId?: string; n: number } | null;
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
}) {
  const cache = useFileDiffCache(target);
  const paneRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const jumpTimer = useRef(0);
  const registerRef = (file: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(file, el);
    else sectionRefs.current.delete(file);
  };

  // Scroll-past-end room: a trailing spacer one viewport tall lets the last
  // files be scrolled to the top, and — critically — stops the browser from
  // clamping scrollTop (which would yank the clicked header away) when a file
  // near the bottom collapses on "viewed".
  const [padBottom, setPadBottom] = useState(0);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const update = () => setPadBottom(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Collapse is independent of viewed. Explicit user choices override the
  // giant-file default; marking a file viewed collapses it (un-marking expands).
  const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
  const isGiant = (e: FileEntry) => e.additions + e.deletions >= GIANT_CHANGED_LINES;
  const collapsedFor = (e: FileEntry) => collapseOverrides[e.path] ?? isGiant(e);
  const toggleCollapse = (path: string) => {
    const e = files.find((f) => f.path === path);
    setCollapseOverrides((o) => ({ ...o, [path]: !(o[path] ?? (e ? isGiant(e) : false)) }));
  };
  // Toggling viewed collapses the file. Anchor the clicked header to its
  // pre-click viewport position so the Viewed button stays under the cursor
  // (no scroll jump) — whether the header was stuck at the top mid-file or sat
  // lower in the pane.
  const handleToggleViewed = (path: string) => {
    const willView = !viewedFiles.has(path);
    const pane = paneRef.current;
    const header = sectionRefs.current.get(path)?.firstElementChild as HTMLElement | undefined;
    const before = pane && header ? header.getBoundingClientRect().top : null;
    onToggleViewed(path);
    setCollapseOverrides((o) => ({ ...o, [path]: willView }));
    if (pane && header && before != null) {
      // setTimeout (not rAF) so it still runs if the window is occluded.
      setTimeout(() => {
        const delta = header.getBoundingClientRect().top - before;
        if (Math.abs(delta) > 0.5) pane.scrollTop += delta;
      }, 0);
    }
  };

  // Jump to a file (tree click) or an exact comment (panel click). The nonce
  // re-fires this on every click, even for the same target. For a comment we
  // expand + load the file, then poll for the comment's DOM node (extend rows
  // mount a few frames after the diff loads) and center it; we fall back to the
  // file header if it never appears.
  //
  // Because off-screen sections use content-visibility:auto, the rows between
  // here and the target only get their real heights once they scroll into view —
  // a single scroll computed from intrinsic-size *estimates* undershoots. So we
  // converge: jump (instantly), let the newly revealed region settle, re-measure,
  // and repeat until the target position stops moving.
  useEffect(() => {
    if (!jump) return;
    const { file, commentId } = jump;
    setCollapseOverrides((o) => (o[file] === false ? o : { ...o, [file]: false }));
    void cache.load(file);
    const pane = paneRef.current;
    if (!pane) return;
    const centerOn = (node: HTMLElement): number => {
      const pr = pane.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      const target = Math.max(0, pane.scrollTop + (nr.top - pr.top) - Math.max(0, pane.clientHeight / 2 - nr.height / 2));
      pane.scrollTop = target; // instant — a smooth animation would fight the re-measure
      return target;
    };
    // tries/lastTarget are passed as recursion args rather than mutated captured
    // vars, so React Compiler can still optimize this component (a captured `i++`
    // inside a lambda makes it bail). jumpTimer (a ref) holds the pending poll.
    const attempt = (tries: number, lastTarget: number) => {
      const sec = sectionRefs.current.get(file);
      const node = commentId
        ? (pane.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`) as HTMLElement | null)
        : null;
      if (commentId) {
        if (node) {
          const target = centerOn(node);
          // Keep correcting until the position is stable (heights have settled)
          // or we run out of tries.
          if (Math.abs(target - lastTarget) > 2 && tries < 40) {
            jumpTimer.current = window.setTimeout(() => attempt(tries + 1, target), 32);
          }
          return;
        }
        if (tries < 40) {
          // Node not mounted yet: coarse-scroll toward the section (centered, so
          // the region renders) and keep polling — setTimeout, not rAF, so it
          // runs even when the window is occluded.
          sec?.scrollIntoView({ behavior: "auto", block: "center" });
          jumpTimer.current = window.setTimeout(() => attempt(tries + 1, lastTarget), 32);
          return;
        }
      }
      // Always instant: file-tree navigation should jump, not animate. (The
      // comment-jump path already centers instantly via centerOn; this is its
      // fallback when the node never mounts, and was already "auto" there.)
      sec?.scrollIntoView({ behavior: "auto", block: "start" });
    };
    attempt(0, -1);
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
        />
      ))}
      <div aria-hidden style={{ height: padBottom }} />
    </div>
  );
});
