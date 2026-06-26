// src/diff/DiffPane.tsx
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiffView } from "./DiffView";
import { useFileDiffCache } from "./useFileDiffCache";
import { CommentThread } from "../review/CommentThread";
import { CommentEditor } from "../review/CommentEditor";
import type { Anchor, Comment, FileEntry, Target } from "../types";

function commentsForFile(comments: Comment[], file: string): Comment[] {
  return comments.filter((c) => c.anchor?.file === file);
}

function FileSection({
  entry, cache, comments, viewed, theme, onToggleViewed, onAddComment, onAddFileComment, onEditComment, onDeleteComment, registerRef,
}: {
  entry: FileEntry; cache: ReturnType<typeof useFileDiffCache>;
  comments: Comment[]; viewed: boolean; theme: "light" | "dark";
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
  registerRef: (file: string, el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showFileEditor, setShowFileEditor] = useState(false);
  const fd = cache.get(entry.path);
  const fileComments = comments.filter((c) => c.scope === "file" && c.anchor?.file === entry.path);
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;

  useEffect(() => {
    registerRef(entry.path, ref.current);
    return () => registerRef(entry.path, null);
  }, [entry.path]);

  useEffect(() => {
    if (viewed || fd || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        void cache.load(entry.path);
        io.disconnect();
      }
    }, { rootMargin: "300px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [entry.path, viewed, fd]);

  return (
    <div ref={ref} data-file={entry.path} className="border-b border-border/70">
      <div className={`sticky top-0 z-10 flex items-center gap-2 border-b border-border/70 bg-background/85 px-3 py-2 backdrop-blur transition-opacity ${viewed ? "opacity-55" : ""}`}>
        <button
          className="flex shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => onToggleViewed(entry.path)}
          aria-label="toggle viewed"
        >
          {viewed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        <input
          type="checkbox"
          checked={viewed}
          onChange={() => onToggleViewed(entry.path)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`viewed ${entry.path}`}
          className="size-3.5 shrink-0 accent-[var(--primary)]"
        />
        <span className="truncate text-[13px]">
          {dir && <span className="text-muted-foreground">{dir}</span>}
          <span className="font-semibold text-foreground">{base}</span>
        </span>
        <span className="ml-auto shrink-0 text-[12px] tabular-nums">
          {entry.additions > 0 && <span className="text-emerald-500">+{entry.additions}</span>}{" "}
          {entry.deletions > 0 && <span className="text-rose-500">−{entry.deletions}</span>}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2">
        {fileComments.length > 0 && (
          <CommentThread
            comments={fileComments}
            onEdit={onEditComment}
            onDelete={onDeleteComment}
          />
        )}
        {showFileEditor ? (
          <CommentEditor
            onSubmit={(body) => {
              onAddFileComment(entry.path, body);
              setShowFileEditor(false);
            }}
            onCancel={() => setShowFileEditor(false)}
          />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowFileEditor(true)}
          >
            <MessageSquarePlus className="size-3.5" />
            Comment on file
          </Button>
        )}
      </div>
      {!viewed && (
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
  target, files, comments, viewedFiles, theme, scrollToFile,
  onToggleViewed, onAddComment, onAddFileComment, onEditComment, onDeleteComment,
}: {
  target: Target; files: FileEntry[]; comments: Comment[]; viewedFiles: Set<string>;
  theme: "light" | "dark"; scrollToFile?: string | null;
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
}) {
  const cache = useFileDiffCache(target);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerRef = (file: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(file, el);
    else sectionRefs.current.delete(file);
  };

  useEffect(() => {
    if (scrollToFile) sectionRefs.current.get(scrollToFile)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollToFile]);

  return (
    <div className="h-full overflow-auto" data-testid="diff-pane">
      {files.map((entry) => (
        <FileSection
          key={entry.path}
          entry={entry}
          cache={cache}
          comments={comments}
          viewed={viewedFiles.has(entry.path)}
          theme={theme}
          onToggleViewed={onToggleViewed}
          onAddComment={onAddComment}
          onAddFileComment={onAddFileComment}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
          registerRef={registerRef}
        />
      ))}
    </div>
  );
}
