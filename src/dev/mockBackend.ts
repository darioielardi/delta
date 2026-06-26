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
    { path: "src/api/routes.ts", status: "modified", additions: 2, deletions: 2, binary: false },
    { path: "README.md", status: "added", additions: 3, deletions: 0, binary: false },
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
  const largeParam = typeof location !== "undefined" ? new URLSearchParams(location.search).get("large") : null;
  const ds = largeParam
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
        const session: ReviewSession = { review: ds.review, summary: ds.summary };
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
  console.info(`[delta] mock IPC backend installed (VITE_MOCK_IPC)${largeParam ? ` — large fixture: ${ds.summary.files.length} files` : ""}`);
}
