// Dev-only fixture backend. Installed by main.tsx when VITE_MOCK_IPC is set so
// the frontend runs in a plain browser with no Tauri backend — the path used for
// autonomous UI/behavior verification (real layout, real git-diff-view render).
//
// Keep fixtures realistic but small. As Plan 2 adds commands (open_review,
// refresh_review, save_review, export_review) extend the switch + fixtures here.
import { __setInvokeForDev } from "../api";
import type { DiffSummary, FileDiff, PickerData, Registry, Review, ReviewSession, Walkthrough } from "../types";

const SUMMARY: DiffSummary = {
  baseLabel: "main",
  headLabel: "feat/auth",
  files: [
    { path: "src/auth/session.ts", status: "modified", additions: 5, deletions: 3, binary: false },
    { path: "src/auth/login.ts", status: "modified", additions: 1, deletions: 1, binary: false },
    { path: "src/auth/tokens.ts", status: "added", additions: 17, deletions: 0, binary: false },
    { path: "src/auth/middleware.ts", status: "added", additions: 11, deletions: 0, binary: false },
    { path: "src/store/sessionStore.ts", status: "added", additions: 21, deletions: 0, binary: false },
    { path: "src/store/index.ts", status: "added", additions: 2, deletions: 0, binary: false },
    { path: "src/api/routes.ts", status: "modified", additions: 2, deletions: 2, binary: false },
    { path: "src/api/handlers/session.ts", status: "added", additions: 22, deletions: 0, binary: false },
    // Sparse changes far apart → a long unchanged middle that folds. (#10)
    { path: "src/config/limits.ts", status: "modified", additions: 2, deletions: 2, binary: false },
    { path: "src/config/env.ts", status: "modified", additions: 2, deletions: 0, binary: false },
    { path: "src/legacy/cache.ts", status: "deleted", additions: 0, deletions: 9, binary: false },
    { path: "src/legacy/memstore.ts", status: "deleted", additions: 0, deletions: 13, binary: false },
    { path: "tests/auth/session.test.ts", status: "added", additions: 14, deletions: 0, binary: false },
    { path: "tests/auth/login.test.ts", status: "added", additions: 7, deletions: 0, binary: false },
    { path: "package.json", status: "modified", additions: 3, deletions: 1, binary: false },
    { path: "pnpm-lock.yaml", status: "modified", additions: 3, deletions: 0, binary: false },
    { path: "docs/auth-sessions.md", status: "added", additions: 12, deletions: 0, binary: false },
    { path: "README.md", status: "added", additions: 6, deletions: 0, binary: false },
    { path: "assets/logo.png", status: "added", additions: 0, deletions: 0, binary: true },
  ],
};

// Commit fixtures for `?view=review&repo=demo` commit-by-commit review. Each commit
// "touches" a subset of SUMMARY's files (COMMIT_FILES), so stepping changes the file set.
const COMMITS = [
  { oid: "e4f1a2b0000000000000000000000000000000aa", shortOid: "e4f1a2b", subject: "wire login form into the page", author: "Dario", time: 1782700000 },
  { oid: "c9a30d40000000000000000000000000000000bb", shortOid: "c9a30d4", subject: "add session store", author: "Dario", time: 1782600000 },
  { oid: "a1b2c3d0000000000000000000000000000000cc", shortOid: "a1b2c3d", subject: "add auth guard to protected routes", author: "Dario", time: 1782500000 },
];
const COMMIT_FILES: Record<string, string[]> = {
  e4f1a2b0000000000000000000000000000000aa: ["src/auth/login.ts"],
  c9a30d40000000000000000000000000000000bb: ["src/auth/session.ts"],
  a1b2c3d0000000000000000000000000000000cc: ["src/api/routes.ts", "src/auth/session.ts"],
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
      `import { cache } from "../legacy/cache"\n\nexport function getSession(user) {\n  return cache.get(user.id)\n}\n\nexport function putSession(user, data) {\n  cache.set(user.id, data)\n}\n\nexport const TTL = 3600\n`,
    newContent:
      `import * as store from "../store/sessionStore"\n\nexport async function getSession(user) {\n  // read-through to the persistent store\n  return store.read(user.id)\n}\n\nexport async function putSession(user, data) {\n  await store.write(user.id, data)\n}\n\nexport const TTL = 7200\n`,
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
  "src/auth/tokens.ts": {
    oldFileName: null, newFileName: "src/auth/tokens.ts",
    oldLang: null, newLang: "typescript", status: "added", binary: false,
    oldContent: null,
    newContent:
      `import { sign, verify } from "jsonwebtoken"\nimport { env } from "../config/env"\n\nexport interface TokenPair {\n  access: string\n  refresh: string\n}\n\nexport function issue(userId: string): TokenPair {\n  const access = sign({ sub: userId }, env.JWT_SECRET, { expiresIn: "15m" })\n  const refresh = sign({ sub: userId, kind: "refresh" }, env.JWT_SECRET, { expiresIn: "30d" })\n  return { access, refresh }\n}\n\nexport function rotate(refresh: string): TokenPair {\n  const claims = verify(refresh, env.JWT_SECRET, { clockTolerance: 5 }) as { sub: string; kind?: string }\n  if (claims.kind !== "refresh") throw new Error("not a refresh token")\n  return issue(claims.sub)\n}\n`,
  },
  "src/auth/middleware.ts": {
    oldFileName: null, newFileName: "src/auth/middleware.ts",
    oldLang: null, newLang: "typescript", status: "added", binary: false,
    oldContent: null,
    newContent:
      `import type { Request, Response, NextFunction } from "express"\nimport { sessionStore } from "../store"\n\nexport async function requireSession(req: Request, res: Response, next: NextFunction) {\n  const userId = req.header("x-user-id")\n  if (!userId) return res.status(401).json({ error: "no session" })\n  const session = await sessionStore.read(userId)\n  if (!session) return res.status(401).json({ error: "session expired" })\n  req.session = session\n  next()\n}\n`,
  },
  "src/store/sessionStore.ts": {
    oldFileName: null, newFileName: "src/store/sessionStore.ts",
    oldLang: null, newLang: "typescript", status: "added", binary: false,
    oldContent: null,
    newContent:
      `import type { Session } from "../auth/types"\nimport { db } from "../db/client"\nimport { env } from "../config/env"\n\nexport async function read(userId: string): Promise<Session | null> {\n  const row = await db.sessions.findById(userId)\n  if (!row) return null\n  if (Date.now() - row.touchedAt > env.SESSION_TTL_MS) {\n    await db.sessions.delete(userId)\n    return null\n  }\n  return row.session\n}\n\nexport async function write(userId: string, session: Session): Promise<void> {\n  await db.sessions.upsert({ userId, session, touchedAt: Date.now() })\n}\n\nexport async function evict(userId: string): Promise<void> {\n  await db.sessions.delete(userId)\n}\n`,
  },
  "src/store/index.ts": {
    oldFileName: null, newFileName: "src/store/index.ts",
    oldLang: null, newLang: "typescript", status: "added", binary: false,
    oldContent: null,
    newContent: `export * as sessionStore from "./sessionStore"\nexport { db } from "../db/client"\n`,
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
  "src/api/handlers/session.ts": {
    oldFileName: null, newFileName: "src/api/handlers/session.ts",
    oldLang: null, newLang: "typescript", status: "added", binary: false,
    oldContent: null,
    newContent:
      `import type { Request, Response } from "express"\nimport { sessionStore } from "../../store"\nimport { issue, rotate } from "../../auth/tokens"\n\nexport async function create(req: Request, res: Response) {\n  const { userId } = req.body\n  const tokens = issue(userId)\n  await sessionStore.write(userId, { userId, createdAt: Date.now() })\n  res.json(tokens)\n}\n\nexport async function refresh(req: Request, res: Response) {\n  try {\n    res.json(rotate(req.body.refresh))\n  } catch {\n    res.status(401).json({ error: "invalid refresh token" })\n  }\n}\n\nexport async function revoke(req: Request, res: Response) {\n  await sessionStore.evict(req.params.userId)\n  res.status(204).end()\n}\n`,
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
  "src/config/env.ts": {
    oldFileName: "src/config/env.ts", newFileName: "src/config/env.ts",
    oldLang: "typescript", newLang: "typescript", status: "modified", binary: false,
    oldContent: `export const env = {\n  PORT: Number(process.env.PORT ?? 3000),\n  DATABASE_URL: process.env.DATABASE_URL ?? "",\n}\n`,
    newContent: `export const env = {\n  PORT: Number(process.env.PORT ?? 3000),\n  DATABASE_URL: process.env.DATABASE_URL ?? "",\n  JWT_SECRET: process.env.JWT_SECRET ?? "dev-secret",\n  SESSION_TTL_MS: Number(process.env.SESSION_TTL_MS ?? 7_200_000),\n}\n`,
  },
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
  "src/legacy/memstore.ts": {
    oldFileName: "src/legacy/memstore.ts", newFileName: null,
    oldLang: "typescript", newLang: null, status: "deleted", binary: false,
    oldContent:
      `const sessions = new Map()\n\nexport function get(key) {\n  return sessions.get(key)\n}\n\nexport function put(key, value) {\n  sessions.set(key, value)\n}\n\nexport function drop(key) {\n  sessions.delete(key)\n}\n`,
    newContent: null,
  },
  "tests/auth/session.test.ts": {
    oldFileName: null, newFileName: "tests/auth/session.test.ts",
    oldLang: null, newLang: "typescript", status: "added", binary: false,
    oldContent: null,
    newContent:
      `import { describe, it, expect } from "vitest"\nimport { read, write, evict } from "../../src/store/sessionStore"\n\ndescribe("sessionStore", () => {\n  it("round-trips a session", async () => {\n    await write("u1", { userId: "u1", createdAt: Date.now() })\n    expect(await read("u1")).not.toBeNull()\n  })\n\n  it("evicts on demand", async () => {\n    await write("u2", { userId: "u2", createdAt: Date.now() })\n    await evict("u2")\n    expect(await read("u2")).toBeNull()\n  })\n})\n`,
  },
  "tests/auth/login.test.ts": {
    oldFileName: null, newFileName: "tests/auth/login.test.ts",
    oldLang: null, newLang: "typescript", status: "added", binary: false,
    oldContent: null,
    newContent:
      `import { describe, it, expect } from "vitest"\nimport { login } from "../../src/auth/login"\n\ndescribe("login", () => {\n  it("rejects an empty token", () => {\n    expect(login("")).toBeNull()\n  })\n})\n`,
  },
  "package.json": {
    oldFileName: "package.json", newFileName: "package.json",
    oldLang: "json", newLang: "json", status: "modified", binary: false,
    oldContent: `{\n  "name": "delta-api",\n  "version": "0.3.0",\n  "dependencies": {\n    "express": "^4.19.0"\n  }\n}\n`,
    newContent: `{\n  "name": "delta-api",\n  "version": "0.4.0",\n  "dependencies": {\n    "express": "^4.19.0",\n    "jsonwebtoken": "^9.0.2"\n  }\n}\n`,
  },
  "pnpm-lock.yaml": {
    oldFileName: "pnpm-lock.yaml", newFileName: "pnpm-lock.yaml",
    oldLang: "yaml", newLang: "yaml", status: "modified", binary: false,
    oldContent: `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      express:\n        specifier: ^4.19.0\n        version: 4.19.2\n`,
    newContent: `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      express:\n        specifier: ^4.19.0\n        version: 4.19.2\n      jsonwebtoken:\n        specifier: ^9.0.2\n        version: 9.0.2\n`,
  },
  "docs/auth-sessions.md": {
    oldFileName: null, newFileName: "docs/auth-sessions.md",
    oldLang: null, newLang: "markdown", status: "added", binary: false,
    oldContent: null,
    newContent:
      `# Session handling\n\nSessions are persisted via src/store/sessionStore.ts and expire after\nSESSION_TTL_MS of inactivity.\n\n## Flow\n\n1. POST /sessions issues an access + refresh token pair.\n2. The access token lasts 15m; rotate it with the refresh token.\n3. The requireSession middleware guards protected routes.\n\nThe legacy in-memory cache under src/legacy/ is removed.\n`,
  },
  "README.md": {
    oldFileName: null,
    newFileName: "README.md",
    oldLang: null,
    newLang: "markdown",
    status: "added",
    binary: false,
    oldContent: null,
    newContent: `# delta\n\nReview code diffs and leave structured comments for Claude.\n\n## Auth\n\nSessions now persist in a store; see docs/auth-sessions.md.\n`,
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
      resolved: false,
      createdAt: "2026-06-25T18:50:00Z",
      updatedAt: "2026-06-25T18:50:00Z",
    },
    {
      id: "c2",
      scope: "general",
      anchor: null,
      body: "Standardize error handling across `auth/`.",
      stale: false,
      resolved: false,
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
      resolved: true,
      createdAt: "2026-06-25T18:52:00Z",
      updatedAt: "2026-06-25T18:52:00Z",
    },
  ],
  viewed: [],
  createdAt: "2026-06-25T18:50:00Z",
  lastOpenedAt: "2026-06-25T18:54:00Z",
};

// Canned AI-guidance walkthrough for the small fixture — a realistic "feat/auth"
// narrative spanning core/supporting/skim groups, both risk severities, and an
// ignored (noise) bucket. Mirrors the files in SUMMARY.
const WALKTHROUGH: Walkthrough = {
  version: 1,
  title: "Persistent auth session store",
  summary:
    "Migrates auth sessions from the in-memory cache to a persistent store, adds JWT issue/refresh, and guards routes with session middleware. The `src/auth` + `src/store` work is the core; tests, config, and docs follow.",
  groups: [
    {
      id: "session-store-migration",
      title: "Session store migration",
      summary: "`getSession()`/`putSession()` now read and write the persistent store; the legacy cache + memstore are deleted and TTL doubles to `7200`.",
      order: 1,
      importance: "core",
      files: [
        { path: "src/store/sessionStore.ts", note: "the new store", collapsed: false },
        { path: "src/store/index.ts", note: "barrel", collapsed: true },
        { path: "src/auth/session.ts", note: "cache → store", collapsed: false },
        { path: "src/legacy/cache.ts", note: "deleted", collapsed: true },
        { path: "src/legacy/memstore.ts", note: "deleted", collapsed: true },
      ],
      risks: [
        { path: "src/auth/session.ts", line: 5, severity: "caution", note: "Reads now hit the store and TTL doubles to 7200 — confirm it matches the cache’s eviction semantics." },
      ],
    },
    {
      id: "tokens",
      title: "Token issue & refresh",
      summary: "Adds JWT issue/rotate and a `requireSession` guard; `login()` gains clock tolerance.",
      order: 2,
      importance: "supporting",
      files: [
        { path: "src/auth/tokens.ts", note: "issue + rotate", collapsed: false },
        { path: "src/auth/login.ts", note: "clockTolerance: 5", collapsed: false },
        { path: "src/auth/middleware.ts", note: "requireSession guard", collapsed: false },
      ],
      risks: [
        { path: "src/auth/login.ts", line: 3, severity: "watch", note: "Widening the JWT acceptance window (clockTolerance: 5) is security-relevant — intended?" },
        { path: "src/auth/tokens.ts", line: 14, severity: "watch", note: "Refresh tokens live 30 days — make sure rotate() invalidates the previous one." },
      ],
    },
    {
      id: "session-api",
      title: "Session API surface",
      summary: "New create/refresh/revoke handlers behind the session routes; `src/api/routes.ts` gains `includeRevoked` + `geoHint` params.",
      order: 3,
      importance: "supporting",
      files: [
        { path: "src/api/handlers/session.ts", note: "create / refresh / revoke", collapsed: false },
        { path: "src/api/routes.ts", note: "new query params", collapsed: false },
      ],
      risks: [],
    },
    {
      id: "config-deps",
      title: "Config & deps",
      summary: "New env vars (`JWT_SECRET`, `SESSION_TTL_MS`), limit bumps, and the `jsonwebtoken` dependency.",
      order: 4,
      importance: "skim",
      files: [
        { path: "src/config/env.ts", note: "JWT_SECRET, SESSION_TTL_MS", collapsed: false },
        { path: "src/config/limits.ts", note: "constant bumps", collapsed: true },
        { path: "package.json", note: "+ jsonwebtoken", collapsed: true },
      ],
      risks: [],
    },
    {
      id: "tests",
      title: "Tests",
      summary: "Coverage for the store round-trip and the login guard.",
      order: 5,
      importance: "skim",
      files: [
        { path: "tests/auth/session.test.ts", note: "store round-trip", collapsed: true },
        { path: "tests/auth/login.test.ts", note: "empty-token guard", collapsed: true },
      ],
      risks: [],
    },
    {
      id: "docs",
      title: "Docs",
      summary: "Session-flow write-up and a `README.md` pointer.",
      order: 6,
      importance: "skim",
      files: [
        { path: "docs/auth-sessions.md", note: "session flow", collapsed: true },
        { path: "README.md", note: "auth section", collapsed: true },
      ],
      risks: [],
    },
  ],
  ignored: [
    { path: "pnpm-lock.yaml", reason: "lockfile" },
    { path: "assets/logo.png", reason: "binary asset" },
  ],
};

// Build a plausible walkthrough for the `?large=N` fixture so the panel isn't
// empty there: bucket files by kind, push the giant auto-collapse files to the
// ignored bin, and skim the css/md.
function genLargeWalkthrough(summary: DiffSummary): Walkthrough {
  const paths = summary.files.map((f) => f.path);
  const giants = paths.filter((p) => /module\d+/.test(p) && /(008|025|042|059|076|093)\./.test(p));
  const giantSet = new Set(giants);
  const code = paths.filter((p) => /\.(ts|tsx)$/.test(p) && !giantSet.has(p));
  const styleDocs = paths.filter((p) => /\.(css|md)$/.test(p) && !giantSet.has(p));
  const cap = <T,>(a: T[], n: number) => a.slice(0, n);
  return {
    version: 1,
    title: "Broad refactor across modules",
    summary: `Broad change across ${summary.files.length} files. The bulk is mechanical edits to shared modules; a handful of large files and generated config are noise you can skip.`,
    groups: [
      {
        id: "core-modules", title: "Core module edits", order: 1, importance: "core",
        summary: "The substantive logic changes live in these shared modules.",
        files: cap(code, 6).map((p, i) => ({ path: p, note: i === 0 ? "primary change" : undefined, collapsed: false })),
        risks: code.length ? [{ path: code[0], line: 4, severity: "watch" as const, note: "Touches a shared compute() path used widely — verify call sites." }] : [],
      },
      {
        id: "supporting", title: "Supporting edits", order: 2, importance: "supporting",
        summary: "Smaller follow-on edits in the same direction.",
        files: cap(code.slice(6), 8).map((p) => ({ path: p, collapsed: false })),
        risks: [],
      },
      {
        id: "styles-docs", title: "Styles & docs", order: 3, importance: "skim",
        summary: "Stylesheet and markdown churn — safe to skim.",
        files: cap(styleDocs, 8).map((p) => ({ path: p, collapsed: true })),
        risks: [],
      },
    ],
    ignored: giants.map((p) => ({ path: p, reason: "large file" })),
  };
}

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
      resolvedCount: 1,
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
      resolvedCount: 0,
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
      comments.push({ id: `gc${i}`, scope: "line", anchor: { file: path, side: "new", startLine: 4, endLine: null, snippet: "  const v3 = compute(3, ...)" }, body: `Review note on ${path}: verify this path.`, stale: i % 7 === 0, resolved: i % 5 === 0, createdAt: "2026-06-25T18:50:00Z", updatedAt: "2026-06-25T18:50:00Z" });
    }
    if (i % 9 === 3) {
      comments.push({ id: `gr${i}`, scope: "range", anchor: { file: path, side: "new", startLine: 6, endLine: 9, snippet: "range" }, body: `Range comment on ${path}.`, stale: false, resolved: false, createdAt: "2026-06-25T18:50:00Z", updatedAt: "2026-06-25T18:50:00Z" });
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
  // `?empty=1` → a review with no changed files, to exercise the empty state (which
  // lists the repo's other worktrees). `?empty=solo` → same empty review, but
  // list_worktrees returns only the current worktree, so the no-siblings placeholder
  // shows instead. `?empty=many` → many siblings, to exercise the 5-row scroll cap.
  const emptyKind = params.get("empty"); // "1" | "solo" | "many" | null
  const emptyParam = emptyKind === "1" || emptyKind === "solo" || emptyKind === "many";
  const ds = emptyParam
    ? { summary: { ...SUMMARY, files: [] }, files: {}, review: { ...REVIEW, comments: [], viewed: [] } }
    : largeParam
      ? genLarge(Math.max(1, Math.min(2000, parseInt(largeParam, 10) || 80)))
      : { summary: SUMMARY, files: FILES, review: REVIEW };
  __setInvokeForDev(async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    switch (cmd) {
      case "compute_diff": {
        const t = args?.target as { mode?: string; commit?: string } | undefined;
        if (t?.mode === "commit" && t.commit) {
          const set = new Set(COMMIT_FILES[t.commit] ?? []);
          return { ...ds.summary, files: ds.summary.files.filter((f) => set.has(f.path)) } as T;
        }
        return ds.summary as T;
      }
      case "get_file_diff":
        return ds.files[(args?.path as string) ?? ""] as T;
      case "list_commits":
        return COMMITS as T;
      case "open_review":
      case "refresh_review": {
        const session: ReviewSession = { review: ds.review, summary: ds.summary, repoName: "demo" };
        return structuredClone(session) as T;
      }
      case "save_review":
        return undefined as T;
      case "export_review": {
        const open = ds.review.comments.filter((c) => !c.resolved);
        const lines = open.map((c) => {
          const loc = c.anchor ? `${c.anchor.file}${c.anchor.startLine ? `:${c.anchor.startLine}` : ""}` : "general";
          return `- [${loc}] ${c.body}`;
        });
        return `# Review — demo · feat/auth · All changes\n\n${lines.join("\n")}\n` as T;
      }
      case "generate_walkthrough": {
        // Simulate `claude` CLI latency so the panel's loading state is exercised.
        await new Promise((r) => setTimeout(r, 450));
        return (largeParam ? genLargeWalkthrough(ds.summary) : WALKTHROUGH) as T;
      }
      case "list_worktrees": {
        // Varied timestamps + dirty flags exercise the recency sort and the
        // enriched worktree picker (#1/#6).
        const all = [
          { path: "/Users/me/projects/demo", branch: "feat/auth", isMain: true, lastCommitAt: "2026-06-26T09:30:00Z", dirty: true },
          { path: "/Users/me/projects/demo-main", branch: "main", isMain: false, lastCommitAt: "2026-06-20T12:00:00Z", dirty: false },
          { path: "/Users/me/projects/demo-spike", branch: "spike/new-idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false },
        ];
        // `?empty=solo` → only the current worktree, so the empty-review screen has no
        // siblings to list and shows its placeholder instead.
        if (emptyKind === "solo") return all.filter((w) => w.path === "/Users/me/projects/demo") as T;
        // `?empty=many` → current + 7 extra siblings, to exercise the 5-row scroll cap.
        if (emptyKind === "many") {
          const extra = Array.from({ length: 7 }, (_, i) => ({
            path: `/Users/me/projects/demo-wt${i + 1}`,
            branch: `feat/topic-${i + 1}`,
            isMain: false,
            lastCommitAt: `2026-06-${String(18 - i).padStart(2, "0")}T12:00:00Z`,
            dirty: i % 3 === 0,
          }));
          return [all[0], ...extra] as T;
        }
        return all as T;
      }
      case "import_repo":
        // `?import=nonrepo` → reject like the backend does for a non-git folder, to
        // exercise the "Can't add repository" modal.
        if (params.get("import") === "nonrepo") {
          throw new Error("/Users/me/Downloads is not a git repository.");
        }
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
      case "open_guide":
        // No Tauri windows in the browser — open the guide route in a new tab.
        if (typeof window !== "undefined") window.open("?view=guide&mock=1", "_blank");
        return undefined as T;
      case "rewatch_window":
        // No real fs watcher in the browser mock — the in-place navigation does
        // the visible work. (#replace)
        console.info("[delta mock] rewatch_window", args);
        return undefined as T;
      case "list_registry":
        return structuredClone(REGISTRY) as T;
      case "list_picker": {
        // `?empty=1` → no recents/worktrees, to exercise the first-launch empty state.
        // Otherwise: feat/auth + main have reviews (see REGISTRY.reviews) → only the
        // spike worktree shows under "other worktrees".
        const data: PickerData = emptyParam
          ? { home: REGISTRY.home, recents: [], worktrees: [] }
          : {
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
      case "install_cli": {
        // `?cli=path` / `?cli=manual` exercise the other install outcomes in mock.
        const variant = params.get("cli");
        if (variant === "manual")
          return {
            kind: "manualNeeded",
            command: "sudo ln -sf '/Applications/delta.app/Contents/MacOS/delta' /usr/local/bin/delta",
            reason: "No writable directory found on your PATH.",
          } as T;
        if (variant === "path")
          return { kind: "linkedPathUpdated", path: "/Users/me/.local/bin/delta", shells: ["zsh", "fish"] } as T;
        return { kind: "linked", path: "/usr/local/bin/delta" } as T;
      }
      case "cli_status":
        // Default: not installed so the header CTA shows. `?cli=installed` hides it.
        return {
          installed: params.get("cli") === "installed",
          path: params.get("cli") === "installed" ? "/usr/local/bin/delta" : null,
        } as T;
      case "open_in_editor":
        console.info("[delta mock] open_in_editor", args);
        return undefined as T;
      default:
        throw new Error(`mockBackend: unhandled command "${cmd}"`);
    }
  });
  console.info(`[delta] mock IPC backend installed (VITE_MOCK_IPC)${largeParam ? ` — large fixture: ${ds.summary.files.length} files` : ""}`);
}
