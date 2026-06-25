export type DiffMode = "all-changes" | "uncommitted" | "last-commit" | "branch-vs-base";

export interface Target {
  repoPath: string;
  mode: DiffMode;
  base?: string;
  worktree?: string;
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

export type CommentScope = "line" | "range" | "file" | "general";
export type Side = "new" | "old";

export interface Anchor {
  file: string;
  side: Side;
  startLine?: number | null;
  endLine?: number | null;
  snippet?: string | null;
}

export interface Comment {
  id: string;
  scope: CommentScope;
  anchor?: Anchor | null;
  body: string;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  baseOid: string;
  headOid?: string | null;
  capturedAt: string;
}

export interface ViewedEntry {
  file: string;
  diffHash: string;
}

export interface Review {
  version: number;
  id: string;
  target: Target;
  snapshot: Snapshot;
  comments: Comment[];
  viewed: ViewedEntry[];
  createdAt: string;
  lastOpenedAt: string;
}

export interface ReviewSession {
  review: Review;
  summary: DiffSummary;
}
