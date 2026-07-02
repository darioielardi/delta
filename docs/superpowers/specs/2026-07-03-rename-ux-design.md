# Renamed-file UX — design

- **Date:** 2026-07-03
- **Status:** proposed
- **Scope:** make renamed files legible in the diff — surface the old→new path, and
  give pure renames (no content change) a real placeholder instead of a bare fold.

## Context

delta lets a user review a git diff and leave structured comments for an AI agent.
The backend already detects renames and ships everything needed to display them:

- `FileEntry` (summary) carries `oldPath` ([diff.rs:99-106](../../../src-tauri/src/git/diff.rs), mirrored in [types.ts:24](../../../src/types.ts)), set only when the old path differs from the new.
- `FileDiff` (per file) carries `oldFileName` / `newFileName` ([diff.rs:127-136](../../../src-tauri/src/git/diff.rs), [types.ts](../../../src/types.ts)).

But the frontend drops the rename signal at every render site:

1. **File tree/list** ([FilesPanel.tsx:103-122](../../../src/files/FilesPanel.tsx)) shows only the new name with a sky-blue icon; no old path, no tooltip. The icon color is the *only* signal, and it's invisible in list mode (the whole path is the label).
2. **Diff card header** ([VirtualDiffPane.tsx:794-813](../../../src/diff/VirtualDiffPane.tsx)) renders only the new `dir`/`base` — identical to an unchanged file.
3. **Diff card body** — for a pure rename old and new content are identical, so `isChanged()` is false for every line ([VirtualDiffPane.tsx:531-539](../../../src/diff/VirtualDiffPane.tsx)) and the whole file collapses into one fold row reading `"N hidden lines"` ([FoldRow:300](../../../src/diff/VirtualDiffPane.tsx)). Nothing says it was renamed.

`oldFileName` reaches only `toDiffFile` (model/language detection) — never the DOM.

There is also **no rename fixture** in [mockBackend.ts](../../../src/dev/mockBackend.ts), so this UX can't be exercised in `pnpm dev:mock`.

## Goals

- Every renamed file shows `old → new` in its card header.
- A file renamed with **no content changes** shows a dedicated placeholder ("File
  renamed without changes") with a **Show content** reveal, not a bare fold.
- Renamed rows in the file tree/list carry a "Renamed from …" hover tooltip.
- The rename UX is visible in `pnpm dev:mock` and covered by tests.

## Non-goals (deferred / YAGNI)

- Showing `old → new` inline in the tree/list — the rows are narrow, fixed-height,
  and virtualized; doubling row width isn't worth it. Tooltip only.
- In-code find reaching an un-revealed pure rename's content — deliberately matches
  the existing deleted-file behavior (content is gated behind the reveal).
- Any backend / Tauri command / serialized-type change — all fields already exist.

## Data model

**No changes.** `FileEntry.oldPath`, `FileDiff.oldFileName`, and `FileDiff.newFileName`
already exist across Rust, TS, and are populated by the backend. This is a
frontend-only, presentation-only change. Only mock **fixtures** (data, not schema)
gain rename entries.

## Behavior

### 1. Card header — `old → new` (all renames)

[VirtualDiffPane.tsx:794-798](../../../src/diff/VirtualDiffPane.tsx)

When `entry.status === "renamed"` and `entry.oldPath` is set, replace the single
name span with: old path (muted) + ` → ` + new path (dir muted, base bold — current
styling).

- **Same directory** (old dirname === new dirname) → collapse the new side to its
  basename: `src/auth/session.ts → authSession.ts`.
- **Moved + renamed** → show both in full: `src/auth/session.ts → src/core/authSession.ts`.
- **Truncation:** the old-path span is the flexible/truncating one (`min-w-0 truncate`);
  the arrow and new name are `shrink-0`, so overflow eats the source, never the
  destination.
- The `+/−` counts ([:810-813](../../../src/diff/VirtualDiffPane.tsx)) still render when a
  rename also has edits. The copy button keeps copying the new name (`base`).

**Pure helper** — extract `src/diff/renameLabel.ts`:

```ts
// Returns the pieces the header needs; pure + unit-testable.
export function renameParts(oldPath: string, newPath: string): {
  oldPath: string;      // full old path (the truncating span)
  newDir: string;       // "" when same dir as old (→ show basename only)
  newBase: string;      // new basename
};
```

`newDir` is empty when the directories match (drives the same-dir collapse); the JSX
stays thin.

### 2. Card body — pure-rename placeholder

[VirtualDiffPane.tsx:925-953](../../../src/diff/VirtualDiffPane.tsx)

Add `isRenameOnly = entry.status === "renamed" && entry.additions === 0 && entry.deletions === 0`.

Mirror the existing **deleted-file** placeholder exactly:

- New body branch (before the final code-rows `else`), shown when `isRenameOnly && !revealed`:
  an arrows/rename icon + "File renamed without changes" + a `Show content` button
  that does `setRevealed(true); void cache.load(entry.path);` — then the normal
  (fully-folded, expandable) rows render.
- Fold `isRenameOnly` into the surrounding gates so it behaves like a deleted file:
  - `showPlaceholder` ([:420](../../../src/diff/VirtualDiffPane.tsx)) — add `|| (isRenameOnly && !revealed)`.
  - `wantModel` ([:425](../../../src/diff/VirtualDiffPane.tsx)) — don't build the model until revealed (parallel to `(!isDeleted || revealed)`).
  - Comment-button reveal-first guard ([:882](../../../src/diff/VirtualDiffPane.tsx)) — add `isRenameOnly` so a file comment isn't created behind the placeholder.
- Height: add `isRenameOnly` to `estReserved` ([:99](../../../src/diff/VirtualDiffPane.tsx)) so it reserves
  `PLACEHOLDER_BODY_H` (72px) while un-revealed; the measured model height overrides
  via `bodyHeights[path]` once revealed — the same dance deleted/giant files do.

### 3. File tree / list — hover source (all renames)

[FilesPanel.tsx:74-107](../../../src/files/FilesPanel.tsx)

Add `title={"Renamed from " + node.entry.oldPath}` on renamed file rows (guard on
`status === "renamed" && entry.oldPath`). `node.entry` is a `FileEntry` and already
carries `oldPath`. No layout change — the sky icon still flags "renamed"; the tooltip
names the source.

## Mock fixtures ([dev/mockBackend.ts](../../../src/dev/mockBackend.ts))

Add two rename fixtures so the UX is visible in `dev:mock` and testable, wired into
both the summary (`oldPath`) and `FILE_DIFFS` (`oldFileName`/`newFileName`, `status: "renamed"`):

1. **Same-dir pure rename** — identical old/new content, `additions: 0, deletions: 0`.
   Exercises the basename-collapse header + the "renamed without changes" placeholder.
   e.g. `src/auth/token.ts` from `src/auth/session-token.ts`.
2. **Moved + renamed with edits** — different dir, a few changed lines. Exercises the
   full-path header alongside `+/−` counts and normal diff rows.
   e.g. `src/core/http.ts` from `src/api/client.ts`.

## Tests

- `renameLabel.test.ts` — same-dir (→ `newDir === ""`), moved (→ full new dir),
  root-level file, nested paths.
- `VirtualDiffPane.test.tsx` — renamed header renders old→new (both same-dir and moved
  forms); a pure rename renders the placeholder and `Show content` reveals the rows.
- `FilesPanel` — a renamed row carries the `Renamed from …` tooltip.

## Validation

Per repo convention: `npx tsc --noEmit` and `pnpm test` (no Rust change, so `cargo
test` is unaffected). UI check via `pnpm dev:mock` (light + dark, unified + split):
verify the header old→new for both fixtures, the pure-rename placeholder + Show
content reveal, the `+/−` counts on the moved+edited file, and the tree tooltip.
Headless preview can't drive scroll/rAF, so reason about virtualization height
(the `PLACEHOLDER_BODY_H` reservation) rather than trying to exercise it there.
