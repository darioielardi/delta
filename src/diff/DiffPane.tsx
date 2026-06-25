// src/diff/DiffPane.tsx
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DiffView } from "./DiffView";
import { useFileDiffCache } from "./useFileDiffCache";
import type { Anchor, Comment, FileEntry, Target } from "../types";

function commentsForFile(comments: Comment[], file: string): Comment[] {
  return comments.filter((c) => c.anchor?.file === file);
}

function FileSection({
  entry, cache, comments, viewed, theme, onToggleViewed, onAddComment, onEditComment, onDeleteComment, registerRef,
}: {
  entry: FileEntry; cache: ReturnType<typeof useFileDiffCache>;
  comments: Comment[]; viewed: boolean; theme: "light" | "dark";
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void; onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
  registerRef: (file: string, el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fd = cache.get(entry.path);

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
    <div ref={ref} data-file={entry.path} className="border-b">
      <div className={`flex items-center gap-2 px-3 py-1.5 text-xs sticky top-0 bg-background border-b ${viewed ? "opacity-50" : ""}`}>
        <button className="flex items-center gap-1" onClick={() => onToggleViewed(entry.path)} aria-label="toggle viewed">
          {viewed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <input type="checkbox" checked={viewed} onChange={() => onToggleViewed(entry.path)} onClick={(e) => e.stopPropagation()} aria-label={`viewed ${entry.path}`} />
        </button>
        <span className="font-mono">{entry.path}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {entry.additions > 0 && <span className="text-emerald-600">+{entry.additions}</span>}{" "}
          {entry.deletions > 0 && <span className="text-red-600">−{entry.deletions}</span>}
        </span>
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
            <div className="p-4 text-xs text-muted-foreground">Loading…</div>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffPane({
  target, files, comments, viewedFiles, theme, scrollToFile,
  onToggleViewed, onAddComment, onEditComment, onDeleteComment,
}: {
  target: Target; files: FileEntry[]; comments: Comment[]; viewedFiles: Set<string>;
  theme: "light" | "dark"; scrollToFile?: string | null;
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void; onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
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
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
          registerRef={registerRef}
        />
      ))}
    </div>
  );
}
