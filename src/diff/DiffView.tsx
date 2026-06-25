import { DiffView as GitDiffView, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { Anchor, Comment, FileDiff, Side } from "../types";
import { toDiffFile } from "./toDiffFile";
import { buildExtendData } from "./commentExtendData";
import { CommentThread } from "../review/CommentThread";
import { CommentEditor } from "../review/CommentEditor";

const sideToEnum = (s: Side): SplitSide => (s === "old" ? SplitSide.old : SplitSide.new);
const enumToSide = (s: SplitSide): Side => (s === SplitSide.old ? "old" : "new");

// Suppress unused-variable warning for sideToEnum — kept for symmetry and future use.
void sideToEnum;

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

  // Build a line anchor from a clicked widget line, capturing the line's text as snippet.
  const anchorAt = (side: SplitSide, lineNumber: number): Anchor => {
    const s: Side = enumToSide(side);
    const content = s === "old" ? fileDiff.oldContent : fileDiff.newContent;
    const snippet = (content ?? "").split("\n")[lineNumber - 1] ?? "";
    return { file: filePath, side: s, startLine: lineNumber, endLine: null, snippet };
  };

  return (
    <GitDiffView<Comment[]>
      diffFile={file}
      diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight
      diffViewTheme={theme}
      diffViewAddWidget
      extendData={extendData}
      renderWidgetLine={({ side, lineNumber, onClose }) => (
        <CommentEditor
          onSubmit={(body) => {
            onAddComment?.(anchorAt(side, lineNumber), body);
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
