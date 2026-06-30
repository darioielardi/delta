# Commit-by-commit review — design spec

- **Status:** approved (design), ready for planning
- **Date:** 2026-06-30
- **Area:** diff scope selection, diff rendering, comments

## Summary

Add the ability to review a branch **one commit at a time**. Today a review's scope is a
single `DiffMode` toggle (All changes / Uncommitted / Last commit / Branch vs base) that
re-frames the same underlying diff. This adds a fifth scope — **Commit** — that pins the
diff pane to a single commit's isolated change and lets the reviewer step prev/next through
the commits on the branch, leaving comments as they read.

The feature is a **navigation lens, not a per-commit review model**: there is still one
review per `(repo, worktree)` and one flat comment list. A commit is something you look
*through*, not a separate reviewable unit with its own thread.

## Motivation

A large branch-vs-base diff is hard to review as one blob. Stepping commit-by-commit lets
the reviewer follow the branch in the order it was built, understand intent per change, and
attach feedback to the specific commit that introduced an issue. Because delta's output is
comments handed to an AI agent ("Copy for agents"), recording *which commit* a comment is
about is useful provenance.

## Non-goals

- **Per-commit comment threads / patchset review (Gerrit-style).** Comments remain one flat
  list on the single review; commit is metadata + a view filter, not a separate lifecycle.
- **Cumulative ("scrub history") diffs.** v1 shows only the isolated `parent → commit` diff.
  Cumulative (`base → commit`) is explicitly out of scope.
- **Editing/squashing/reordering commits.** Read-only review only.
- **Multi-parent (merge) commit diff selection.** v1 diffs merge commits against their first
  parent; choosing a parent is out of scope.

## UX design

### Decisions (locked)

1. **Lens, not units** — step through commits to read; one review, one comment list.
2. **Isolated diff** — `parent → commit`, reusing the Last-commit code path generalized to
   any commit oid. The file tree shows only the files that commit touched.
3. **Comments tagged with their commit** — a line/range comment created while viewing commit
   `C` records `commit = C`; it is shown on `C` and annotated with `C` in the export.
4. **Codex-style control** — commit selection lives in a nested submenu off the existing mode
   dropdown; a small prev/next stepper appears only while in commit mode.

### The control

The toolbar's native `<select>` "Diff mode" control ([Workspace.tsx](../../src/workspace/Workspace.tsx))
is replaced by a **shadcn dropdown-menu** (new `components/ui/dropdown-menu.tsx`, wrapping
the already-installed unified `radix-ui` package, matching the import style of the other
primitives). Menu contents:

```
All changes
Uncommitted
Last commit
Branch vs base
────────────
Commit ▸           → submenu: the branch's commits, newest first
```

- **"Last commit" stays** as a distinct one-click item. It is a *moving pointer* (always
  HEAD's commit, follows new commits via auto-refresh). **"Commit ▸" is a new item** that
  *pins* a specific commit (`a1b2c3d` stays `a1b2c3d` after further commits). They are not
  redundant: dynamic tip vs. pinned selection.
- The **submenu** lists commits on `merge-base(base, HEAD)..HEAD`, newest first (HEAD on
  top), each row: short oid (mono) · subject (truncated) · relative age. Selecting a row
  enters Commit mode pinned to that oid.
- If the branch has no commits in range (e.g. checked out on base), the "Commit ▸" item is
  disabled with a hint.

### The stepper

Shown **only when in Commit mode**, immediately right of the dropdown trigger:

- A small two-button group `‹ ›` that moves prev/next through the commit list, plus an
  `N / M` position counter (tabular mono).
- Keyboard shortcuts `[` (prev) and `]` (next), active only in Commit mode.
- Buttons disable at the ends of the list.
- The dropdown **trigger label** in Commit mode reads `Commit <shortOid>` so the reviewer
  always knows where they are; the full subject lives in the submenu.

Arrows move in list order (top = HEAD). Exact prev/next direction is a one-line
implementation choice; default: `‹` toward the top of the list (HEAD), `›` toward the bottom
(base).

### Comments behavior

- A **line/range** comment created in Commit mode is stamped with the viewed `commit` oid.
- **General notes stay global** (untagged, `commit = None`) and are always shown — they
  aren't about a specific commit.
- In Commit mode, the diff pane's inline markers and the comments pane show **only the
  current commit's tagged comments** (plus general notes). Untagged line/range comments
  authored in the non-commit modes are not shown in Commit mode (and vice-versa): each
  mode-context shows its own comments. The comments **index**, when opened, lists everything
  grouped by commit (and an "ungrouped / branch" bucket).
- The comments **count** on the toolbar button reflects the current context (current commit's
  tagged comments + general notes) when in Commit mode.

## Data model changes

### `Target` ([git/model.rs](../../src-tauri/src/git/model.rs))

```rust
pub enum DiffMode { AllChanges, Uncommitted, LastCommit, BranchVsBase, Commit } // + Commit

pub struct Target {
    pub repo_path: String,
    pub worktree: Option<String>,
    pub mode: DiffMode,
    pub base: Option<String>,
    pub commit: Option<String>,   // NEW: pinned commit oid, set iff mode == Commit
}
```

`DiffMode::Commit` serializes kebab-case as `"commit"`.

### `Comment` ([review/model.rs](../../src-tauri/src/review/model.rs))

```rust
pub struct Comment {
    // … existing …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,   // NEW: full oid of the commit this comment was authored on
}
```

Optional + `default`, so existing persisted reviews deserialize unchanged.

### New `CommitMeta` (returned by `list_commits`)

```rust
pub struct CommitMeta {
    pub oid: String,         // full
    pub short_oid: String,   // 7 chars
    pub subject: String,     // first line of the message
    pub author: String,      // author name
    pub time: i64,           // author time, unix seconds (FE formats relative)
}
```

## Backend changes (Rust)

### Commit listing — `git/log.rs` (new) + command

- `list_commits(repo, target) -> Vec<CommitMeta>`:
  - Resolve base via existing `resolve_base(repo, target.base)`.
  - `mb = merge_base(head, base_oid)`.
  - Revwalk: push HEAD, hide `mb`, `Sort::TIME` (newest first). Map each commit to
    `CommitMeta` (subject = first line of summary, author name, author time).
- New `#[tauri::command] list_commits(target: Target) -> Result<Vec<CommitMeta>, String>` in
  [commands.rs](../../src-tauri/src/commands.rs), with a thin `_impl` like the others.

### Isolated commit diff — `resolve_endpoints` ([git/mod.rs](../../src-tauri/src/git/mod.rs))

Add a `DiffMode::Commit` arm:

- Resolve the commit from `target.commit` (error if absent/unknown).
- `from_tree = parent(0).tree()` if a parent exists, else the **empty tree** (root commit →
  all-additions).
- `right = RightSide::Tree(commit.tree())`.
- Labels: `base_label = short_oid(parent)`, `head_label = short_oid(commit)`.

This mirrors the existing `LastCommit` arm; consider factoring the shared "isolated diff of a
commit" into a helper used by both.

### Reconciliation — `reconcile` ([review/reconcile.rs](../../src-tauri/src/review/reconcile.rs))

Key simplification: **a commit is immutable, so a commit-tagged comment's anchor is frozen.**

- For a comment with `commit = Some(oid)`:
  - If `oid` is **no longer present** in the current `merge-base..HEAD` set → `stale = true`
    (history was rewritten: rebased/amended/dropped). This is truthful and useful signal.
  - Else → leave the anchor untouched and `stale = false`. No re-anchoring needed (the
    commit's content cannot have changed).
- For a comment with `commit = None` → reconcile exactly as today (re-anchor against the
  review's canonical content, mark stale on miss).

To know the present commit set, `reconcile` computes the `merge-base..HEAD` oid set once (the
same revwalk as `list_commits`). The review's **canonical** `target` used for non-tagged
re-anchoring and the snapshot stays on whatever non-commit mode the review was opened with;
Commit mode is a *transient view* and must **not** be persisted as the review's canonical
target (otherwise non-tagged comments would re-anchor against a single commit). See "View vs
canonical target" below.

### Export ([export/](../../src-tauri/src/export))

Each tagged comment's exported block includes its commit, e.g. a `Commit: a1b2c3d — <subject>`
line (or grouping by commit). General/untagged comments are unchanged.

## Frontend changes (React / TypeScript)

### View vs canonical target

Commit mode is display-only. The displayed diff is fetched with a **transient** target
(`mode: "commit", commit: oid`) via `computeDiff` / `getFileDiff`, while the persisted
**review** keeps its canonical non-commit mode for reconcile/snapshot/anchoring of untagged
comments. Practically: switching to Commit mode (and stepping) changes what's rendered and
stamps new comments, but does not call `openReview` with `mode: commit` in a way that rewrites
the review's canonical target. The exact wiring (e.g. a separate `viewTarget` distinct from
`review.target`) is settled in the plan; the invariant is: **non-tagged comments never
re-anchor against a single commit.**

### Types / API / mock (all three layers — repo convention)

- [types.ts](../../src/types.ts): add `"commit"` to `DiffMode`; add `commit?: string` to
  `Target`; add `commit?: string` to `Comment`; add `CommitMeta`.
- [api.ts](../../src/api.ts): add `listCommits(target): Promise<CommitMeta[]>`.
- [dev/mockBackend.ts](../../src/dev/mockBackend.ts): implement `listCommits` against a
  fixture commit list; make `computeDiff`/`getFileDiff` honor `mode: "commit"` by returning a
  per-commit subset of the fixture, so `dev:mock` can exercise the feature.
- [route.ts](../../src/route.ts): include `commit` in target parse + URL sync; add
  `"commit"` to `MODES`.

### Components

- **New `src/components/ui/dropdown-menu.tsx`** — shadcn dropdown-menu (incl. `Sub`,
  `SubTrigger`, `SubContent`), importing `{ DropdownMenu as DropdownMenuPrimitive } from "radix-ui"`.
- **[Workspace.tsx](../../src/workspace/Workspace.tsx)**:
  - Replace the `<select>` with the dropdown-menu; build the items + the "Commit ▸" submenu
    from `listCommits` (fetched once per review, refreshed on refresh).
  - Track pinned `commitOid` alongside `diffMode`; entering Commit mode sets both; stepper +
    `[`/`]` move `commitOid`; trigger shows `Commit <shortOid>`; URL carries `&commit=`.
  - Render the stepper + counter only in Commit mode.
- **Comments** ([review/](../../src/review)): new comments stamp `commit = commitOid` in
  Commit mode; inline markers + pane filter to the current commit (+ general notes); index
  groups by commit.

## Edge cases

- **Root commit** (no parent): diff against the empty tree (all additions). `LastCommit`
  currently errors here; the new Commit arm must not.
- **Merge commit**: diff against first parent (v1); note in UI/tooltip if cheap, else silent.
- **History rewrite** (rebase/amend/drop): a tagged comment whose oid leaves `merge-base..HEAD`
  is marked stale (not deleted).
- **Empty range** (HEAD == base / on base branch): "Commit ▸" disabled with a hint; no stepper.
- **Base resolution failure / detached HEAD**: same behavior as the existing branch-vs-base
  path (surface the existing error).
- **Auto-refresh while pinned**: an fs change re-runs `list_commits`; if the pinned oid still
  exists, stay pinned; if it vanished (rewrite), fall back to the nearest valid commit or exit
  Commit mode (decide in plan; default: exit to Branch vs base with a notice).

## Testing strategy

**Rust**
- `list_commits`: linear branch returns expected oids newest-first; excludes base; empty when
  on base.
- Commit diff: isolated `parent→commit`; root commit → all-additions; merge → vs first parent.
- Reconcile: tagged comment kept fresh when its commit is present; marked stale when the oid is
  removed from range; untagged comments still re-anchor as before (existing tests stay green).

**Frontend (Vitest + happy-dom)**
- Mode dropdown renders the submenu; selecting a commit enters Commit mode and sets the URL.
- Stepper steps `commitOid` and disables at ends; `[`/`]` shortcuts.
- New comment in Commit mode is stamped; pane filters to the current commit; general notes
  always shown.
- `dev:mock` path: `listCommits` + per-commit diff fixtures work end-to-end.

**Manual / `dev:mock`** (per repo convention — no tauri-driver on macOS)
- `pnpm dev:mock`, open `?view=review&repo=demo`, exercise the submenu + stepper in light and
  dark, unified and split. Verify the toolbar isn't crowded in Commit mode.

Run `npx tsc --noEmit` and `pnpm test` before committing; `cargo test` for the Rust side.

## Files touched (orientation for the plan)

**Rust:** `git/model.rs`, `git/mod.rs`, `git/log.rs` (new), `commands.rs`, `review/model.rs`,
`review/reconcile.rs`, `export/*`, plus `lib.rs` (register `list_commits`).

**TS:** `types.ts`, `api.ts`, `dev/mockBackend.ts`, `route.ts`,
`components/ui/dropdown-menu.tsx` (new), `workspace/Workspace.tsx`, `review/*`.

## Deferred / open (non-blocking)

- Cumulative diff mode (history scrubber).
- Choosing a parent for merge commits.
- Exact prev/next arrow direction and counter origin (tune during implementation).
- Whether the comments index groups by commit in v1 or simply tags rows (default: tag rows,
  light grouping if cheap).
