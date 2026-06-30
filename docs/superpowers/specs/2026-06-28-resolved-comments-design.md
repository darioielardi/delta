# Resolved comments — design

- **Date:** 2026-06-28
- **Status:** proposed
- **Scope:** first slice of the larger "two-way comments MCP" effort.

## Context

delta lets a user review a git diff and leave structured comments to hand to an AI
agent. Comments today are flat and one-way:
`{ id, scope, anchor, body, stale, createdAt, updatedAt }` — no status, no replies,
no author. The agreed direction (see conversation) is a two-way MCP where an agent
reads the user's comments and reports back (replies + resolution).

This spec covers the first, independently useful increment: letting the **user mark
a comment resolved** in the delta UI. It establishes the `resolved` concept that the
later MCP write path will set on the agent's behalf.

## Goals

- A user can mark any comment resolved, and reopen it, from the comments pane.
- Resolved state persists across refresh / reopen.
- Resolved comments are excluded from the "Copy for agents" markdown export, so the
  agent's work list shows only open items.
- The registry tracks a resolved count alongside the existing comment/stale counts.

## Non-goals (deferred)

- MCP / agent setting `resolved` (next slice — writes to a per-review sidecar, merged).
- Replies / threads, comment author, a richer status enum (open/wontfix/…).
- Hiding or filtering resolved comments in the pane — **dim in place only** for now.

## Data model

Add one field to `Comment`:

- Rust (`review/model.rs`): `#[serde(default)] pub resolved: bool,`
- TS (`types.ts`): `resolved: boolean;`

`#[serde(default)]` keeps existing persisted reviews loading (they deserialize with
`resolved: false`). No `Review.version` bump — this is an additive optional field.
`addComment` (in `useReview`) initializes `resolved: false`.

Persistence reuses the existing `save_review` path (the whole `Review` is written to
`<id>.json`), so **no new Tauri command** is needed.

## Behavior

### Toggling

- New `useReview` action `toggleResolved(id)`: flips `resolved`, bumps `updatedAt`,
  persists immediately via `mutate(..., "now")` — same shape as `deleteComment`.
- Threaded through `Workspace` → `CommentThread` as an `onToggleResolved` prop.

### Comments pane (`CommentThread`)

- When a comment is resolved: render a green "✓ Resolved" chip (parallel to the
  existing amber "⚠ stale" chip), dim the comment row (reduced opacity), and show a
  **Reopen** action; when open, show **Resolve**. Edit and Delete remain available.
- Dim in place — nothing is hidden or filtered in this slice.

### Export (`export/mod.rs`)

- Exclude resolved comments from **both** the General section and the per-file
  grouping (a single `!c.resolved` predicate added to the existing filters).
- Stale comments are unaffected — still included and marked as today.

### Counts (`registry/model.rs`)

- Add `resolved_count: u32` to `ReviewEntry`; in `from_review`, count non-general
  resolved comments (reuse the existing `visible` filter, parallel to `stale_count`).
- Mirror in TS `ReviewEntry` and in `dev/mockBackend.ts`.
- Surface in the launcher next to the existing counts, mirroring how `stale_count`
  is shown.

## Forward compatibility (the MCP slice)

When the agent write path lands, agent-set resolutions will live in a per-review
**sidecar** (`<id>.agent.json`) that the app reads but the agent's process owns —
avoiding any concurrent write to the app-owned `<id>.json`. The UI and export will
then read an **effective** resolved value:
`effectiveResolved = comment.resolved || sidecar.resolved.has(comment.id)`.

Today there is no sidecar, so `effectiveResolved == comment.resolved`. The field name
and semantics chosen here do not change when the sidecar is introduced.

## Three-layer checklist (per CLAUDE.md)

This changes serialized types, so update every layer that mirrors them:

- Rust: `review/model.rs` (`Comment`), `registry/model.rs` (`ReviewEntry`)
- TS: `types.ts` (`Comment`, `ReviewEntry`)
- Mock: `dev/mockBackend.ts` fixtures, so `pnpm dev:mock` keeps working

No `commands.rs` / `api.ts` change (no new command).

## Tests

- Rust `export`: a resolved comment is omitted; an open one is present.
- Rust `registry::from_review`: `resolved_count` counts non-general resolved; a
  resolved general comment is excluded.
- TS `useReview`: `toggleResolved` flips state and triggers `saveReview`.
- (Optional) `CommentThread` render test: ✓ chip + Resolve/Reopen toggle.

## Validation

Per repo convention: `npx tsc --noEmit`, `pnpm test`, and `cargo test` (in
`src-tauri`). UI check via `pnpm dev:mock` (light + dark, unified + split): verify the
chip, the dimmed row, and the Resolve/Reopen toggle, and confirm a resolved comment
drops out of the exported markdown.
