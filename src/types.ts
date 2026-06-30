export type DiffMode = "all-changes" | "uncommitted" | "last-commit" | "branch-vs-base" | "commit";

export interface Target {
  repoPath: string;
  mode: DiffMode;
  base?: string;
  worktree?: string;
  /** Pinned commit oid, set iff mode === "commit". */
  commit?: string;
}

export interface CommitMeta {
  oid: string;
  shortOid: string;
  subject: string;
  author: string;
  time: number;
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
  resolved: boolean;
  /** Full oid of the commit this comment was authored against (commit mode). */
  commit?: string | null;
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
  repoName: string;
  /** True when the worktree has uncommitted changes (staged or unstaged). Gates the
   *  AI walkthrough, which reviews committed branch-vs-base only. (#guide) */
  dirty?: boolean;
}

export interface WorktreeEntry {
  path: string;
  branch: string;
  isMain: boolean;
  /** RFC3339 time of the worktree HEAD's last commit — recency sort + display. */
  lastCommitAt?: string | null;
  /** True when the worktree has uncommitted changes (staged or unstaged). */
  dirty?: boolean;
}

export interface RepoEntry {
  id: string;
  root: string;
  name: string;
  defaultBranch?: string | null;
  worktrees: WorktreeEntry[];
}

export interface ReviewEntry {
  id: string;
  repoName: string;
  target: Target;
  lastOpenedAt: string;
  commentCount: number;
  staleCount: number;
  resolvedCount: number;
  viewedCount: number;
  fileCount: number;
}

export interface Registry {
  version: number;
  repos: RepoEntry[];
  reviews: ReviewEntry[];
  /** Absolute $HOME, supplied by the backend so the UI can render ~-relative
   *  paths. Display-only — never used as a real path. */
  home?: string | null;
}

export interface PickerWorktree {
  path: string;
  branch: string;
  isMain: boolean;
  lastCommitAt?: string | null;
  dirty?: boolean;
  repoName: string;
  repoId: string;
}

export interface PickerData {
  recents: ReviewEntry[];
  worktrees: PickerWorktree[];
  home?: string | null;
}

export type InstallOutcome =
  | { kind: "linked"; path: string }
  | { kind: "linkedPathUpdated"; path: string; shells: string[] }
  | { kind: "manualNeeded"; command: string; reason: string };

// ---------------------------------------------------------------------------
// AI guidance ("Guide") — a structured reading guide produced from the diff by
// the local `claude` CLI. Orientation + lightweight risk flags, not a critique.
// ---------------------------------------------------------------------------
export type WalkImportance = "core" | "supporting" | "skim";
export type RiskSeverity = "watch" | "caution";

export interface WalkFile {
  path: string;
  /** One-liner: this file's role in the group. */
  note?: string | null;
  /** Default-fold this file in the diff (skim/noise). */
  collapsed?: boolean;
}

export interface WalkRisk {
  path: string;
  /** New-side line to anchor/jump to, when known. */
  line?: number | null;
  severity: RiskSeverity;
  /** Why to look here — attention-steering, not a verdict. */
  note: string;
}

export interface WalkGroup {
  id: string;
  title: string;
  summary: string;
  /** Reading sequence, 1-based. */
  order: number;
  importance: WalkImportance;
  files: WalkFile[];
  risks: WalkRisk[];
}

export interface IgnoredFile {
  path: string;
  reason: string;
}

export interface Walkthrough {
  version: number;
  /** Short headline for the whole change — a PR-style title. */
  title: string;
  /** 1–3 sentences: what this change does and why, at a glance. */
  summary: string;
  groups: WalkGroup[];
  ignored: IgnoredFile[];
  /** True when the diff was too large to read in full (summarized from structure). */
  degraded?: boolean;
}

export interface CliStatus {
  installed: boolean;
  path: string | null;
}
