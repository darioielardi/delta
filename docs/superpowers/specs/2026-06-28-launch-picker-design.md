# delta: the launch picker — design

**Status:** approved design, pre-implementation
**Date:** 2026-06-28

## Context

delta's front door is now the terminal: a bare `delta` inside a worktree opens that worktree's review directly (merged). The launch window and the ⌘K command palette are therefore the **in-app fallback** — used when you're already in delta and want to jump to *another* worktree's review without going back to a terminal.

The user's workflow: 2–5 parallel Claude Code chats, each in a worktree (sometimes the repo's main worktree), across 1–3 repos. Iterate with the agent until the output is right, then review — usually by running `delta` in that chat's embedded terminal. The in-app need is narrow and explicit: *"a minimal 'open this other review in this repo/worktree' UX."*

## Problem with today's surfaces

- **Home** (`src/Home.tsx`) is an import-first hero + a short recents list. It centers "Import repository," which is the wrong primary action in a terminal-first world.
- **CommandPalette** (`src/picker/CommandPalette.tsx`) is a multi-page funnel: recents → pick repo → pick worktree, plus "New review." The funnel is exactly the friction we're shedding.

Two surfaces, overlapping jobs, both shaped around a navigation model (repo → worktree drill-down) the workflow doesn't use.

## The reframe: one picker, two frames

There is no separate "launcher" and "command palette." There is **one picker — "open a review" — mounted in two frames:**

- **Home window** — centered, slim brand mark, settings affordance. Shown on dock/Spotlight launch and when the last review window closes (the "what next" moment).
- **⌘K overlay** — top-anchored (the documented modal exception per the centered-modals rule), shown inside a review for fast switching; excludes the review you're currently in.

Same list, same behavior, two thin wrappers around a shared `ReviewPicker`.

## What the picker lists

One flat, fuzzy-searchable list (search matches branch, repo name, path). For 1–3 repos this is ~6–15 rows, so there is **no drilling**. Light grouping for scannability:

```
🔍  Search reviews & worktrees…
────────────────────────────────────────
 RECENT
 ⎇ feat/oauth-login    delta     ✎3  ⚠1     2m
 ⎇ fix/watcher-race    delta     ✎0          1h
 OTHER WORKTREES
 ⎇ main                delta     uncommitted  3h
 ⎇ chore/deps          api-gw                 1d
────────────────────────────────────────
 +  Add a repo…
```

- **Recent** — worktrees you've reviewed in delta (saved reviews), newest first, showing review state (comment count, stale count, last-opened). Ranked by `rankReviews`/fuzzy.
- **Other worktrees** — the **current** worktrees of every repo delta knows, excluding those already shown under Recent. Sorted by last-commit recency; a dirty worktree shows an "uncommitted" marker.
- **Known repos populate automatically.** delta knows a repo once you've opened any of its worktrees — including via the terminal front door. No manual registration step. (Requirement: opening a target registers its repo in the registry if not already present; the implementation plan wires this if the current open path doesn't.)
- **De-dup by worktree path:** a worktree that has a saved review appears once, under Recent — never twice. (Reuse the palette's existing `reviewForWorktree` matching.)
- **+ Add a repo…** — pinned at the bottom; folder import for a repo delta hasn't seen yet.

Grouping is light by design; the alternative (fully flat, recents simply sorted first) is acceptable and a trivial switch.

## Behaviors

- **Open a Recent** → restores its saved target (its last mode/base).
- **Open an Other-worktree** → opens with the current default mode (`all-changes`, same as a fresh terminal open), creating a new review. (The smart per-worktree diff default is a *separate* deferred spec and is intentionally not coupled here.)
- **Add a repo…** → folder dialog → if the repo has exactly one worktree, open it; if several, the list refreshes and filters to that repo so you pick one. Reuses today's import logic minus the deleted worktree page.
- **Keyboard** (unchanged from the palette): type to filter, ↑↓ to move, ↵ to open, ⌘⌫ to delete a recent, esc to close/dismiss.
- **Current-review exclusion:** in the ⌘K frame, the review you're in is omitted (you can't switch to where you already are). Home shows everything.
- **After the last review window closes** → Home reappears showing this picker. This is the existing window-lifecycle behavior (`lib.rs` reopens `home`); only Home's *content* changes, not the lifecycle.

## Data & backend

The picker needs recents **plus live worktrees** for known repos in one shot. `list_registry` returns a *persisted* snapshot (`repos[].worktrees[]` is as-of last open), which is too stale to surface newly-created agent worktrees — the whole point of "Other worktrees."

- **New command `list_picker`** → returns `{ recents: ReviewEntry[], worktrees: WorktreeRow[], home }`, where `WorktreeRow` is a `WorktreeEntry` enriched with `repoName`/`repoId`. It enumerates worktrees **live** via the existing `list_worktrees` for each known repo, then drops worktrees that already have a saved review (de-dup). Mirror across the three layers: `commands.rs`, `src/api.ts`, `src/dev/mockBackend.ts`.
- `list_registry` stays as-is (cheap, persisted) for any other caller.
- **No filesystem watching.** The picker enumerates on open only (cold launch, ⌘K, after-close) — a handful of `git worktree list` calls, cheap. There is no live queue, no background watcher across repos.

## Components & code changes

- **New `src/picker/ReviewPicker.tsx`** — the shared inner component: search input, grouped list, keyboard nav, row rendering, `onOpen` / `onAddRepo` / `onDeleteRecent`. Built from `list_picker` data.
- **`src/Home.tsx`** — drop the import-first hero screen; mount `ReviewPicker` with a slim brand mark + settings, and an empty state ("Add a repo… or run `delta` in a repo").
- **`src/picker/CommandPalette.tsx`** — remove `Page`/repo-page/worktree-page/`chooseRepo`/`chooseWorktree`/`New review`; become a thin overlay wrapper mounting `ReviewPicker` with current-review exclusion.
- Reuse `rankReviews`/`fuzzy`; extend ranking to cover worktree rows.
- Keep `importRepo` and `installCli`; "Add a repo…" calls `importRepo`.

## Scope — non-goals

Not in this spec: the live review queue, fs-watching of all repos, attention bands, the smart per-worktree diff default (separate deferred spec), a menu-bar tray, and arbitrary-ref/PR review (separately deferred). This spec is strictly: collapse Home + CommandPalette into one flat picker that reaches recents + known-repo worktrees + add-repo.

## Build order

1. **Backend** — `list_picker` command (live worktrees + recents + de-dup), mirrored in `api.ts` and `mockBackend.ts` with multi-repo/multi-worktree fixtures.
2. **`ReviewPicker`** — shared component + ranking, driven by `list_picker`.
3. **Mount + delete** — wire `ReviewPicker` into Home and CommandPalette; delete the funnel pages and the import-hero.

## Validation

- Unit tests: `list_picker` de-dup (worktree-with-review excluded from Other), worktree enumeration, ranking order (recents before other; recency within).
- UI validation per the project rule: `pnpm dev:mock`, inspect via preview MCP, verify light + dark, in both the Home frame and the ⌘K overlay frame. Confirm the empty state.
- `npx tsc --noEmit`, `pnpm test`, and `cargo test` before committing.

## Alternatives considered (and rejected)

- **Keep the repo→worktree funnel** (full browse): rejected as the friction the workflow doesn't need; "Add a repo…" covers the rare unknown-repo case in one step.
- **Recents only** (no live worktrees): rejected — couldn't reach an agent's new worktree you haven't reviewed yet, which is a real in-app jump.
- **Refresh worktrees inside `list_registry`**: rejected to keep that call cheap and its contract stable; a dedicated `list_picker` is clearer.
- **Two separate surfaces** (keep Home and palette distinct): rejected — same job, double the maintenance; one shared `ReviewPicker` in two frames is simpler.
- **Fully flat list** (no Recent/Other grouping): viable; kept as the fallback if the light grouping feels heavy.
