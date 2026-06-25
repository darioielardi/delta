# delta — Design Spec

**Date:** 2026-06-25
**Status:** Approved for planning
**Topic:** A fast, native-feeling desktop app for reviewing code changes and leaving structured comments for AI assistants (primarily Claude Code).

---

## 1. Summary

delta is a local-first desktop app for reviewing a body of code changes and attaching structured comments to it. It is **not** a Git client, a GitHub client, or an IDE. The mental model is **"Notes.app for code diffs"**: a lightweight workspace where you inspect changes, leave comments, and later hand those comments to Claude Code to act on.

The primary workflow is **reviewing work done with/by Claude**: Claude edits code (some committed, some uncommitted, split across commits at any moment), you review the *whole current state* of that work, leave comments, and export them back to Claude.

## 2. Core principles

- Extremely fast startup (<1s target).
- Native-feeling UI and keyboard navigation.
- Local-first; no account, no cloud, no auth, no sync.
- No GitHub integration, no PRs.
- No code editing, no merge-conflict resolution, no git staging, no commit-history browsing.
- No AI chat inside the app.
- No MCP yet — but the architecture stays MCP-compatible.
- The app only reviews diffs and stores comments.

## 3. Deliberate changes from the kickoff brief

These were decided during brainstorming and intentionally override the kickoff:

1. **Command name is `delta`, not `review`.**
2. **Reviews have no name.** There is no honest human-readable source for one, and we won't ask the user to type one. A review is identified by its target.
3. **No explicit save / no dirty state.** Comments autosave individually (Notes.app model). The kickoff's "reviews are explicit documents the user manually saves, with a dirty state" is dropped. ("Copy for Claude" export remains an explicit, separate action.)
4. **New default diff mode "All changes"** (`merge-base(base) → working tree`), added because the three original modes each show only a slice of work that is split across commits + the working tree.
5. **Multiple reviews open in parallel** as separate document windows.

## 4. Architecture overview

```
┌───────────────────────────── Tauri 2 (one process) ─────────────────────────────┐
│                                                                                  │
│  Rust backend                                  React + TypeScript frontend       │
│  ─────────────                                 ──────────────────────────        │
│  • Git engine (git2 / libgit2)                 • Launch picker (window)           │
│      - diff computation (DiffSpec→Diff)        • Review workspace (window/target) │
│      - base detection, merge-base                  - DiffView (wraps git-diff-view)│
│  • Storage (trait)                                 - Files panel (list/tree)       │
│      - JSON review docs                            - Comment index (summoned)      │
│      - repo/worktree/recency registry          • Per-comment autosave calls        │
│  • Anchoring/re-anchor service                 • Export ("Copy for Claude")        │
│  • Markdown serializer (export, shared w/ MCP) │                                   │
│  • CLI entry routing (single-instance)         │                                   │
│                                                                                  │
│  Window model: one backend process, N document windows (≤1 window per target).   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Key module boundaries (each independently testable):**

- **`DiffView` interface (frontend):** the only thing that knows about `@git-diff-view/react`. Renders a `Diff` + the comment widgets, emits add/edit/delete + line-anchor events. Swapping the rendering library means reimplementing this adapter only.
- **Storage trait (Rust):** persistence behind an interface (JSON docs today; SQLite remains a drop-in later).
- **Git engine (Rust):** turns a `DiffSpec` into a structured `Diff`. Knows nothing about reviews or comments.
- **Anchoring service:** maps comments ↔ diff positions; owns re-anchoring and staleness. Library-agnostic.
- **Markdown serializer:** turns a review into the export document. Reused by a future MCP server.

## 5. Tech stack & rationale

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Fast startup, small footprint, native feel; not Electron. |
| Frontend | **React + TypeScript** | With the diff virtualized, framework reconciliation isn't the bottleneck; React's ecosystem (virtualizer, markdown editor, Tauri examples) speeds the MVP. Solid's perf edge is neutralized by virtualization. |
| Diff renderer | **`@git-diff-view/react`** behind a `DiffView` interface | Purpose-built for diff + inline comment widgets; Shiki + Web Worker highlighting (beautiful + fast by default), virtual scrolling, split/unified, intra-line (word) diff. Chosen over react-diff-view for out-of-box polish; chosen over CodeMirror 6 (an editor bent into a viewer) and Monaco (too heavy). |
| Diff engine | **git2 (libgit2)** in Rust | Rust owns the changed-file set, status, rename detection (`DiffFindOptions`), `merge_base`, and per-file old/new **content** (`diff_tree_to_workdir_with_index` for worktree-right modes). The intra-file **line diff is computed by git-diff-view from that content** — Rust does not emit hunk strings. No porcelain parsing, no subprocess latency. |
| Storage | **JSON document per review** behind a Rust storage trait | A review *is* a document; file-per-review matches it exactly. Tiny scale (single user, hundreds of reviews). No migration ceremony while the schema churns. SQLite deferred (trait keeps the door open). |
| Syntax highlighting | **Shiki**, client-side, in git-diff-view | Rust only produces diff structure. |

**Renderer risk & mitigation:** `@git-diff-view/react` is pre-1.0 (v0.1.x). Mitigations: pin the exact version and upgrade deliberately; keep our anchor model independent of the library's internal addressing; isolate the library behind `DiffView` so a forced migration to react-diff-view is ~a day of adapter work.

## 6. Data model

A **Review** is keyed by its **Target** = `(repo, worktree, mode)`. Exactly one review document exists per target; reopening a target resumes it. No name.

```jsonc
// Review document (one JSON file per review)
{
  "version": 1,
  "id": "<stable hash of target>",
  "target": {
    "repoPath": "/Users/me/projects/delta",
    "worktree": "feat/auth",            // branch / worktree identifier
    "mode": "all-changes",              // preset id; see §7
    "base": "main"                       // resolved base branch (for base-relative modes)
  },
  "snapshot": {                          // the frozen diff this review was anchored against
    "baseOid": "a1b2c3d…",
    "headOid": "e4f5g6h…",               // null when right side is the working tree
    "capturedAt": "2026-06-25T18:54:00Z"
  },
  "comments": [ /* Comment[] */ ],
  "viewed": [                            // per-file "viewed" progress — reviewer state, NOT exported
    { "file": "src/auth/session.ts", "diffHash": "…" }  // diffHash clears viewed when the file's diff changes
  ],
  "createdAt": "…",
  "lastOpenedAt": "…"                    // drives picker recency
}
```

```jsonc
// Comment
{
  "id": "uuid",
  "scope": "line" | "range" | "file" | "general",
  "anchor": {                            // absent for "general"
    "file": "src/auth/session.ts",
    "side": "new" | "old",               // old = a removed line
    "startLine": 22,                      // new-side numbers where possible
    "endLine": 25,                        // == startLine for single line; absent for "file"
    "snippet": "return cache.get(user.id)" // captured code at creation (for re-anchor + export)
  },
  "body": "<markdown>",                  // the ONLY content. No priority/label/type/AI metadata.
  "stale": false,                        // set when re-anchor fails on refresh/reopen
  "createdAt": "…",
  "updatedAt": "…"
}
```

```jsonc
// Registry (single JSON file): imported repos, their worktrees, and recency for the picker
{
  "version": 1,
  "repos": [
    { "path": "/Users/me/projects/delta", "name": "delta",
      "worktrees": ["feat/auth", "main"], "defaultBranch": "main" }
  ],
  "reviews": [
    { "id": "…", "target": { … }, "lastOpenedAt": "…",
      "commentCount": 3, "staleCount": 2,
      "viewedCount": 3, "fileCount": 7 }   // denormalized for fast picker render
  ]
}
```

**Consequence of mode-in-key:** the workspace mode selector switches *between* that worktree's reviews (up to one per mode), because comments belong to a specific mode's diff. In practice, with **All changes** as default, most worktrees have a single review.

## 7. Diff comparison model

Comparisons are a generalized spec; the modes are named presets. `to` may be a commit **or** the live working tree.

```
DiffSpec { from: Ref | MergeBase(base), to: Ref | WorkingTree }
```

| Mode (preset) | from | to | Notes |
|---|---|---|---|
| **All changes** *(default)* | `merge-base(base, HEAD)` | working tree (incl. index) | The hero mode: everything since you branched, regardless of commit boundaries. Robust to mid-task commits. |
| Uncommitted | `HEAD` | working tree | Just what isn't committed. |
| Last commit | `HEAD~1` | `HEAD` | The most recent commit. |
| Branch vs base | `merge-base(base, HEAD)` | `HEAD` | Committed branch work only. |

- **Base detection:** auto-detect the repo default branch (`origin/HEAD` → `main`/`master`); overridable per review.
- **Empty default:** if **All changes** is empty (no divergence + clean tree), show a **"Nothing to review" empty state**. No automatic fallback to another mode.
- **Extensible:** new comparisons are new presets over `DiffSpec` — this is the kickoff's "custom comparisons later," for free.
- git2 mechanics: `merge_base` for the base; `diff_tree_to_workdir_with_index` for worktree-right modes; `diff_tree_to_tree` for commit-to-commit; `DiffFindOptions` for rename detection.
- **Line-diffing is delegated to git-diff-view** (computed from each file's old/new content via `generateDiffFile`). Rust is authoritative for *which* files changed, their status, renames, and content; git-diff-view owns the intra-file line diff that is displayed and (in Plan 2) anchored against — keeping anchors consistent with what's rendered.

## 8. Anchoring & staleness

- A review operates on a **frozen diff snapshot**, not a live diff. Opening/creating a review captures the diff; editing files in your editor does not shuffle comments under you.
- **Each comment stores coordinates + a captured code snippet** (see §6). The snippet powers both re-anchoring and a richer export.
- **Refresh** (explicit) and **reopen** recompute the diff (incl. re-resolving `merge-base` and the working tree) and **re-anchor best-effort**:
  1. exact position match;
  2. else fuzzy-match the stored snippet within a small line window.
  - Re-anchored → comment moves to the new position.
  - No match → comment flagged **stale**, still fully visible (with its snippet). **Comments are never silently dropped.**
- **Staleness is per-comment** (source of truth). The picker shows a derived `⚠ N stale` roll-up; the workspace offers a filter/jump to stale comments.
- **Viewed state resets the same way:** a file marked "viewed" stores the hash of its diff at view time; on Refresh, if that file's diff changed, its viewed flag is cleared so you re-review what moved (mirrors GitHub's "Viewed" behavior).

## 9. Persistence

- **One JSON file per review** in the app data dir (e.g. `~/Library/Application Support/delta/reviews/<id>.json`), plus a single `registry.json`.
- **Per-comment autosave:** add/edit/delete writes the review document (debounced, atomic write — temp file + rename). No manual save, no dirty state.
- **Viewed state autosaves** the same way — toggling a file's "viewed" checkbox writes the review doc.
- Behind the **storage trait**; SQLite remains a future drop-in.
- Nothing is ever written into the user's repo / working tree.

## 10. UI / UX

### 10.1 Launch picker (Spotlight / ⌘O style)
- The screen on launch (and summonable anytime with ⌘O). Recency-ordered list; fuzzy filter as you type.
- Row = target (`branch` + `mode` chip + `repo`) · `💬 N` · derived `⚠ N stale` · last-opened time. **No name, no save state.**
- **＋ New review…** drills `repo → worktree → diff-mode` inline (keyboard-driven).
- Keys: `↑↓` navigate · `↵` open · `⌘N` new review · `⌘⌫` delete review.

### 10.2 Review workspace (layout "B" — diff-first)
- **Top bar:** `repo` · `worktree ▾` · **mode selector** (All changes / Uncommitted / Last commit / Branch vs base) · **Refresh** · **Copy for Claude**. (No Save.)
- **Files panel (left):** changed files with status (Added/Modified/Deleted/Renamed) + per-file stats. **Toggles between flat List and Tree** (segmented control in its header); list shows full paths, tree collapses directories.
  - **Per-file "viewed" checkbox** (GitHub-style): checking it **collapses that file's diff** and de-emphasizes the row; unchecking re-expands. State persists per review (§9) and resets when the file's diff changes (§8).
  - The files-panel header shows a **global progress count `N/M viewed`** next to the List/Tree toggle.
- **Diff (fills the rest):** git-diff-view, unified or split, syntax-highlighted, intra-line diff, collapsed unchanged sections, virtualized for large diffs, smooth scroll.
- **Comments:** inline threads under their lines (git-diff-view widget API: `diffViewAddWidget` / `onAddWidgetClick` / `renderWidgetLine`; saved comments via `extendData` / `renderExtendLine`). A **comment index** slides over on **⌘2** (summoned, not a persistent pane); selecting an entry jumps to the comment.
- **Empty state** when the mode's diff is empty.

### 10.3 Comment scopes & creation
Four scopes, **markdown body only**:
- **Line** — gutter "+" on a line.
- **Range** — select lines, then comment.
- **File** — action on the file header.
- **General** — "General note" action in the comment index.

### 10.4 Keyboard navigation (initial map)
`⌘O` picker · `⌘2` comment index · `j/k` next/prev hunk · `n/p` next/prev comment · `c` comment on current line/selection · `v` toggle "viewed" on current file · `r` refresh · `⌘⏎` Copy for Claude · `[`/`]` prev/next file. (Refined during implementation.)

## 11. Export — "Copy for Claude"

Explicit, on-demand. Serializes the review to markdown (clipboard now; file optional). The **same serializer** is what a future MCP server will use. (Viewed state is reviewer progress and is **not** included in the export.)

Format:
- Grouped by file, `General` section first.
- Each comment = location header + the anchored snippet (fenced, with language) + body.
- New-side line numbers; comments on removed lines marked old-side.
- Header carries the full target + base/head SHAs + timestamp (self-describing).
- **Stale comments are included, marked `⚠ stale`** — never silently dropped.

Example:

````markdown
# Review — delta · feat/auth · Branch vs main
Base main@a1b2c3d ⇢ head feat/auth@e4f5g6h · exported 2026-06-25 18:54

## General
- Standardize error handling on a Result type — it's inconsistent across `auth/`.

## src/auth/session.ts

#### L22–25
```ts
return cache.get(user.id)   // stale after refresh
```
Use `store.read(user.id)` — the cache can be stale after a token refresh.

#### L40
```ts
export const TTL = 3600
```
Make this configurable via env.

## src/auth/login.ts

#### File-level
This module needs test coverage before we ship.

#### L8 · ⚠ stale
```ts
if (!token) return null
```
Guard looks redundant with the check above — original location may have moved.
````

## 12. CLI (`delta`)

- `delta` / `delta .` / `delta <path>` — a **thin launcher**. Resolves the target from `cwd` (walk up for `.git`, read current worktree/branch) or an explicit path.
- **One backend process, many document windows.** `delta <target>` opens a new window for that target, or **focuses the existing window** if that target is already open (≤1 window per target → no concurrent edits on one doc).
- **Fast path:** `delta` inside a repo opens straight into that target's review at the **default mode (All changes)**, skipping the picker. Bare `delta` with no repo, or launching the app icon → the **picker**.
- Optional flags: `--uncommitted` / `--last-commit` / `--branch` to land in a specific mode.
- The CLI→app routing (Tauri single-instance) is the **same seam a future MCP server plugs into**.

## 13. Performance

- Startup <1s: Tauri shell, lazy-load heavy frontend modules, warm process reused across windows.
- Large diffs: git-diff-view virtual scrolling + Web Worker highlighting; git2 computes diffs in-process.
- The diff engine streams structured hunks to the frontend; only visible rows render.

## 14. Out of scope (reaffirmed)

GitHub, pull requests, AI chat in-app, MCP (now), code editing, merge-conflict resolution, git staging, commit-history browsing, multi-user collaboration, authentication, cloud sync.

## 15. Future compatibility

- **MCP:** the markdown serializer + the CLI→app single-instance seam are the integration points; a future MCP server reads the JSON store and/or reuses the serializer. No app changes required to the data model.
- **Custom comparisons:** new `DiffSpec` presets.
- **SQLite:** drop-in behind the storage trait if scale ever demands cross-review search.

## 16. Open questions / risks (non-blocking)

- **git-diff-view pre-1.0 churn** — mitigated by version pinning + the `DiffView` boundary (see §5).
- **Snippet re-anchor heuristics** — the fuzzy-match window size and tie-breaking will need tuning against real edits.
- **Base detection edge cases** — detached HEAD, repos with no `origin`, branches forked from non-default branches; default to repo default branch and allow per-review override.
- **Deleted-line comments** across refresh — when a removed line's context changes, prefer marking stale over guessing.
```
