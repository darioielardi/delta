import { invoke } from "@tauri-apps/api/core";
import type {
  Target,
  DiffSummary,
  FileDiff,
  Review,
  ReviewSession,
  Registry,
  PickerData,
  WorktreeEntry,
  RepoEntry,
  InstallOutcome,
  CliStatus,
  ClaudeStatus,
  DiffMode,
  Walkthrough,
  CommitMeta,
} from "./types";

// Transport indirection: a dev-only fixture backend (VITE_MOCK_IPC) can replace
// the Tauri IPC so the frontend runs in a plain browser for behavioral checks.
// Production / `tauri dev` builds keep the real `invoke`; the dev path is gated
// by an env flag in main.tsx and tree-shaken out otherwise.
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn = invoke as InvokeFn;

/** Dev-only: swap the IPC transport. Used by src/dev/mockBackend.ts. */
export function __setInvokeForDev(fn: InvokeFn): void {
  invokeImpl = fn;
}

export const api = {
  computeDiff: (target: Target): Promise<DiffSummary> =>
    invokeImpl("compute_diff", { target }),
  getFileDiff: (target: Target, path: string): Promise<FileDiff> =>
    invokeImpl("get_file_diff", { target, path }),
  listCommits: (target: Target): Promise<CommitMeta[]> =>
    invokeImpl("list_commits", { target }),
  openReview: (target: Target): Promise<ReviewSession> =>
    invokeImpl("open_review", { target }),
  refreshReview: (review: Review): Promise<ReviewSession> =>
    invokeImpl("refresh_review", { review }),
  saveReview: (review: Review): Promise<void> =>
    invokeImpl("save_review", { review }),
  exportReview: (review: Review): Promise<string> =>
    invokeImpl("export_review", { review }),
  // AI guidance: analyze the target's committed diff with the local `claude` CLI
  // (headless, --safe-mode) and return a structured walkthrough. Cached per diff
  // signature on the review; pass `force` to regenerate. (#guide)
  generateWalkthrough: (target: Target, force?: boolean): Promise<Walkthrough> =>
    invokeImpl("generate_walkthrough", { target, force }),
  // Presence of the local `claude` CLI — gates the walkthrough affordance.
  claudeStatus: (): Promise<ClaudeStatus> => invokeImpl("claude_status"),
  // Kill an in-flight walkthrough generation for this review (navigate-away / supersede).
  cancelWalkthrough: (reviewId: string): Promise<void> =>
    invokeImpl("cancel_walkthrough", { reviewId }),
  listRegistry: (): Promise<Registry> => invokeImpl("list_registry"),
  listPicker: (): Promise<PickerData> => invokeImpl("list_picker"),
  listWorktrees: (repoPath: string): Promise<WorktreeEntry[]> =>
    invokeImpl("list_worktrees", { repoPath }),
  importRepo: (): Promise<RepoEntry | null> => invokeImpl("import_repo"),
  openTarget: (repoPath: string, mode: DiffMode, base?: string): Promise<void> =>
    invokeImpl("open_target", { repoPath, mode, base }),
  // Re-point THIS window's fs watcher at a new target's worktree — used when a
  // review window navigates in place ("replace current" picker mode) so
  // auto-refresh follows the new repo. (#replace)
  rewatchWindow: (repoPath: string): Promise<void> =>
    invokeImpl("rewatch_window", { repoPath }),
  deleteReview: (id: string): Promise<void> => invokeImpl("delete_review", { id }),
  // Dev-only: open the Guide experience on mock fixtures in its own window. (#guide-dev)
  openGuide: (): Promise<void> => invokeImpl("open_guide"),
  installCli: (): Promise<InstallOutcome> => invokeImpl("install_cli"),
  cliStatus: (): Promise<CliStatus> => invokeImpl("cli_status"),
  // Open a file (or the repo root, when `file` is omitted) in the user's editor;
  // `line` jumps there where the editor's CLI supports it. (#editor)
  openInEditor: (editor: string, repoPath: string, file?: string, line?: number): Promise<void> =>
    invokeImpl("open_in_editor", { editor, repoPath, file, line }),
};
