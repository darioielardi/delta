// src/diff/DiffPane.tsx
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiffView } from "./DiffView";
import { useFileDiffCache } from "./useFileDiffCache";
import { CommentThread } from "../review/CommentThread";
import type { Anchor, Comment, FileEntry, Target } from "../types";

// Files with at least this many changed lines start collapsed.
const GIANT_CHANGED_LINES = 600;

function commentsForFile(comments: Comment[], file: string): Comment[] {
  return comments.filter((c) => c.anchor?.file === file);
}

function FileSection({
  entry, cache, comments, viewed, collapsed, theme, onToggleViewed, onToggleCollapse, onAddComment, onAddFileComment, onEditComment, onDeleteComment, registerRef,
}: {
  entry: FileEntry; cache: ReturnType<typeof useFileDiffCache>;
  comments: Comment[]; viewed: boolean; collapsed: boolean; theme: "light" | "dark";
  onToggleViewed: (file: string) => void;
  onToggleCollapse: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
  registerRef: (file: string, el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fd = cache.get(entry.path);
  const fileComments = comments.filter((c) => c.scope === "file" && c.anchor?.file === entry.path);
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;

  useEffect(() => {
    registerRef(entry.path, ref.current);
    return () => registerRef(entry.path, null);
  }, [entry.path]);

  // Preload the diff well before it scrolls into view (large rootMargin) so the
  // code — and git-diff-view's measured line-number gutter — is already painted
  // by the time the section is visible, avoiding pop-in on scroll.
  useEffect(() => {
    if (collapsed || fd || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        void cache.load(entry.path);
        io.disconnect();
      }
    }, { rootMargin: "1200px 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [entry.path, collapsed, fd]);

  return (
    <div ref={ref} data-file={entry.path} className="border-b border-border/70">
      <div className={`sticky top-0 z-10 flex items-center gap-1 border-b border-border/70 bg-background/85 px-3 py-2 backdrop-blur transition-opacity ${viewed ? "opacity-55" : ""}`}>
        <button
          type="button"
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onToggleCollapse(entry.path)}
          aria-label={collapsed ? `expand ${entry.path}` : `collapse ${entry.path}`}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
        >
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
        </button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => onAddFileComment(entry.path, "")}
          aria-label={`comment on ${entry.path}`}
          title="Comment on file"
        >
          <MessageSquarePlus className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={`h-7 shrink-0 gap-1.5 px-2 text-[12px] ${viewed ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground"}`}
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
          {fd ? (
            <DiffView
              fileDiff={fd}
              filePath={entry.path}
              mode="unified"
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

export function DiffPane({
  target, files, comments, viewedFiles, theme, jump,
  onToggleViewed, onAddComment, onAddFileComment, onEditComment, onDeleteComment,
}: {
  target: Target; files: FileEntry[]; comments: Comment[]; viewedFiles: Set<string>;
  theme: "light" | "dark"; jump?: { file: string; commentId?: string; n: number } | null;
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
}) {
  const cache = useFileDiffCache(target);
  const paneRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
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
  useEffect(() => {
    if (!jump) return;
    const { file, commentId } = jump;
    setCollapseOverrides((o) => (o[file] === false ? o : { ...o, [file]: false }));
    void cache.load(file);
    const pane = paneRef.current;
    let timer = 0;
    let tries = 0;
    const attempt = () => {
      const node = commentId
        ? (pane?.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`) as HTMLElement | null)
        : null;
      if (node && pane) {
        // Center the comment by computing the pane scroll directly — scrollIntoView
        // is unreliable on a node nested deep in git-diff-view's table layout.
        const pr = pane.getBoundingClientRect();
        const nr = node.getBoundingClientRect();
        const target = pane.scrollTop + (nr.top - pr.top) - Math.max(0, pane.clientHeight / 2 - nr.height / 2);
        pane.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        return;
      }
      const sec = sectionRefs.current.get(file);
      if (commentId && tries < 30) {
        // Coarse-scroll to the file so its diff (and the comment's extend row)
        // mounts, then keep polling (setTimeout, not rAF, so it runs even when the
        // window is occluded) for the exact node.
        if (tries === 0) sec?.scrollIntoView({ behavior: "auto", block: "start" });
        tries++;
        timer = window.setTimeout(attempt, 32);
        return;
      }
      sec?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    attempt();
    return () => clearTimeout(timer);
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
}
