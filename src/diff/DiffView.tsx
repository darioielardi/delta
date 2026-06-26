import { DiffViewWithMultiSelect, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { Anchor, Comment, FileDiff, Side } from "../types";
import { toDiffFile } from "./toDiffFile";
import { buildExtendData } from "./commentExtendData";
import { CommentThread } from "../review/CommentThread";
import { CommentEditor } from "../review/CommentEditor";

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

  // Build a range-aware anchor. When fromLineNumber === lineNumber (single-line
  // selection), endLine is null → produces a "line" comment. When the user
  // drags across multiple lines, endLine > startLine → "range" comment.
  const buildAnchor = (side: SplitSide, fromLineNumber: number, lineNumber: number): Anchor => {
    const s: Side = enumToSide(side);
    const start = Math.min(fromLineNumber, lineNumber);
    const end = Math.max(fromLineNumber, lineNumber);
    const content = s === "old" ? fileDiff.oldContent : fileDiff.newContent;
    const lines = (content ?? "").split("\n");
    const snippet = lines.slice(start - 1, end).join("\n");
    return { file: filePath, side: s, startLine: start, endLine: end > start ? end : null, snippet };
  };

  return (
    <DiffViewWithMultiSelect<Comment[]>
      diffFile={file}
      diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight
      diffViewTheme={theme}
      diffViewFontSize={12}
      diffViewAddWidget
      enableMultiSelect
      extendData={extendData}
      renderWidgetLine={({ fromLineNumber, lineNumber, side, onClose }) => (
        <CommentEditor
          onSubmit={(body) => {
            onAddComment?.(buildAnchor(side, fromLineNumber, lineNumber), body);
            onClose();
          }}
          onCancel={onClose}
        />
      )}
      renderExtendLine={({ data }) => (
        <CommentThread
          comments={data}
          onEdit={(id, body) => onEditComment?.(id, body)}
          onDelete={(id) => onDeleteComment?.(id)}
        />
      )}
    />
  );
}
