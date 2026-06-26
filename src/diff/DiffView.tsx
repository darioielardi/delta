import { useRef } from "react";
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
  mode,
  theme = "light",
  comments = [],
  onAddComment,
  onEditComment,
  onDeleteComment,
}: {
  fileDiff: FileDiff;
  filePath: string;
  mode: "unified" | "split";
  theme?: "light" | "dark";
  comments?: Comment[];
  onAddComment?: (anchor: Anchor, body: string) => void;
  onEditComment?: (id: string, body: string) => void;
  onDeleteComment?: (id: string) => void;
}) {
  const ref = useRef<DiffViewWithMultiSelectRef>(null);

  if (fileDiff.binary) {
    return (
      <div className="text-muted-foreground p-6 text-sm">Binary file — not shown</div>
    );
  }

  // No useMemo — React Compiler handles memoization (Global Constraints).
  const file = toDiffFile(fileDiff); // adapter already calls .init()
  file.initTheme(theme);
  mode === "split" ? file.buildSplitDiffLines() : file.buildUnifiedDiffLines();

  const extendData = buildExtendData(comments);

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
      diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
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
