# AI walkthrough backend — design

- **Date:** 2026-07-01
- **Status:** proposed
- **Scope:** implement the real `generate_walkthrough` backend so the AI-guidance
  ("Guide") walkthrough runs against live repos via the local `claude` CLI, replacing
  the mock-only path. Adds CLI-status gating, cancellation, persistent caching, and a
  dismissable error strip. macOS-first (matches the rest of the app); no platform-specific
  blockers.

## Context

The entire Guide UX is built and wired; only the generator is missing. `api.generateWalkthrough`
maps to the `generate_walkthrough` IPC command ([api.ts](../../../src/api.ts)), but **there is
no Rust handler** — it is not in the `generate_handler!` list ([lib.rs](../../../src-tauri/src/lib.rs))
and is served entirely by the dev fixture backend ([mockBackend.ts](../../../src/dev/mockBackend.ts),
canned `WALKTHROUGH` / `genLargeWalkthrough`). The api.ts comment says as much: *"Backend handler is
deferred — mock-served today."*

Everything downstream of the command is real and stays unchanged in shape:

- **Data model** — `Walkthrough { version, title, summary, groups[], ignored[], degraded? }`,
  groups carry `importance` (core/supporting/skim), ordered `files[]`, and `risks[]`
  ([types.ts](../../../src/types.ts)).
- **Consumers** — `GuidePanel`, the standalone `GuideWorkspace` (dev/mock window), and the in-place
  guide mode in [Workspace.tsx](../../../src/workspace/Workspace.tsx).
- **Reading-order reflow** — `orderFilesForDiff` ([orderFiles.ts](../../../src/guide/orderFiles.ts)).
- **Gating** — clean worktree only (`dirty`) + `branch-vs-base`/`all-changes` modes; first-run
  confirm dialog already says *"reads this diff with Claude… uses your Claude credits."*
- **Staleness** — `guideGenSig` / `guideDiffSigRef` track when the live diff drifts from the
  generated one.

Backend facts that shape this design: diffs are computed in-process via **git2** (not shelling git;
`git2::Patch::from_diff` already produces per-file patches at [git/diff.rs](../../../src-tauri/src/git/diff.rs)),
the established subprocess pattern is **sync `std::process::Command`** ([commands.rs](../../../src-tauri/src/commands.rs),
editor launch), reviews persist as `<id>.json` via `serde_json` (atomic tmp+rename) in
`<app_data>/reviews` ([storage/mod.rs](../../../src-tauri/src/storage/mod.rs)), and the `Review` struct
lives at [review/model.rs](../../../src-tauri/src/review/model.rs). There are **zero existing `claude`
references** — this is greenfield. (`cli_status`/`install_cli` concern *delta's own* CLI symlink,
unrelated.)

Installed CLI verified: `claude` 2.1.193 at `~/.local/bin/claude`.

## Decisions (settled)

| Decision | Choice |
|---|---|
| **Invocation** | Local `claude` CLI, headless (`claude -p`), auth via keychain/OAuth (no API key → "uses your Claude credits" holds) |
| **Isolation** | `--safe-mode` (disables hooks/MCP/skills/plugins/global+project CLAUDE.md/commands/agents) + **self-injected** repo CLAUDE.md/docs |
| **Diff context** | Bounded unified diff piped in, **no tools**; degrade to file-list + stats past a budget and set `degraded: true` |
| **Structured output** | `--output-format json` → extract `result` → serde-validate into `Walkthrough` → one repair retry |
| **Output quality** | Prompt rubric (unbiased orientation, calibrated length, right granularity) + machine-checked invariants (2–N groups, full coverage, length bounds) enforced via the repair loop |
| **Caching** | Persist with the review, keyed by a canonical diff signature (incl. injected-context hash); regenerate only when stale or user-forced |
| **Min-diff gate** | Block generation for trivially small diffs with a popup (NoticeDialog), client-side, before any spawn |
| **Failure UX** | Pre-flight `claude_status` gate + **dismissable** error strip |
| **Cancellation** | Track the in-flight child per review; `cancel_walkthrough` kills it; killed on guide exit / window close / regenerate-supersede |

### Why `--safe-mode` + self-injected context, not auto-discovery

The requirement is strict: *nothing* from the user's environment may leak into the analysis — no MCP
servers, no hooks, no skills/plugins, no global `~/.claude/CLAUDE.md` — but the repo's own CLAUDE.md and
the docs it references *are* wanted.

`--safe-mode` is the exact lever. Per the installed CLI's help: it starts with *"all customizations
(CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents, … ) disabled"* while
*"Auth, model selection, built-in tools, and permissions work normally."* So it firewalls everything
**and keeps keychain auth** (no API key needed). The lighter alternative — `--setting-sources project`
+ `--strict-mcp-config` — still admits *project-level* hooks and the *global* CLAUDE.md, so it fails
the requirement.

Because safe-mode also drops CLAUDE.md auto-discovery, the backend **injects the repo's CLAUDE.md/docs
itself** (read from the worktree, `@import` directives resolved, size-bounded). This is strictly better
than auto-discovery: the model's entire input becomes `our system prompt + repo CLAUDE.md/docs + the
bounded diff` — 100% controlled, auditable, and hashable for cache invalidation.

### Why a bounded diff with no tools (not agentic file access)

A walkthrough is orientation, not a deep audit. Feeding a bounded unified diff with zero tools makes the
run deterministic, cost/latency-bounded, and immune to tool-loop failure modes — and project knowledge
still arrives via the injected CLAUDE.md. Read-only file access (Read/Grep so the model can pull
surrounding code) is a clean **v2** upgrade once v1 is proven; the `degraded` flag already models the
large-diff path.

### Why extend `Review`, not a sidecar file

The cached walkthrough is derived review state. Extending the `Review` struct with an optional field
rides the existing atomic `<id>.json` save/load, keeps a single source of truth, and fits the
`Review`-passing the frontend already does (`refreshReview`/`saveReview`). Old files load with the field
absent via `#[serde(default)]`; bump `Review.version`. A sidecar (`<id>.walkthrough.json`) is the
alternative if the walkthrough later needs to decouple from the review lifecycle (e.g. the comments-MCP
sidecar roadmap) — not needed now.

## Architecture & data flow

```
generate_walkthrough(target)                       [commands.rs → walkthrough module]
  1. resolve worktree + compute git2 diff; refuse if below the min-diff floor (UI pre-gates this)
  2. assemble controlled context:
       a. unified patch text, capped at BUDGET bytes  → else file-list+stats, degraded=true
       b. repo CLAUDE.md (+ resolved @imports), capped
  3. compute canonical diffSig (base/head oids + file digest + context hash)
  4. resolve the review for this target (same target→id mapping as open_review);
     if its cached walkthrough has a matching diffSig → return it (no spawn)
  5. spawn `claude -p --safe-mode --output-format json --model … --append-system-prompt <contract>
            --disallowedTools <all>`  with the context on stdin; register child under review id
  6. on exit: parse envelope → extract `result` → extract+serde-validate JSON
       parse/validate failure → ONE repair retry (re-prompt with the error)
       second failure / non-zero exit / timeout → typed error
  7. persist {walkthrough, diffSig, generatedAt} onto the Review; return Walkthrough
```

The frontend flow is unchanged ([Workspace.tsx](../../../src/workspace/Workspace.tsx) `startWalkthrough`):
button → confirm dialog → `api.generateWalkthrough(target)` → loading → render. New: the button is
additionally gated by `claude_status`, and errors are dismissable.

## Components

### 1. `walkthrough` module (Rust) — `src-tauri/src/walkthrough/`

New module owning orchestration, kept off `commands.rs`. Submodules:

- **`context.rs`** — diff assembly + repo-CLAUDE.md/docs assembly (see §2, §3), and the canonical
  `diffSig`.
- **`claude.rs`** — build the argv + spawn (§4), child registry for cancellation (§ Cancellation),
  envelope + JSON extraction, validate + repair against the schema (§5) and the quality invariants (§5b).
- **`model.rs`** — the Rust `Walkthrough` structs mirroring [types.ts](../../../src/types.ts) (serde,
  `camelCase`), plus `CachedWalkthrough { walkthrough, diff_sig, generated_at }` and `ClaudeStatus`.

### 2. Diff assembly + large-diff degradation

Reuse the `compute_diff` path to get the `git2::Diff`, then emit unified patch text
(`Diff::print` / `Patch::from_diff` → buffer). Cap at a byte budget (`WALKTHROUGH_DIFF_BUDGET`, e.g.
~256 KB ≈ a safe token margin). **Over budget:** drop the patch bodies and pass `name-status` +
per-file `additions/deletions` (already in `DiffSummary`) instead, and set `degraded: true` so the panel
shows the "summarized from structure" affordance. Binary/oversized single files are listed but their
bodies omitted regardless.

### 3. Controlled-context assembly (repo CLAUDE.md/docs)

Read the worktree-root `CLAUDE.md` (if present). Resolve `@relative/path` import directives it
contains, bounded to a shallow depth and a total size cap, never escaping the repo root. The result is a
single context block labeled as the project's guidance. The user-global `~/.claude/CLAUDE.md` is
**intentionally excluded** (safe-mode + we never read it). Absent CLAUDE.md → empty block, fine.

### 4. `claude` invocation (the isolation recipe)

`std::process::Command::new(claude_path)` with:

```
-p
--safe-mode                       # firewall: no hooks/MCP/skills/plugins/global+project CLAUDE.md
--output-format json              # envelope with a `result` text field
--model <alias>                   # default a fast, capable alias (sonnet-class); configurable
--append-system-prompt <CONTRACT> # schema + "ignore workflow/commit/test instructions; output ONLY the JSON"
--disallowedTools <all builtin>   # pure text → JSON, no tool use
```

Controlled context (repo CLAUDE.md/docs block + the bounded diff + the user-turn instruction) is written
to the child's **stdin** (`--input-format text`, the default). A wall-clock **timeout** kills the child.
`--strict-mcp-config` is redundant under safe-mode; `--exclude-dynamic-system-prompt-sections` is optional
extra hardening to strip per-machine env/git noise. Auth is left untouched (keychain/OAuth) so the run
bills the user's Claude plan; the design must **not** set `ANTHROPIC_API_KEY`.

Exact flag spellings validated against `claude` 2.1.193; pin a minimum-version note since `--safe-mode`
is the load-bearing flag.

### 5. Structured-output contract + validation

`--output-format json` only wraps the textual result — it does not constrain the model's content, and
the CLI has no final-answer schema enforcement. So: the `--append-system-prompt` states the **exact
`Walkthrough` JSON schema** (from [types.ts](../../../src/types.ts)) and instructs *output only that
object*. Pipeline: parse the envelope → take `result` → extract the JSON object (tolerate stray prose /
code fences by slicing the outer `{…}`) → `serde_json::from_str` into the Rust `Walkthrough`. On parse or
validation failure, **one repair retry** re-prompts with the parser error appended. Second failure →
`WalkthroughError::Unparseable`. Post-validate: clamp/sort `group.order`, drop `files`/`risks` whose
paths aren't in the diff (model hallucination guard).

### 5b. Output-quality rubric + invariants

The walkthrough must read as a thoughtful, unbiased orientation — never padded, never a critique. Two
layers enforce this: prompt guidance (qualitative) and machine-checked invariants that feed the **same
repair loop** (quantitative). The min-diff gate (§ Min-diff gate / data-flow step 1) guarantees there is
always enough material for these rules to hold without forcing an artificial split.

**Prompt rubric** (encoded in `--append-system-prompt`):

- **Orientation, not judgment** — describe what changed and where attention belongs; no praise, blame, or
  editorializing. Risks are attention flags (`watch`/`caution`) phrased as "look here because…", never
  verdicts on code quality (mirrors the existing type-doc intent).
- **Right granularity** — group by genuine concern. **Never a single group; never fragmented.** Aim for
  2–5 groups on a typical change; a group holds a coherent unit of work, not one file each by default.
- **Calibrated length** — `title` 3–8 words (PR-style, specific — not a filename list); `summary` 1–3
  sentences. Group `title` 2–6 words; group `summary` 1–2 sentences. File `note` ≤ ~8 words; risk `note`
  one sentence. No empty strings, no walls of text.
- **Balanced importance** — don't mark everything `core` or everything `skim`; reflect real signal.
- **Honest coverage** — every changed non-ignored file appears in exactly one group; `ignored` holds only
  genuine noise (lockfiles, generated, binary) with a real reason.

**Machine-checked invariants** (validated after parse; a violation is appended to the repair-retry
prompt, then hard-fails as `WalkthroughError::QualityViolation` on the second miss):

- `2 ≤ groups.length ≤ MAX_GROUPS` (default 7) — kills the one-step and the over-fragmented cases.
- Every non-ignored diff file is covered exactly once across groups; none duplicated; no group empty.
- No group/file/risk path is absent from the diff (the hallucination guard).
- Title/summary/note lengths within the ranges above (trailing whitespace trimmed; out-of-range → repair
  feedback rather than silent truncation).
- `order` is a `1..N` permutation (clamp/sort).
- Not every group is `skim` (avoid an all-noise walkthrough).

Bounds (`MAX_GROUPS`, the length ranges) are named constants, tunable without touching logic.

### 6. Commands (register in `lib.rs`)

- **`generate_walkthrough(target) -> Walkthrough`** — the orchestration above. **New handler**, and must
  be **added to `generate_handler!`** (currently absent).
- **`claude_status() -> ClaudeStatus { installed, path }`** — resolve `claude` on PATH (mirror the
  editor-presence check). Lean: presence + path only; auth/usage failures surface at generation time.
- **`cancel_walkthrough(reviewId)`** — kill the in-flight child for that review if any.

All three mirrored in [api.ts](../../../src/api.ts) and [mockBackend.ts](../../../src/dev/mockBackend.ts)
(three-layer rule). The mock keeps its canned/large behavior; `claude_status` mock returns
`installed: true`; `cancel_walkthrough` is a no-op there.

### 7. Persistence + staleness signature

Extend `Review` with `walkthrough: Option<CachedWalkthrough>` (`#[serde(default)]`, version bump),
mirrored as `Review.walkthrough?: CachedWalkthrough | null` in [types.ts](../../../src/types.ts). The
**canonical `diffSig`** is computed backend-side from `baseOid + headOid + digest(sorted file
path:status:+adds:-dels) + hash(injected CLAUDE.md context)`; returned with the walkthrough and persisted.
Staleness = live `diffSig` ≠ cached. The frontend's existing `guideGenSig`/`guideDiffSigRef` are
reconciled to this backend signature so there is one definition. `save_review`/`refresh_review` carry the
field for free. `generate_walkthrough` reaches the review by resolving the target to its review id
exactly as `open_review` does, so caching needs no extra argument; that same resolved id keys the
cancellation registry and is the id the frontend already holds (from `openReview`) to pass to
`cancel_walkthrough`.

### 8. Frontend wiring

- **`generateWalkthrough`** — unchanged call site; now hits the real backend in app builds.
- **Button gating** — on mount/open, call `claude_status`; if not installed, the Walkthrough affordance
  is disabled with a tooltip/notice ("Claude Code CLI not found") instead of failing on click. Joins the
  existing `dirty`/mode gates.
- **Min-diff gate** — `requestWalkthrough` blocks trivially small diffs *before* spawning: if total
  changed lines across non-ignored files `< GUIDE_MIN_CHANGED_LINES` (default 20), show a `NoticeDialog`
  via the existing `guideBlockedMsg` path explaining a walkthrough isn't useful for a change this small.
  All inputs are already in `DiffSummary`, so this is a cheap client-side check — no spawn, no credits.
  The backend keeps a defensive floor (data-flow step 1) for direct callers. Threshold is a named
  constant, tunable.
- **Dismissable error strip** — the offending non-dismissable strips are
  [Workspace.tsx](../../../src/workspace/Workspace.tsx) (`{error && <div…>{error}</div>}`) and
  [GuideWorkspace.tsx](../../../src/guide/GuideWorkspace.tsx). Add a **× dismiss** that clears the error,
  and auto-clear on the next generation/action. Factor a tiny shared `ErrorStrip { message, onDismiss }`
  so the fix applies to both (and is reusable). Scope-limited to these strips; the `NoticeDialog` path
  (`guideBlockedMsg`) is already dismissable.
- **Cancellation calls** — `exitGuide`, window unload, and regenerate call `api.cancelWalkthrough(reviewId)`.

## Error handling taxonomy

| Failure | Detection | Surfaced as |
|---|---|---|
| `claude` not on PATH | `claude_status` pre-flight | Button disabled + "Claude Code CLI not found." |
| Not authenticated / usage limit | non-zero exit / `is_error`, stderr | Claude's own message ("Run `claude login`" / limit) in the dismissable strip |
| Timeout | child exceeds budget → killed | "Walkthrough timed out." |
| Non-zero exit (other) | exit status | stderr tail in the strip |
| Unparseable / quality-violation after repair retry | schema or invariant (§5b) check | "Couldn't build a good walkthrough — try again." |
| Diff too small | min-diff gate (client) / floor (backend) | `NoticeDialog` popup; not an error strip |
| Cancelled | killed via `cancel_walkthrough` | silent (no error; user-initiated) |

Errors are typed in Rust (`WalkthroughError`) and stringified at the IPC boundary into the existing
`error` channel. Cancellation is distinguishable from failure so it does not flash an error.

## Cancellation

A process registry — `Mutex<HashMap<ReviewId, Child>>` in app state — holds at most one in-flight child
per review. `generate_walkthrough` inserts on spawn and removes on completion; a superseding generation
for the same review kills the prior child first. `cancel_walkthrough(reviewId)` kills and removes. The
frontend cancels on guide-mode exit, window close, and regenerate. Killing the child stops credit spend
promptly.

## Testing

- **Rust unit tests** (`cargo test`): JSON extraction from a noisy `result` (fences/prose); serde
  validation of a good `Walkthrough`; repair-retry path (first bad, second good); hallucinated-path
  pruning; degradation threshold (patch vs name-status, `degraded` flag); `diffSig` stability +
  sensitivity (file change flips it, CLAUDE.md change flips it); `@import` resolution bounds (depth/size,
  no repo-escape). The `claude` spawn is abstracted behind a small trait so tests inject a fake
  transcript instead of shelling out.
- **Quality invariants** (`cargo test`): a one-group output is rejected and routed to repair; `> MAX_GROUPS`
  rejected; an empty/duplicate group or an uncovered diff file rejected; out-of-range title/summary lengths
  trigger repair feedback; an all-`skim` walkthrough rejected; a valid output passes untouched. A
  second-miss violation surfaces as `QualityViolation`, not a silent pass.
- **Min-diff gate**: a sub-threshold `DiffSummary` makes `requestWalkthrough` show the notice and never
  call `generateWalkthrough`; at/above threshold proceeds. Backend floor rejects a sub-threshold target.
- **Mock backend** keeps serving fixtures so `pnpm dev:mock` and existing UI tests are unaffected; add
  `claude_status`/`cancel_walkthrough` stubs.
- **Frontend tests** (Vitest): error strip dismissal clears the message; button is gated/disabled when
  `claude_status.installed` is false.
- **Manual (real app)**: `pnpm dev:app`, generate on a real clean branch; verify isolation by adding a
  noisy global hook/MCP and confirming it does not affect output; verify cancel kills the process
  (no lingering `claude`).

## Surface-area checklist (three-layer rule)

- `src-tauri/src/walkthrough/` (new module), `commands.rs` (3 commands), `lib.rs` (register incl. the
  previously-absent `generate_walkthrough`), `review/model.rs` (+`walkthrough` field, version bump),
  `capabilities/default.json` if a new permission is needed.
- `src/api.ts` (+`claudeStatus`, `cancelWalkthrough`; `generateWalkthrough` unchanged).
- `src/dev/mockBackend.ts` (stubs for the two new commands; existing walkthrough mock retained).
- `src/types.ts` (`CachedWalkthrough`, `ClaudeStatus`, `Review.walkthrough`).
- UI: shared `ErrorStrip`, button gating, min-diff gate (`GUIDE_MIN_CHANGED_LINES` + notice), cancellation calls.

## Non-goals / future

- **v2 agentic-lite** — read-only file access for richer large-diff handling.
- **Streaming** — the data model is a single `Walkthrough`; `--output-format stream-json` for
  incremental group reveal is deferred.
- **Line-level risk jump** — `onJump` is file-level today (already noted in `GuideWorkspace`); the
  `risk.line` plumbing is out of scope here.
- **Cross-platform** `claude` discovery beyond the app's current macOS focus.
