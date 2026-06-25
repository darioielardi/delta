# delta — Plan 2: The Comment Layer — Design Spec

**Date:** 2026-06-25
**Status:** Approved for planning
**Builds on:** `docs/superpowers/specs/2026-06-25-delta-design.md` (product spec) and `docs/superpowers/plans/2026-06-25-delta-foundations.md` (Plan 1, on `main`).

This document is the detailed, decisions-locked design for **Plan 2**. The product spec defines *what* the comment layer is (§6 data model, §8 anchoring, §9 persistence, §10 UI, §11 export); this design locks *how* Plan 2 builds it on top of the Plan 1 code, and records the decisions resolved during brainstorming.

---

## 1. Summary

Plan 1 delivered a read-only diff viewer: a Rust git engine (`compute_diff`, `get_file_diff` over a `Target {repoPath, mode, base}`), a typed IPC client, an isolated `DiffView`, a `FilesPanel`, and a `Workspace` that opens a repo by path and renders one file's diff at a time.

Plan 2 adds the **comment layer**: a per-target **Review** document that persists comments and viewed-state to local JSON, anchored against a **frozen diff snapshot** with best-effort re-anchoring and per-comment staleness computed in Rust. The diff pane is rebuilt into an **all-files scroll** so comments, viewed-collapse, and jump-to-comment are first-class. A minimal **Copy for Claude** markdown export closes the loop so Plan 2 is dogfoodable on its own.

## 2. Scope

**In scope:**
- Review documents (load-or-create per target), persisted as one JSON file per review.
- Comments in four scopes — **line**, **range**, **file**, **general** — markdown body only.
- Per-comment autosave (add/edit/delete) + per-file viewed-state autosave, atomic writes.
- Frozen-snapshot anchoring: best-effort re-anchor (exact → fuzzy) + per-comment staleness, in Rust.
- Inline comment widgets in the diff + a summoned **comment index** (⌘2).
- Per-file **viewed** checkbox with collapse + `N/M viewed` count, reset when a file's diff changes.
- All-files scroll diff pane (replaces Plan 1's single-file view).
- Minimal **Copy for Claude** markdown export (clipboard).

**Out of scope (deferred to Plan 3):**
- `registry.json` and the launch picker, the `delta` CLI, multi-window.
- MCP, AI chat, code editing — out of the product entirely (product spec §14).

## 3. Decisions resolved during brainstorming

1. **Export is in Plan 2.** A minimal markdown serializer + "Copy for Claude" clipboard action ships now; without it Plan 2 produces comments with no in-app way to reach Claude. Same serializer a future MCP server reuses.
2. **Anchoring lives in Rust** (`similar` crate). Rust computes the diff and holds all file content in-process, so one reconcile pass re-anchors every comment and returns updated anchors + staleness — the comment index gets accurate staleness with no content loaded in JS. Matches product-spec §4.
3. **Diff pane becomes an all-files scroll** (not Plan 1's single-file selection). Makes "viewed collapses the file" (§10.2) and "jump to comment" natural. Implemented as a `DiffPane` composing per-file `DiffView`s.
4. **`registry.json` deferred to Plan 3.** Review IDs are a deterministic hash of the target, so load-or-create needs no index; the registry's only consumer is the picker.
5. **Per-session content cache provides the freeze.** Anchors/viewed reconcile only on open/refresh; the frontend caches `FileDiff` per session (cleared on Refresh) so looked-at files stay stable. Accepts a tiny drift window between reconcile and a file's first on-screen mount (see §13).
6. **Frontend owns mutations + whole-doc atomic save.** Trivial mutations (add/edit/delete comment, toggle viewed) happen in TS, persisted via `save_review`. Rust stays stateless except the heavy reconcile/anchor/export.

## 4. Architecture additions

**Rust (`src-tauri/src/`):**
- `review/model.rs` — `Review`, `Comment`, `Anchor`, `Snapshot`, `ViewedEntry`, scopes; enriched `Target` (adds `worktree`); review-id hashing.
- `storage/mod.rs` — `Storage` trait + `JsonStorage` impl (atomic temp-file + rename); app-data-dir path resolution.
- `anchor/mod.rs` — re-anchoring (exact + fuzzy via `similar`), per-comment staleness, `diffHash`.
- `review/reconcile.rs` — the reconcile core: recompute diff → re-anchor → reset viewed → refresh snapshot.
- `export/mod.rs` — `Review` → markdown serializer (product-spec §11 format).
- `commands.rs` — add `open_review`, `refresh_review`, `save_review`, `export_review` (alongside Plan 1's `compute_diff`, `get_file_diff`).

**Frontend (`src/`):**
- `types.ts` — add `Review`, `Comment`, `Anchor`, `Snapshot`, `ViewedEntry`, `CommentScope`, `ReviewSession`; enriched `Target`.
- `api.ts` — `openReview`, `refreshReview`, `saveReview`, `exportReview`.
- `review/useReview.ts` — session state holding the `Review`, with mutators (add/edit/delete comment, toggle viewed) + debounced autosave.
- `review/CommentThread.tsx`, `review/CommentEditor.tsx` — textarea editor + `react-markdown` rendering of saved bodies.
- `review/CommentIndex.tsx` — summoned overlay (⌘2), General-note creation, jump-to-comment.
- `diff/DiffPane.tsx` — all-files scroll container (section headers, lazy body mount, collapse, scroll-to). Composes `DiffView` per file; **does not** import git-diff-view.
- `diff/DiffView.tsx` — extended with comment widgets (add affordance + saved-comment rendering). Remains the **only** importer of `@git-diff-view/*`.
- `files/FilesPanel.tsx` — viewed checkbox + `N/M` count; becomes a navigator (click → scroll to section).
- `workspace/Workspace.tsx` — bootstrap via `open_review`; Refresh, Copy for Claude, keyboard shortcuts.

**Renderer boundary (unchanged invariant):** only `src/diff/DiffView.tsx` imports `@git-diff-view/*`. `DiffPane` orchestrates layout/lazy-mount/collapse but renders through `DiffView`.

## 5. Data model

Rust owns the canonical model (mirrors product-spec §6); TS mirrors it as camelCase interfaces. All Rust↔TS payloads are `#[serde(rename_all = "camelCase")]`; scope/side enums serialize lowercase.

```rust
// review/model.rs (shapes; serde camelCase)
struct Target { repo_path: String, worktree: String, mode: DiffMode, base: Option<String> }

struct Review {
    version: u32,                 // = 1
    id: String,                   // stable hash of (repo_path, worktree, mode)
    target: Target,               // enriched (worktree + resolved base)
    snapshot: Snapshot,
    comments: Vec<Comment>,
    viewed: Vec<ViewedEntry>,
    created_at: String,           // RFC3339
    last_opened_at: String,
}

struct Snapshot { base_oid: String, head_oid: Option<String>, captured_at: String }
// head_oid is None in worktree-right modes (all-changes, uncommitted).

enum CommentScope { Line, Range, File, General }   // lowercase
enum Side { New, Old }

struct Anchor {
    file: String,
    side: Side,
    start_line: u32,              // 1-based file line numbers
    end_line: Option<u32>,        // == start for line; None for file-scope
    snippet: String,              // captured code at creation
}

struct Comment {
    id: String,                   // uuid
    scope: CommentScope,
    anchor: Option<Anchor>,       // None for general
    body: String,                 // markdown — the only content
    stale: bool,
    created_at: String,
    updated_at: String,
}

struct ViewedEntry { file: String, diff_hash: String }
```

**`Target.worktree`.** Plan 1's `Target` is `{repoPath, mode, base}`; the spec keys reviews on `(repo, worktree, mode)`. `open_review` accepts the Plan-1 target and **resolves `worktree` internally** — HEAD shorthand (branch name), or a short OID for detached HEAD — and returns the enriched `Target` inside the `Review`. The frontend call site barely changes.

**Review `id`.** A stable hash (SHA-256 via the `sha2` crate, hex, truncated to 16 chars) of `repo_path \0 worktree \0 mode`. Deterministic → load-or-create needs no registry; the file is `reviews/<id>.json`.

## 6. Persistence & autosave

- **One JSON file per review** at the app data dir (`~/Library/Application Support/delta/reviews/<id>.json`).
- **`Storage` trait** with a `JsonStorage` impl: `load(id) -> Option<Review>`, `save(&Review)`. Save is **atomic** (write temp file, `fsync`, rename over the target). SQLite stays a future drop-in behind the trait.
- **Frontend is the session source of truth.** Mutations update the in-memory `Review`, then persist via `save_review(review)`:
  - **Body typing is debounced** (~400 ms) before save.
  - **Add / delete comment, toggle viewed save immediately.**
- Rust storage is otherwise stateless: each command opens/reads/writes as needed.
- Nothing is ever written into the user's repo / working tree.

## 7. Anchoring & the freeze model (core)

### 7.1 Coordinate system
Anchors use **1-based file line numbers** on the `new` side (or `old` side for removed-line comments) plus a captured `snippet`. git-diff-view numbers rendered rows by the same file line numbers, so an anchor at new-line 22 maps exactly to the rendered row. This keeps anchors consistent across the Rust↔TS boundary **without sharing the renderer's internal addressing** — the invariant that makes Rust-side anchoring sound.

### 7.2 Reconcile (the heavy Rust pass)
A single core, `reconcile(repo_state, review) -> ReviewSession`, used by both `open_review` and `refresh_review`:

1. Compute the diff for the target (re-resolve merge-base + working tree; build `DiffSummary`).
2. **Re-anchor every comment** (skip `general`):
   - Pick content by side: `new` → file's new content, `old` → file's old content. If the file is absent from the diff → `stale = true` (keep last-known anchor + snippet).
   - **Exact:** lines `[start_line, end_line]` of content equal the stored snippet (line-wise) → keep position, `stale = false`.
   - **Fuzzy:** scan the window `[start_line - W, start_line + W]` for the best `snippet`-length block by `similar` similarity ratio; if best ≥ `THRESHOLD` → move `start_line`/`end_line` to the match, `stale = false`; else `stale = true`.
   - **File-scope:** file present in diff → not stale; absent → stale.
3. **Reset viewed:** recompute each file's `diff_hash = hash(old_content \0 new_content)`; drop `ViewedEntry`s whose file's hash changed or whose file vanished.
4. **Refresh snapshot:** `base_oid` = from-tree OID; `head_oid` = right-side commit OID or `None` (working tree); `captured_at`/`last_opened_at` updated. Persist, return `{ review, summary }`.

Defaults: `W = 50` lines, `THRESHOLD = 0.6`. Both are tunable constants; tuning against real edits is a known follow-up (§13).

**Comments are never dropped** — a no-match comment becomes `stale` and stays fully visible with its snippet.

### 7.3 Freeze model
Anchors don't move and viewed doesn't reset **between** reconciles — editing files in your editor never shuffles comments. The frontend **caches `FileDiff` content per session, cleared on Refresh**, so a file you've already looked at stays stable until you explicitly refresh. Refresh re-runs reconcile against live repo state. (Before calling refresh, the frontend flushes any pending debounced body-save by passing the in-memory `Review` to `refresh_review`, so there is no reload-stale race.)

## 8. Diff pane — all-files scroll

`DiffPane` renders a vertical scroll of **file sections**, one per changed file:
- **Section header:** path, status badge, `+adds −dels`, viewed checkbox, collapse chevron.
- **Section body:** the file's `DiffView` (git-diff-view) with its comment widgets.
- **Lazy mount:** all headers render immediately (cheap); a section's body mounts when it nears the viewport (IntersectionObserver) and triggers a cached `get_file_diff`. Offscreen and **viewed/collapsed** sections stay header-only.
- **Viewed = collapse:** checking viewed collapses the body to the header and de-emphasizes the row; unchecking re-expands.
- **Scroll-to:** FilesPanel clicks and comment-index jumps scroll the target section into view (expanding it if collapsed) via section refs.
- **Performance:** git-diff-view virtualizes *within* a file; lazy body-mount bounds *across* files. True cross-file windowing (for very large file counts) is a deferred optimization, consistent with product-spec §13.

FilesPanel keeps its list/tree toggle and stats; selection now means "scroll to this section" and highlights the active section, rather than swapping the pane.

## 9. Comment UI

- **Widgets (inside `src/diff/`):** the add affordance — gutter `+` on a line, or select lines then comment — calls git-diff-view's `onAddWidgetClick`; saved comments render via `extendData` / `renderExtendLine`. `DiffView` gains `comments` + `onAddComment(anchor)` / `onEditComment` / `onDeleteComment` props.
- **Editor:** plain `<textarea>` for the markdown body; **`react-markdown`** renders saved bodies. No heavyweight editor (dep already named in Plan 1's constraints).
- **Comment index (⌘2):** a summoned overlay (shadcn `Dialog`) listing all comments straight from the `Review` (no file content loaded) — **General first**, then grouped by file and line. Each entry shows location + body preview + a `⚠ stale` marker. Click → scroll to the comment. Hosts the **"General note"** creation action (the only entry point for general-scope comments).

## 10. Viewed

Per-file checkbox (replacing Plan 1's `viewed = 0` placeholder) in both the FilesPanel row and the section header; checking collapses the section + de-emphasizes the row; a global `N/M viewed` count sits in the FilesPanel header. Toggling autosaves a `ViewedEntry { file, diffHash }`. Reset is handled by reconcile's `diffHash` check (§7.2). Viewed is reviewer progress and is **not** exported.

## 11. Export — Copy for Claude

`export_review(review) -> String` produces product-spec §11 markdown:
- Self-describing header: target + base/head SHAs + export timestamp.
- **General section first**, then grouped by file.
- Each comment: location header (new-side line numbers; removed-line comments marked old-side) + the anchored snippet fenced with its language + the markdown body.
- **Stale comments included, marked `⚠ stale`** — never dropped.

A toolbar **Copy for Claude** button and `⌘⏎` serialize and write to the clipboard. The serializer is pure (`Review -> String`), unit-testable with golden fixtures, and is the same one a future MCP server reuses.

## 12. Workspace bootstrap + keyboard

Keep Plan 1's "type repo path → Open," but **Open now calls `open_review`** → `ReviewSession`, which drives both the file list (`summary`) and comments/viewed (`review`). Toolbar adds **Refresh** (re-runs reconcile via `refresh_review`) and **Copy for Claude**. Initial keyboard subset (full map refined during implementation per product-spec §10.4): `c` comment on current line/selection · `v` toggle viewed on current file · `⌘2` comment index · `r` refresh · `n`/`p` next/prev comment.

## 13. Command surface (IPC)

| Command | Signature | Notes |
|---|---|---|
| `open_review` | `(target: Target) -> ReviewSession` | Load-or-create by id, reconcile, persist, return `{review, summary}`. |
| `refresh_review` | `(review: Review) -> ReviewSession` | Reconcile the in-memory review (race-free), persist, return. |
| `save_review` | `(review: Review) -> ()` | Atomic whole-doc write. |
| `export_review` | `(review: Review) -> String` | Markdown for clipboard. |
| `compute_diff` | *(Plan 1)* | Underlying engine fn; `open_review` reuses its internals. |
| `get_file_diff` | *(Plan 1)* | Per-file lazy content; reused by `DiffPane` section bodies. |

`ReviewSession = { review: Review, summary: DiffSummary }`.

## 14. Testing strategy

- **Rust (TDD, headless):** anchoring (exact / fuzzy-move / stale / file-scope), `diffHash` viewed-reset, snapshot OID mapping per mode, storage round-trip + atomic-write (tempfile), reconcile end-to-end, serializer golden tests, review-id stability.
- **Frontend (vitest + happy-dom):** `useReview` mutations + debounced-save behavior, comment-index rendering/grouping/stale marker, api client arg mapping, `buildTree`/navigator logic.
- **Live-tested by the user in `pnpm tauri dev`** (the Rust toolchain here is headless): DiffPane scroll/lazy-mount/collapse, comment widget add/edit/delete, gutter affordance, jump-to-comment, clipboard export. (Mirrors Plan 1, where arborist rows and the rendered diff were verified live, not in happy-dom.)

## 15. Rough task shape (~13 tasks; writing-plans will detail)

Rust: (1) review/comment/anchor/snapshot model + `Target.worktree` + id hashing → (2) storage trait + JSON atomic impl → (3) anchoring service (`similar`: exact/fuzzy/stale + diffHash) → (4) reconcile core → (5) markdown serializer → (6) commands wired into `lib.rs`.
TS: (7) types + api client → (8) `useReview` state hook (mutations + debounced autosave) → (9) comment editor/thread (`react-markdown`) → (10) `DiffView` widget integration (boundary-preserving) → (11) `DiffPane` all-files scroll (lazy mount, collapse, scroll-to) + FilesPanel viewed/navigator → (12) comment index overlay (⌘2) + General note + jump → (13) Workspace wiring (open_review bootstrap, Refresh, Copy for Claude, keyboard).

## 16. Risks / open questions (non-blocking)

- **Fuzzy-match tuning.** `W` and `THRESHOLD` need tuning against real edits; defaults are starting points.
- **Reconcile-to-first-mount drift.** With live per-session content reads, a commented file edited between reconcile and its first on-screen mount could render a line off. Acceptable for Plan 2; tighten later by serving section content from the reconcile-time capture (Rust session state or content returned by `open_review`).
- **Cross-file virtualization.** Lazy body-mount bounds render cost; pathological file counts may want true windowing later.
- **git-diff-view pre-1.0 widget API.** `onAddWidgetClick` / `renderWidgetLine` / `extendData` churn is absorbed by the `src/diff/` boundary; a forced migration stays adapter-local.
- **Deleted-line (old-side) comments** across refresh: prefer marking stale over guessing (product-spec §16).
