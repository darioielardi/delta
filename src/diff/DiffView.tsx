import { DiffView as GitDiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { FileDiff } from "../types";
import { toDiffFile } from "./toDiffFile";

export function DiffView({
  fileDiff,
  mode,
  theme = "light",
}: {
  fileDiff: FileDiff;
  mode: "unified" | "split";
  theme?: "light" | "dark";
}) {
  if (fileDiff.binary) {
    return (
      <div className="text-muted-foreground p-6 text-sm">
        Binary file — not shown
      </div>
    );
  }

  // No useMemo — React Compiler handles memoization (Global Constraints).
  const file = toDiffFile(fileDiff); // adapter already calls .init()
  file.initTheme(theme);
  mode === "split" ? file.buildSplitDiffLines() : file.buildUnifiedDiffLines();

  return (
    <GitDiffView
      diffFile={file}
      diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight
      diffViewTheme={theme}
    />
  );
}
