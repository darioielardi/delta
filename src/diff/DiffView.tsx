import { useMemo, useRef } from "react";
import { DiffViewWithMultiSelect, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import type { DiffViewWithMultiSelectRef } from "@git-diff-view/react";
// diff-view.css is imported in index.css (into the `gdv` cascade layer).
import type { Anchor, Comment, FileDiff, Side } from "../types";
import { toDiffFile } from "./toDiffFile";
import { buildExtendData } from "./commentExtendData";
import { CommentThread } from "../review/CommentThread";

const enumToSide = (s: SplitSide): Side => (s === SplitSide.old ? "old" : "new");

export function DiffView({
  fileDiff,
  filePath,
  layout,
  theme = "light",
  comments = [],
  onAddComment,
  onEditComment,
  onDeleteComment,
}: {
  fileDiff: FileDiff;
  filePath: string;
  layout: "unified" | "split";
  theme?: "light" | "dark";
  comments?: Comment[];
  onAddComment?: (anchor: Anchor, body: string) => void;
  onEditComment?: (id: string, body: string) => void;
  onDeleteComment?: (id: string) => void;
}) {
  const ref = useRef<DiffViewWithMultiSelectRef>(null);

  // Build + tokenize the diff model once per (fileDiff, layout, theme). This is
  // the expensive step (parse, diff, syntax highlight); doing it every render —
  // as happens when a sibling state change re-renders the pane — measured as the
  // dominant cost on large reviews, so memoize explicitly rather than trusting
  // the compiler to cache these mutating calls.
  const file = useMemo(() => {
    if (fileDiff.binary) return null;
    const f = toDiffFile(fileDiff); // adapter already calls .init()
    f.initTheme(theme);
    layout === "split" ? f.buildSplitDiffLines() : f.buildUnifiedDiffLines();
    return f;
  }, [fileDiff, layout, theme]);

  const extendData = useMemo(() => buildExtendData(comments), [comments]);

  if (fileDiff.binary || !file) {
    return (
      <div className="text-muted-foreground p-6 text-sm">Unsupported file</div>
    );
  }

  // Build a range-aware anchor. endLine is null for a single line, > startLine
  // for a multi-line range; the snippet is sliced from that side's content.
  const buildAnchor = (side: Side, startLine: number, endLine: number): Anchor => {
    const start = Math.min(startLine, endLine);
    const end = Math.max(startLine, endLine);
    const content = side === "old" ? fileDiff.oldContent : fileDiff.newContent;
    const lines = (content ?? "").split("\n");
    const snippet = lines.slice(start - 1, end).join("\n");
    return { file: filePath, side, startLine: start, endLine: end > start ? end : null, snippet };
  };

  return (
    <DiffViewWithMultiSelect<Comment[]>
      ref={ref}
      diffFile={file}
      diffViewMode={layout === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight
      diffViewTheme={theme}
      diffViewFontSize={12}
      diffViewAddWidget
      enableMultiSelect
      extendData={extendData}
      // Clicking the `+` on a line creates an empty comment immediately and
      // persists it — it renders inline via renderExtendLine (with its editor
      // open) rather than as a throwaway widget that vanishes if left blank.
      onAddWidgetClick={({ fromLineNumber, lineNumber, side }) =>
        onAddComment?.(buildAnchor(enumToSide(side), fromLineNumber ?? lineNumber, lineNumber), "")
      }
      // Drag across the line-number gutter to select a range, release to comment.
      // A single-line click (no drag) creates nothing here — use `+` for one line.
      onMultiSelectComplete={(result) => {
        const r = result?.range;
        if (r && r.endLineNumber > r.startLineNumber) {
          onAddComment?.(buildAnchor(r.side as Side, r.startLineNumber, r.endLineNumber), "");
        }
        ref.current?.clearSelection();
      }}
      renderExtendLine={({ data }) => (
        <div className="delta-comment-ui bg-muted/30 px-3 py-2">
          <CommentThread
            comments={data}
            onEdit={(id, body) => onEditComment?.(id, body)}
            onDelete={(id) => onDeleteComment?.(id)}
          />
        </div>
      )}
    />
  );
}
