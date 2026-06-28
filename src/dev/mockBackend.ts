// Dev-only fixture backend. Installed by main.tsx when VITE_MOCK_IPC is set so
// the frontend runs in a plain browser with no Tauri backend — the path used for
// autonomous UI/behavior verification (real layout, real git-diff-view render).
//
// Keep fixtures realistic but small. As Plan 2 adds commands (open_review,
// refresh_review, save_review, export_review) extend the switch + fixtures here.
import { __setInvokeForDev } from "../api";
import type { DiffSummary, FileDiff, PickerData, Registry, Review, ReviewSession } from "../types";

const SUMMARY: DiffSummary = {
  baseLabel: "main",
  headLabel: "feat/auth",
  files: [
    { path: "src/auth/session.ts", status: "modified", additions: 3, deletions: 2, binary: false },
    { path: "src/auth/login.ts", status: "modified", additions: 1, deletions: 0, binary: false },
    { path: "src/api/routes.ts", status: "modified", additions: 2, deletions: 2, binary: false },
    // Sparse changes far apart → a long unchanged middle that folds. (#10)
    { path: "src/config/limits.ts", status: "modified", additions: 2, deletions: 2, binary: false },
    { path: "src/legacy/cache.ts", status: "deleted", additions: 0, deletions: 9, binary: false },
    { path: "README.md", status: "added", additions: 3, deletions: 0, binary: false },
    { path: "assets/logo.png", status: "added", additions: 0, deletions: 0, binary: true },
  ],
};

// A deliberately wide file: several lines far exceed the pane width so the diff
// renders a horizontal scrollbar. Used to verify wheel behavior (item 1) — that
// vertical scroll still works while the cursor is over a horizontally-scrollable
// file.
const ROUTES_OLD =
  `import { Router } from "@/server/router";\n` +
  `const router = new Router();\n` +
  `router.register("GET", "/api/v1/users/:userId/sessions/:sessionId/activity", async (req, res) => handleUserSessionActivityLookupWithPaginationAndFiltering(req.params.userId, req.params.sessionId, req.query.cursor, req.query.limit, req.query.sortOrder));\n` +
  `router.register("POST", "/api/v1/users/:userId/sessions", async (req, res) => createSessionForUserWithDeviceFingerprintingAndRiskScoring(req.params.userId, req.body.deviceId, req.body.fingerprint, req.body.ipAddress, req.body.userAgent));\n` +
  `router.register("DELETE", "/api/v1/users/:userId/sessions/:sessionId", async (req, res) => revokeSessionAndInvalidateAllDerivedTokensAcrossDevices(req.params.userId, req.params.sessionId));\n` +
  `export default router;\n`;
const ROUTES_NEW =
  `import { Router } from "@/server/router";\n` +
  `const router = new Router();\n` +
  `router.register("GET", "/api/v1/users/:userId/sessions/:sessionId/activity", async (req, res) => handleUserSessionActivityLookupWithPaginationAndFiltering(req.params.userId, req.params.sessionId, req.query.cursor, req.query.limit, req.query.sortOrder, req.query.includeRevoked));\n` +
  `router.register("POST", "/api/v1/users/:userId/sessions", async (req, res) => createSessionForUserWithDeviceFingerprintingAndRiskScoring(req.params.userId, req.body.deviceId, req.body.fingerprint, req.body.ipAddress, req.body.userAgent, req.body.geoHint));\n` +
  `router.register("DELETE", "/api/v1/users/:userId/sessions/:sessionId", async (req, res) => revokeSessionAndInvalidateAllDerivedTokensAcrossDevices(req.params.userId, req.params.sessionId));\n` +
  `export default router;\n`;

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
  "src/api/routes.ts": {
    oldFileName: "src/api/routes.ts",
    newFileName: "src/api/routes.ts",
    oldLang: "typescript",
    newLang: "typescript",
    status: "modified",
    binary: false,
    oldContent: ROUTES_OLD,
    newContent: ROUTES_NEW,
  },
  // Two changes far apart (line 2 + the second-to-last line) with a long unchanged
  // middle, so the diff folds the gap — and it's big enough to expand 25-by-25. (#10/#2)
  "src/config/limits.ts": (() => {
    const file = (retries: number, keepalive: number): string => {
      const lines = [
        "// Runtime limits and tunables for the API layer.",
        `export const MAX_RETRIES = ${retries}`,
      ];
      for (let i = 0; i < 56; i++) lines.push(`export const LIMIT_${String(i).padStart(2, "0")} = ${1000 + i * 25}`);
      lines.push(`export const KEEPALIVE_MS = ${keepalive}`, "export const DRAIN_TIMEOUT_MS = 8000");
      return lines.join("\n") + "\n";
    };
    return {
      oldFileName: "src/config/limits.ts", newFileName: "src/config/limits.ts",
      oldLang: "typescript", newLang: "typescript", status: "modified", binary: false,
      oldContent: file(3, 30_000), newContent: file(5, 45_000),
    };
  })(),
  // Deleted file: only old content exists. Used to verify deleted files are
  // hidden behind a reveal (item 3) rather than rendered/collapsed like others.
  "src/legacy/cache.ts": {
    oldFileName: "src/legacy/cache.ts",
    newFileName: null,
    oldLang: "typescript",
    newLang: null,
    status: "deleted",
    binary: false,
    oldContent:
      "const store = new Map()\n\nexport function get(key) {\n  return store.get(key)\n}\n\nexport function set(key, value) {\n  store.set(key, value)\n}\n",
    newContent: null,
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
  // Binary file: exercises the "Unsupported file" treatment in the diff view.
  "assets/logo.png": {
    oldFileName: null,
    newFileName: "assets/logo.png",
    oldLang: null,
    newLang: null,
    status: "added",
    binary: true,
    oldContent: null,
    newContent: null,
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
    // Range comment → exercises the multi-line highlight (#7) over context lines.
    {
      id: "c3",
      scope: "range",
      anchor: { file: "src/config/limits.ts", side: "new", startLine: 3, endLine: 5, snippet: "export const RETRY_BACKOFF_MS = 250\nexport const REQUEST_TIMEOUT_MS = 5000\nexport const MAX_PAYLOAD_BYTES = 1_048_576" },
      body: "These three belong in env config, not hardcoded.",
      stale: false,
      createdAt: "2026-06-25T18:52:00Z",
      updatedAt: "2026-06-25T18:52:00Z",
    },
  ],
  viewed: [],
  createdAt: "2026-06-25T18:50:00Z",
  lastOpenedAt: "2026-06-25T18:54:00Z",
};

const REGISTRY: Registry = {
  version: 1,
  home: "/Users/me",
  repos: [
    {
      id: "r1",
      root: "/Users/me/projects/demo",
      name: "demo",
      defaultBranch: "main",
      worktrees: [
        { path: "/Users/me/projects/demo", branch: "feat/auth", isMain: true },
        { path: "/Users/me/projects/demo-main", branch: "main", isMain: false },
      ],
    },
  ],
  reviews: [
    {
      id: "abc123",
      repoName: "demo",
      target: { repoPath: "/Users/me/projects/demo/.worktrees/feat-auth-wt", worktree: "feat/auth", mode: "all-changes", base: "main" },
      lastOpenedAt: "2026-06-26T10:00:00Z",
      commentCount: 3,
      staleCount: 1,
      viewedCount: 2,
      fileCount: 7,
    },
    {
      id: "def456",
      repoName: "demo",
      target: { repoPath: "/Users/me/projects/demo", worktree: "main", mode: "uncommitted" },
      lastOpenedAt: "2026-06-25T09:00:00Z",
      commentCount: 0,
      staleCount: 0,
      viewedCount: 0,
      fileCount: 2,
    },
  ],
};

// ---------------------------------------------------------------------------
// Large synthetic fixture for performance profiling. Activated with `?large=N`
// (file count) on the dev:mock URL; absent, the small fixture above is served
// and nothing changes. Deterministic (index-based, no random) so runs compare.
// ---------------------------------------------------------------------------
const LANG: Record<string, string> = { ts: "typescript", tsx: "typescript", css: "css", md: "markdown", json: "json" };
const DIRS = [
  "src/auth", "src/api/handlers", "src/components/ui", "src/components/forms",
  "src/lib/util", "src/hooks", "src/pages/admin", "src/pages/dashboard/widgets",
  "src/store/slices", "tests/unit",
];
const EXTS = ["ts", "tsx", "tsx", "css", "md", "json"];

function genFile(path: string, n: number, variant: 0 | 1, churn: number, ext: string): string {
  const step = churn >= 1 ? 1 : Math.max(2, Math.round(1 / churn));
  const changed = (i: number) => variant === 1 && i % step === 1;
  if (ext === "md") {
    const out = [`# ${path}`, ""];
    for (let i = 0; i < n; i++) out.push(changed(i) ? `- updated item ${i} with more detail` : `- item ${i}`);
    return out.join("\n") + "\n";
  }
  if (ext === "json") {
    const out = ["{"];
    for (let i = 0; i < n; i++) out.push(`  "key_${i}": ${changed(i) ? i + 1 : i},`);
    out.push(`  "last": true`, "}");
    return out.join("\n") + "\n";
  }
  if (ext === "css") {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(`.cls-${i} {`, `  margin: ${changed(i) ? i + 2 : i}px;`, "}");
    return out.join("\n") + "\n";
  }
  const out = [`import { compute, store } from "@/lib/util/module000";`, "", `export function run_${n}() {`];
  for (let i = 0; i < n; i++) {
    out.push(changed(i)
      ? `  const v${i} = compute(${i} + 1, ${JSON.stringify(path)}, { retries: 2 });`
      : `  const v${i} = compute(${i}, ${JSON.stringify(path)});`);
  }
  out.push("  return store.read();", "}");
  return out.join("\n") + "\n";
}

function genLarge(fileCount: number): { summary: DiffSummary; files: Record<string, FileDiff>; review: Review } {
  const files: DiffSummary["files"] = [];
  const fileDiffs: Record<string, FileDiff> = {};
  const comments: Review["comments"] = [];
  for (let i = 0; i < fileCount; i++) {
    const ext = EXTS[i % EXTS.length];
    const path = `${DIRS[i % DIRS.length]}/module${String(i).padStart(3, "0")}.${ext}`;
    const giant = i % 17 === 8; // a few genuinely huge files that auto-collapse
    const n = giant ? 900 + (i % 4) * 200 : 150 + (i % 9) * 40; // non-giant 150..470 lines, stays expanded
    const churn = giant ? 1 : 0.4;
    const changed = churn >= 1 ? n : Math.max(1, Math.round(n * churn));
    files.push({ path, status: "modified", additions: changed + 4, deletions: changed, binary: false });
    fileDiffs[path] = {
      oldFileName: path, newFileName: path, oldLang: LANG[ext], newLang: LANG[ext],
      status: "modified", binary: false,
      oldContent: genFile(path, n, 0, churn, ext), newContent: genFile(path, n, 1, churn, ext),
    };
    if (i % 4 === 0) {
      comments.push({ id: `gc${i}`, scope: "line", anchor: { file: path, side: "new", startLine: 4, endLine: null, snippet: "  const v3 = compute(3, ...)" }, body: `Review note on ${path}: verify this path.`, stale: i % 7 === 0, createdAt: "2026-06-25T18:50:00Z", updatedAt: "2026-06-25T18:50:00Z" });
    }
    if (i % 9 === 3) {
      comments.push({ id: `gr${i}`, scope: "range", anchor: { file: path, side: "new", startLine: 6, endLine: 9, snippet: "range" }, body: `Range comment on ${path}.`, stale: false, createdAt: "2026-06-25T18:50:00Z", updatedAt: "2026-06-25T18:50:00Z" });
    }
  }
  return {
    summary: { baseLabel: "main", headLabel: "feat/big", files },
    files: fileDiffs,
    review: { ...REVIEW, comments, target: { ...REVIEW.target, worktree: "feat/big" } },
  };
}

export function installMockBackend(): void {
  const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const largeParam = params.get("large");
  // `?empty=1` → a review with no changed files, to exercise the empty state.
  const emptyParam = params.get("empty") === "1";
  const ds = emptyParam
    ? { summary: { ...SUMMARY, files: [] }, files: {}, review: { ...REVIEW, comments: [], viewed: [] } }
    : largeParam
      ? genLarge(Math.max(1, Math.min(2000, parseInt(largeParam, 10) || 80)))
      : { summary: SUMMARY, files: FILES, review: REVIEW };
  __setInvokeForDev(async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    switch (cmd) {
      case "compute_diff":
        return ds.summary as T;
      case "get_file_diff":
        return ds.files[(args?.path as string) ?? ""] as T;
      case "open_review":
      case "refresh_review": {
        const session: ReviewSession = { review: ds.review, summary: ds.summary, repoName: "demo" };
        return structuredClone(session) as T;
      }
      case "save_review":
        return undefined as T;
      case "export_review":
        return "# Review — demo · feat/auth · All changes\n\n## General\n- Standardize error handling.\n" as T;
      case "list_worktrees":
        // Varied timestamps + dirty flags exercise the recency sort and the
        // enriched worktree picker (#1/#6).
        return [
          { path: "/Users/me/projects/demo", branch: "feat/auth", isMain: true, lastCommitAt: "2026-06-26T09:30:00Z", dirty: true },
          { path: "/Users/me/projects/demo-main", branch: "main", isMain: false, lastCommitAt: "2026-06-20T12:00:00Z", dirty: false },
          { path: "/Users/me/projects/demo-spike", branch: "spike/new-idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false },
        ] as T;
      case "import_repo":
        return {
          id: "imported",
          root: "/Users/me/projects/imported",
          name: "imported",
          defaultBranch: "main",
          worktrees: [{ path: "/Users/me/projects/imported", branch: "main", isMain: true }],
        } as T;
      case "open_target":
        console.info("[delta mock] open_target", args);
        return undefined as T;
      case "list_registry":
        return structuredClone(REGISTRY) as T;
      case "list_picker": {
        // feat/auth + main have reviews (see REGISTRY.reviews) → only the spike
        // worktree shows under "other worktrees".
        const data: PickerData = {
          home: REGISTRY.home,
          recents: REGISTRY.reviews,
          worktrees: [
            { path: "/Users/me/projects/demo/.worktrees/spike", branch: "spike/new-idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false, repoName: "demo", repoId: "r1" },
          ],
        };
        return structuredClone(data) as T;
      }
      case "delete_review":
        console.info("[delta mock] delete_review", args);
        return undefined as T;
      case "install_cli":
        return { kind: "linked", path: "/usr/local/bin/delta" } as T;
      case "open_in_editor":
        console.info("[delta mock] open_in_editor", args);
        return undefined as T;
      default:
        throw new Error(`mockBackend: unhandled command "${cmd}"`);
    }
  });
  console.info(`[delta] mock IPC backend installed (VITE_MOCK_IPC)${largeParam ? ` — large fixture: ${ds.summary.files.length} files` : ""}`);
}
