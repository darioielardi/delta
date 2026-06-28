# delta: the worktree review queue — design

**Status:** approved design, pre-implementation
**Date:** 2026-06-28

## Problem

delta today models a review as: **pick a repo → drill into a worktree → choose a comparison.** The launcher ("Home") offers "Import repository…" plus a list of *reviews you've already opened*. The command palette repeats the funnel: New review → pick repo → pick worktree → opens `all-changes`. The comparison is then switched inside the workspace.

That model fights the actual workflow. The dominant pattern is **a few repos, each with several worktrees checked out at once — typically one per parallel agent/task.** The user switches between worktrees all day, and the job is reviewing agent output.

Three quiet commitments in the current design are wrong for that flow:

1. **Wrong altitude.** You don't pick "which project," you pick "which of my in-flight tasks." The repo is just a grouping label.
2. **Wrong list.** Home shows *reviews already opened* (history). The valuable list is *worktrees with new output you haven't reviewed yet* (a queue). The most important worktree each morning is often one you've never opened.
3. **Wrong default comparison.** Opening in `all-changes` is reasonable, but the review default should follow review state, not be a fixed mode.

## The reframe

Three definitions shift:

- **The unit is a worktree.** Branch ≡ worktree. delta does **not** support switching branches inside one checkout — you switch worktrees. (Confirmed against the actual workflow.)
- **A "Review" is no longer the thing you navigate to.** It becomes the **per-worktree review-state record**: which files you've marked Viewed (and at what content), your comments, and the snapshot used for comment anchoring. A worktree may or may not have one yet.
- **Home is the live queue** — the union of *every discovered worktree* with *its review-state*, keyed by worktree path. No saved Review = "never reviewed." Has a Review = "here's what's new since you looked."

Everything below is mechanics flowing from this.

## Discovery

- You **register a repo once.** The old "Import repository" becomes **"Add repo."** Opening any worktree also auto-registers its repo.
- delta runs `git worktree list` per registered repo and **watches each repo's refs + worktree dir**, so agent-created worktrees appear and merged ones disappear **live**, without a manual refresh.
- Enumeration is exact and cheap (git is the source of truth). No filesystem scanning of parent folders.

Rejected alternative: "point delta at ~/projects and scan." More magical but slow/noisy, needs ignore rules, and unreliable. Registration of a handful of repos is low friction and accurate.

## The queue (Home)

A **flat list** (a few repos × several worktrees stays scannable), repo shown as a **badge**, with an **optional repo filter**. Rows are partitioned into attention bands, then sorted by last activity within each band.

### Attention bands

Two bands, sorted by last activity within each. **Dirty (uncommitted changes present) is an overlay chip, not a band** — any uncommitted edit to a contribution file is itself unreviewed content, so it already lands in "needs review"; a separate "dirty" band would be near-empty and contradictory. delta also can't reliably tell "agent still working" from "agent finished but didn't commit," so it shouldn't claim to.

1. **Needs review** — never reviewed, OR at least one file in the worktree's contribution isn't *ticked-at-current-content* (new commits or new uncommitted edits since you last ticked). Top of the list. Carries a **dirty** chip when uncommitted changes are present.
2. **Up to date** — every contribution file is ticked at its current content and nothing new has landed. Dimmed, sinks to the bottom.

### Row anatomy

```
● feat/oauth-login          delta        5 new files · 12 unread          2m
  └ branch        repo badge   attention chip                  comments  time
  fix/race-in-watcher       delta        ✓ reviewed · uncommitted         18m
  chore/bump-deps           api-gw       merged — archived                 1h
```

Each row shows: branch name (primary), repo badge, an attention chip (unreviewed count / dirty / reviewed / merged), comment count, stale-comment warning if any, and last-activity relative time.

### Lifecycle

When `git worktree list` no longer reports a worktree (removed via `git worktree remove`, typically after merge), it **leaves the live queue** but its **Review is retained** — comments are never destroyed. It's findable via search / an "archived" filter, and marked **merged** if the branch landed. No auto-deletion of user comments.

## Reviewed-ness: per-file, content-aware, no "finished" concept

This is the core mechanic and the part most worth getting right.

"What I've reviewed" is **not** a timestamp or a commit you must *finish reaching*. It is a **set of files you've ticked Viewed, each at a specific content.** The data already exists: the GitHub-style per-file **Viewed** checkbox writes `review.viewed: [{ file, diffHash }]`.

Consequences:

- A review is never "finished" or "unfinished." It's however much of the set you've ticked.
- **Half-finished review is safe by construction.** Review files A and B, tick them, leave C untouched → `viewed = {A, B}`. Next visit, "needs review" = C (never ticked) + anything in A/B whose content changed since you ticked it. Nothing is lost; nothing needed a "done" signal.

### The wiring gap to close

Today the checkbox stores the filename only: `toggleViewed(file, "")` passes an empty `diffHash` (`src/workspace/Workspace.tsx`), and the dedupe checks `v.file === file`, ignoring the hash. So it currently cannot detect that a viewed file later changed.

**Fix:** compute and store the file's real current diff hash on tick. "Viewed" then means **"I have seen this file at this exact content."** When the agent edits it later, the hash differs and the file auto-reappears as unreviewed. This single change also drives the queue's "needs review" flag.

The existing `Review.snapshot` OIDs stay, but **only for comment anchoring / staleness reconciliation** — not for review progress. (These are separate concerns; an earlier framing conflated them.)

## Comparison modes

Per worktree, the comparison is a dropdown that **persists per worktree**. Exact semantics (right side = what HEAD is compared against):

| UI label | git range (base → right side) | status |
|---|---|---|
| **All changes** | `merge-base(HEAD, base)` → **working tree** | exists (`AllChanges`) |
| **Unreviewed** | contribution diff, minus files ticked-at-current-content | **new** |
| **Last commit** | `HEAD~1` → `HEAD` | exists (`LastCommit`) |
| **Uncommitted** | `HEAD` → **working tree** | exists (`Uncommitted`) |

**Dropped: "Branch vs base"** (`merge-base(HEAD, base)` → `HEAD`, committed-only). It differed from "All changes" only by excluding uncommitted edits. Folded into "All changes," which you almost always want. The "committed-only, ignore scratch edits" view is the acknowledged loss.

### "Unreviewed" is a filter, not a git range

"Unreviewed" is **the full contribution diff (All changes) with the files you've ticked-at-current-content filtered out.** It is driven by the viewed-set, not by a moving OID baseline — which is exactly what makes it robust to partial reviews.

**Granularity: file-level** (baseline). A ticked file that changes re-surfaces **whole**. Reuses the per-file `diffHash`; one hash per file. Accepted downside: a one-line agent tweak to an approved 400-line file brings the whole file back (you re-glance in context).

Rejected (deferred) alternative: **line-level** — additionally store the content you last saw per ticked file and, on re-surface, show only the new lines. True incremental review, but more state and more diffing. A later precision upgrade, not the baseline.

### Smart per-worktree default on open

- **No Review yet (first visit):** **All changes** (the whole contribution).
- **Has Review, unreviewed content exists:** **Unreviewed**.
- **Has Review, fully up to date:** **All changes** (so you never open into an empty pane).
- **Manual override wins** and persists per worktree (`Review.target.mode` already persists).

## Switching & the command palette

⌘K narrows to an **in-workspace fast-switch over the same live worktree pool** — same rows and attention chips as Home, minus the repo→worktree drill-down (that funnel is gone). "＋ New review" disappears; there is no "new," only "jump to a worktree." Home is for scanning the whole queue; ⌘K is for jumping without leaving the current review.

## Data model & backend changes

- **`DiffMode`** gains `Unreviewed` (`src-tauri/src/git/model.rs`, mirrored in `src/types.ts`). `BranchVsBase` is removed from the UI mode list (keep the enum variant if cheap, or migrate it to `AllChanges`).
- **New/enriched command — `listQueue()`** (or an enriched `listRegistry`): returns, per worktree, the review-state join — unreviewed file count, dirty flag, merged flag, comment/stale counts, last-activity time. Must be mirrored across `commands.rs`, `src/api.ts`, and `src/dev/mockBackend.ts` (the three-layer rule).
- **Queue enrichment is lightweight and cached.** Per worktree compute the contribution changed-file list + per-file diff hashes (e.g. name-status against the fork point), compare to the viewed-set to derive needs-review + unreviewed count. Cache keyed on `(worktree HEAD oid, working-tree dirty state)`; invalidate on the watcher event. **Full content diffs are computed lazily, only when a worktree is opened.**
- **Watch scope** extends from per-open-review to **per-registered-repo**, emitting a `queue:changed` event that refreshes Home live.
- **Viewed tick** computes and stores the real diff hash (closes the wiring gap above).

## The deferred-ref seam

Per the "keep the door open" decision: structure diff computation to take an explicit `(repoPath, baseRef, headRef)`, with "resolve a worktree to those refs" as **one** producer. A future arbitrary-ref / remote-branch / PR-by-number producer plugs in there without touching the renderer or review layer. **Build the seam, not the feature.** `Target` should be left open to a future `source` discriminant.

## Dropped

- Branch-in-place switching (you switch worktrees, not branches in a checkout).
- The repo → worktree → mode funnel.
- "Import then drill."
- "Branch vs base" mode (folded into "All changes").

## Build order (one spec, phased plan)

1. **Queue Home** — discovery (register + enumerate), enrichment + caching, attention bands, lifecycle/archive, live `queue:changed` watch. The visible reframe.
2. **Reviewed-ness + diff modes** — wire `diffHash` on tick; add the `Unreviewed` mode (contribution filtered by viewed-set, file-level); smart per-worktree default; persist override.
3. **Palette collapse + polish** — ⌘K becomes the flat worktree switcher; archived filter; repo filter.

## Validation

- **mock backend** grows queue fixtures: multiple repos × worktrees × states (never-reviewed, partially reviewed, fully up to date, dirty, merged/archived). Mirror `listQueue` there.
- **Unit tests** for the attention computation (unreviewed-exists derivation from viewed-set + content hashes) and the queue partition/sort.
- **UI validation** per the project rule: `pnpm dev:mock`, inspect via preview MCP, verify **light + dark** and both diff layouts (unified/split). Scroll-state-driven behavior verified by reasoning (headless preview freezes rAF).
- `npx tsc --noEmit` and `pnpm test` before committing; `cargo test` for backend changes.

## Naming note (cosmetic, easily changed)

The new mode is labeled **"Unreviewed"** because it literally shows unreviewed-at-current-content files and doesn't overpromise turn-granularity. Alternatives considered: "Since last review" (accurate, longer) and "Last turn" (resonant for agent users but implies single-turn semantics that aren't guaranteed when reviews are skipped).

## Alternatives considered (and rejected)

- **Stateless activity feed** (sort by recency/dirty, no review-state): simpler, but can't distinguish "new since I looked" from "already reviewed." Rejected — defeats the point of a queue.
- **Single last-looked OID baseline** for incremental review: requires a "finished review" concept that doesn't exist cleanly and loses unreviewed changes on a half-finished pass. Replaced by the per-file viewed-set.
- **Palette-first / persistent rail** as the primary surface: kept the palette as a secondary fast-switch; the live-queue Home is the primary landing.
- **Parent-folder scan discovery:** rejected for registration (see Discovery).
- **Line-level incremental granularity:** deferred as a later precision upgrade.
- **Per-repo focus affordance** (persistent repo filter / pinning / repo-name-as-primary label for sole-worktree rows): the "few repos, one worktree each" and "one focused main worktree" day-shapes are already comfortable because the window model keeps you inside a single review window and out of the queue (Home only reappears when the last review window closes). Deferred as YAGNI — revisit only if returning to the queue mid-focus proves annoying.
