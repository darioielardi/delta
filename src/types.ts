export type DiffMode = "all-changes" | "uncommitted" | "last-commit" | "branch-vs-base";

export interface Target {
  repoPath: string;
  mode: DiffMode;
  base?: string;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileEntry {
  path: string;
  oldPath?: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface FileDiff {
  oldFileName?: string | null;
  oldContent?: string | null;
  oldLang?: string | null;
  newFileName?: string | null;
  newContent?: string | null;
  newLang?: string | null;
  status: FileStatus;
  binary: boolean;
}

export interface DiffSummary {
  files: FileEntry[];
  baseLabel: string;
  headLabel: string;
}
