# Design: Mode-as-view + native-feel polish

- **Date:** 2026-06-26
- **Status:** Approved (pending spec review)
- **Scope:** One implementation plan. Seven related changes: one architectural (decouple diff mode from review identity) plus six smaller UI/native-feel items.

## Context

Two classes of work:

1. **Product** — three behavior changes requested by the user:
   - Diff *mode* (`all-changes` / `uncommitted` / `last-commit` / `branch-vs-base`) should not be part of a review's identity. Today it is, which causes (a) the same repo/worktree appearing multiple times in the picker (once per mode) and (b) switching mode spawning a new window.
   - Reorder the per-file header actions.
   - Add a split/unified diff-layout toggle, persisted globally across all sessions.

2. **Native-feel** — four items from a prior Tauri-on-macOS audit the user approved:
   - Cold-start white flash.
   - `prefers-reduced-motion` support.
   - Window size/position restoration.
   - Move blocking git work off the main thread.

### Decisions (from clarifying questions)

| Question | Decision |
|---|---|
| Existing per-mode review data on ID-scheme change | **Start fresh** — drop old review entries; leave orphaned files on disk; do not merge. |
| Where the split/unified preference lives | **localStorage** (frontend-only, shared across windows by same origin). |
| File-header action layout | **All three grouped right:** `[+adds −dels] · [add comment] · [Viewed]`. |

## Current architecture (relevant facts)

- `review_id(repo_path, worktree, mode) = SHA-256(repoPath ␀ worktree ␀ mode)[..16hex]` — [src-tauri/src/review/model.rs](../../src-tauri/src/review/model.rs). Mode is part of the identity, so each mode is a separate `Review` (own comments, `viewed`, snapshot), a separate `<id>.json`, and a separate registry `ReviewEntry`.
- The mode `<select>` in the workspace header calls `api.openTarget(...)`, which routes through `open_target_window` and creates a window labelled `review-{id}`. Different mode → different id → new window. — [src/workspace/Workspace.tsx](../../src/workspace/Workspace.tsx), [src-tauri/src/launch/mod.rs](../../src-tauri/src/launch/mod.rs).
- The picker lists `registry.reviews` one row per entry, badged with the mode. — [src/picker/CommandPalette.tsx](../../src/picker/CommandPalette.tsx).
- `DiffView` already accepts a `mode: "unified" | "split"` prop, hardcoded to `"unified"`. — [src/diff/DiffPane.tsx](../../src/diff/DiffPane.tsx).
- Per-file header actions live in `FileSection`; counts sit inside the filename span, with `Viewed` then add-comment on the right. — [src/diff/DiffPane.tsx](../../src/diff/DiffPane.tsx).
- Windows are created programmatically (config `windows: []`), already with `TitleBarStyle::Overlay`, `hidden_title`, `traffic_light_position`. No `visible(false)`, no background color, no window-state plugin, no menu (relies on the v2 default menu). — [src-tauri/src/launch/mod.rs](../../src-tauri/src/launch/mod.rs).
- Git commands `compute_diff`, `get_file_diff`, `open_review`, `refresh_review` are synchronous `pub fn` → run on the main thread in Tauri v2. — [src-tauri/src/commands.rs](../../src-tauri/src/commands.rs).

## Detailed design

### 1. Mode becomes a per-window view setting

**Identity (backend)**
- Change `review_id(repo_path, worktree)` — drop the `mode` argument and the corresponding hash input. One `Review` per (repo, worktree).
- Update every caller: `open_target_window`, `open_review_impl`, and any test. The window label `review-{id}` is now mode-independent.
- `Target.mode` stays on the struct (the diff engine needs it) but is now "the last mode used," not an identity component.

**Open / switch flow (backend)**
- `open_review_impl(target)`: compute id from (canonical repo, resolved worktree); load-or-create that review; set `review.target.mode = target.mode`; compute the diff for that mode; reconcile/re-anchor comments and snapshot against it; persist. This is the same reconcile path Refresh already uses.
- Switching mode is just `open_review` again with the same id and a different mode. No window routing.

**Switch flow (frontend)**
- `Workspace` owns `diffMode` as local state, initialised from `target.mode`. The `open()` effect keys on `[target.repoPath, target.base, diffMode]`.
- The mode `<select>` calls `setDiffMode(next)` instead of `api.openTarget(...)`.
- On change, `history.replaceState` the `mode` query param so a window reload restores the current mode (the review's persisted `target.mode` is the source of truth on a fresh open from the picker).

**Picker (frontend)**
- Each (repo, worktree) review is already unique once mode leaves the identity, so the root page shows one row per worktree. **Remove the mode badge** from review rows.
- Opening a review still passes `r.target.mode` to `openTarget` so the window opens at the last-used mode.

**Comment semantics (consequence, accepted)**
- Comments and `viewed` belong to the (repo, worktree) review across all modes. On a mode switch they re-anchor against the new diff via the existing reconcile logic; a comment whose anchor is absent from the current mode's diff becomes **stale** until a mode that contains it is shown again. `viewed` remains keyed by `{file, diffHash}` (diffHash is mode-specific), so a file's viewed state is naturally per-mode. No change to the staleness/anchoring engine.

**Migration — start fresh**
- Bump `Registry.version` 1 → 2 (`Registry::empty()` produces version 2).
- On registry load, if the loaded `version < 2`: clear `reviews`, keep `repos`, set `version = 2`, and persist immediately so stale per-mode rows don't reappear.
- Bump `Review.version` to 2 for newly created reviews (`Review::new`).
- `JsonRegistryStore::rebuild()` (the corrupt/missing-registry fallback) skips review files with `version < 2`, so pre-existing per-mode files are never resurrected.
- Orphaned `<oldid>.json` files are left on disk (not deleted). `open_review` for an existing worktree computes the new id, finds no file, and creates a fresh review — old comments are never loaded. This honours "start fresh" on both the normal and rebuild load paths.

### 2. Split/unified layout toggle

- Rename `DiffView`'s `mode` prop to `layout: "unified" | "split"` to avoid colliding with `DiffMode`. `git-diff-view` already supports split rendering.
- Add a `useDiffLayout()` hook backed by `localStorage["delta:diffLayout"]` (default `"unified"`). It reads on mount, writes on change, and subscribes to the window `storage` event for live cross-window sync (changing layout in one window updates others of the same origin).
- Thread the value from `Workspace` → `DiffPane` → each `FileSection` → `DiffView`.
- Add a compact toggle control in the workspace header, near the mode `<select>`.

### 3. File-header action reorder

- In `FileSection`, remove the `+adds −deletions` counts from the filename span and render them in the right-hand action cluster, ordered: `[+adds −dels]` · `[add comment]` · `[Viewed]`. The filename span keeps `flex-1` to push the cluster right.

### 4. Cold-start flash

- Build both windows with `.visible(false)` in `open_target_window` and `open_home_window`.
- The frontend calls `getCurrentWindow().show()` after first paint (a `requestAnimationFrame` after `App` mounts); the themed app shell paints before the window is shown, so there is no white frame. Guard with the existing `VITE_MOCK_IPC` check used in `readLabel`.
- Set `background_color` on the window builder to match the current system theme as a fallback for the compositor's first frame. If that builder method is unavailable in the pinned Tauri 2.x, drop it — show-after-paint is sufficient on its own.

### 5. prefers-reduced-motion

- Add a global `@media (prefers-reduced-motion: reduce)` block in [src/index.css](../../src/index.css) that reduces transition/animation durations to ~0 and sets `scroll-behavior: auto`.
- Confirmed: all motion in the app is pure CSS (`transition-*` utilities, `duration-200`, `tw-animate-css`) — no JS animation library. The global media query covers everything; no per-component JS gating needed.

### 6. Window state restoration

- Add `tauri-plugin-window-state` (Cargo dependency, JS plugin init in `run()`, capability permission in `capabilities/default.json`).
- It saves and restores size/position per window label. Restored bounds override the fixed `inner_size`/`.center()` on subsequent launches; first launch still uses the configured defaults.

### 7. Async git commands

- Convert `compute_diff`, `get_file_diff`, `open_review`, `refresh_review` to `async fn` and run the git2 work via `tauri::async_runtime::spawn_blocking`, so heavy diffing on large repos never blocks the main thread. The `*_impl` functions stay synchronous and are invoked inside the blocking closure (inputs are `Send + 'static`; the `git2::Repository` is created and dropped inside the closure).

### 8. Files-panel header: global diff count + viewed ratio

- Restructure the `FilesPanel` header ([src/files/FilesPanel.tsx](../../src/files/FilesPanel.tsx) line ~183).
- **Left:** a global diff count — sum of `additions` / `deletions` across `files`, rendered `+N −M` in the same emerald/rose style as the per-file counts.
- **Right (in order):** the `viewed/total` ratio (e.g. `0/55 viewed`, moved here from the left), then the existing list/tree `ToggleGroup`. The ratio sits immediately left of the toggle.

### 9. List-mode left padding

- In `list` mode every row is a root-level file, but `TreeBranch` still renders the `w-3.5` chevron-column spacer ([FilesPanel.tsx:62](../../src/files/FilesPanel.tsx#L62)) meant for tree expand arrows, over-indenting list rows.
- Thread a `flat` flag (mode === "list") into the rows and omit the chevron spacer for flat file rows, so list items align tighter to the left. Tree mode is unchanged.

### 10. Traffic-light position

- The lights still read as mis-centered in the 48px overlay header (see screenshot). Adjust `traffic_light_position` in both `open_target_window` and `open_home_window` ([launch/mod.rs](../../src-tauri/src/launch/mod.rs)) so the cluster is vertically centered in the `h-12` (48px) titlebar — target `y ≈ 18`, tuned by screenshot. Keep `x = 16`; verify the header's `pl-24` inset still clears the lights.
- Verification is visual: `pnpm dev:mock` + preview MCP screenshot, per the UI-validation harness.

### 11. File-tree jump lands at the wrong scroll position

- Bug: clicking a file in the tree sometimes scrolls hundreds of px off; a second/third click corrects it.
- Cause: in the `DiffPane` jump effect, the no-`commentId` (file-only) path skips the convergence loop and does a single `sec.scrollIntoView({ block: "start" })` ([DiffPane.tsx:305](../../src/diff/DiffPane.tsx#L305)). With `content-visibility: auto`, sections above the target carry only `contain-intrinsic-size` *estimates*; once they paint with real heights the target shifts, so a one-shot scroll computed from estimates lands wrong.
- Fix: give the file-only path the same converge-until-stable behavior the comment path already has — compute the desired `scrollTop` to align the section header to the pane top, set it instantly, re-measure after the revealed region settles, and repeat until the target stops moving (or max tries). One click should land correctly.
- Verify in mock mode that a single click on assorted far-down files lands on the file header.

## Testing

- **Rust**
  - `review_id`: stable, 16 hex, and **mode no longer changes the id** (replace the existing "mode participates" assertion).
  - Registry migration: a v1 registry with review entries loads as v2 with `reviews` empty and `repos` preserved; `rebuild()` ignores `version < 2` review files.
  - Async commands still roundtrip (existing command/impl tests adapted).
- **Frontend**
  - Picker: one row per worktree, no mode badge.
  - Workspace: changing the mode `<select>` calls `api.openReview` with the new mode and does **not** call `api.openTarget`.
  - `useDiffLayout`: persists to localStorage and updates on a `storage` event; `DiffView` receives `layout`.
  - `FilesPanel`: header renders global `+N −M` totals and the `viewed/total` ratio sits left of the list/tree toggle; list mode omits the chevron spacer (tighter left padding) while tree mode keeps it.
- Follow TDD (test-first) for each unit. Scroll-convergence (#11) and traffic-light/cold-start visuals are verified in mock mode via the preview MCP rather than unit tests.

## Out of scope

- Window vibrancy / `windowEffects` and a custom menu bar (deferred; the v2 default menu already provides Edit shortcuts).
- Automatic merge of existing per-mode comments (explicitly chose start-fresh).
- Changes to the anchoring/reconcile engine itself.

## Risks

- **Cross-mode re-staling:** switching between very different modes (e.g. uncommitted ↔ branch-vs-base) can mark many comments stale at once. Inherent to unifying mode; accepted.
- **`background_color` API availability** in the pinned Tauri 2.x — verify at implementation; drop if absent.
- **window-state vs. visible(false):** ensure restoration happens before `show()` so the window doesn't flash at default bounds then jump.
