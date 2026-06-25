// Dev-only fixture backend. Installed by main.tsx when VITE_MOCK_IPC is set so
// the frontend runs in a plain browser with no Tauri backend — the path used for
// autonomous UI/behavior verification (real layout, real git-diff-view render).
//
// Keep fixtures realistic but small. As Plan 2 adds commands (open_review,
// refresh_review, save_review, export_review) extend the switch + fixtures here.
import { __setInvokeForDev } from "../api";
import type { DiffSummary, FileDiff, Review, ReviewSession } from "../types";

const SUMMARY: DiffSummary = {
  baseLabel: "main",
  headLabel: "feat/auth",
  files: [
    { path: "src/auth/session.ts", status: "modified", additions: 3, deletions: 2, binary: false },
    { path: "src/auth/login.ts", status: "modified", additions: 1, deletions: 0, binary: false },
    { path: "README.md", status: "added", additions: 3, deletions: 0, binary: false },
  ],
};

const FILES: Record<string, FileDiff> = {
  "src/auth/session.ts": {
    oldFileName: "src/auth/session.ts",
    newFileName: "src/auth/session.ts",
    oldLang: "typescript",
    newLang: "typescript",
    status: "modified",
    binary: false,
    oldContent:
      "export function getSession(user) {\n  return cache.get(user.id)\n}\n\nexport const TTL = 3600\n",
    newContent:
      "export function getSession(user) {\n  // read-through to the store\n  return store.read(user.id)\n}\n\nexport const TTL = 7200\n",
  },
  "src/auth/login.ts": {
    oldFileName: "src/auth/login.ts",
    newFileName: "src/auth/login.ts",
    oldLang: "typescript",
    newLang: "typescript",
    status: "modified",
    binary: false,
    oldContent: "export function login(token) {\n  if (!token) return null\n  return verify(token)\n}\n",
    newContent:
      "export function login(token) {\n  if (!token) return null\n  return verify(token, { clockTolerance: 5 })\n}\n",
  },
  "README.md": {
    oldFileName: null,
    newFileName: "README.md",
    oldLang: null,
    newLang: "markdown",
    status: "added",
    binary: false,
    oldContent: null,
    newContent: "# delta\n\nReview code diffs and leave structured comments for Claude.\n",
  },
};

const REVIEW: Review = {
  version: 1,
  id: "mockid",
  target: { repoPath: "/Users/me/projects/demo", worktree: "feat/auth", mode: "all-changes" },
  snapshot: { baseOid: "a1b2c3d", headOid: null, capturedAt: "2026-06-25T18:54:00Z" },
  comments: [
    {
      id: "c1",
      scope: "line",
      anchor: { file: "src/auth/session.ts", side: "new", startLine: 3, endLine: null, snippet: "  return store.read(user.id)" },
      body: "Use the store, not the cache.",
      stale: false,
      createdAt: "2026-06-25T18:50:00Z",
      updatedAt: "2026-06-25T18:50:00Z",
    },
    {
      id: "c2",
      scope: "general",
      anchor: null,
      body: "Standardize error handling across `auth/`.",
      stale: false,
      createdAt: "2026-06-25T18:51:00Z",
      updatedAt: "2026-06-25T18:51:00Z",
    },
  ],
  viewed: [],
  createdAt: "2026-06-25T18:50:00Z",
  lastOpenedAt: "2026-06-25T18:54:00Z",
};

export function installMockBackend(): void {
  __setInvokeForDev(async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    switch (cmd) {
      case "compute_diff":
        return SUMMARY as T;
      case "get_file_diff":
        return FILES[(args?.path as string) ?? ""] as T;
      case "open_review":
      case "refresh_review": {
        const session: ReviewSession = { review: REVIEW, summary: SUMMARY };
        return structuredClone(session) as T;
      }
      case "save_review":
        return undefined as T;
      case "export_review":
        return "# Review — demo · feat/auth · All changes\n\n## General\n- Standardize error handling.\n" as T;
      default:
        throw new Error(`mockBackend: unhandled command "${cmd}"`);
    }
  });
  console.info("[delta] mock IPC backend installed (VITE_MOCK_IPC)");
}
