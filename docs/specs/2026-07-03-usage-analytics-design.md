# Usage analytics for Delta — design

- **Date:** 2026-07-03
- **Status:** proposed
- **Scope:** answer "how many people install/use Delta, and what do they do with
  it" via GitHub download counts (reach) plus privacy-first, anonymous in-app
  analytics through Aptabase (active users + feature usage). No consent wall.

## Context

Delta ships today with **no telemetry**: the Rust deps are only `serde`/`serde_json`
(no HTTP client), the updater points at a static GitHub `latest.json` (no
server-side signal), and there is no analytics code. So there is currently no way
to know how many people run the app or which features they use.

Delta is a **developer tool for reviewing git diffs** — an audience that inspects
binaries and proxies network traffic, and that is unusually sensitive to telemetry.
Two consequences drive this design:

1. Analytics must be **anonymous by construction** and must **never** capture
   content — no repo names, file paths, branch names, diff text, or comment text.
2. Undisclosed phone-home is a reputational risk regardless of how clean the data
   is. Disclosure + an off-switch are cheap insurance.

## Decisions (settled)

- **Scope = reach counts + a small set of privacy-safe feature events.** Not full
  product analytics (funnels/session replay/cohorts).
- **Collection = Aptabase** (`tauri-plugin-aptabase` + `@aptabase/tauri`).
  Open-source, desktop-native, privacy-first: no PII, no cookies, no device
  identifiers, no fingerprinting. Its only quasi-identifier is a **server-side hash
  of IP + a per-app salt that rotates every 24h** — never written to the user's
  disk. Aptabase advertises GDPR/CCPA/PECR compliance and **no consent requirement**
  (anonymized data, GDPR Recital 26). Managed **EU** data residency (maintainer is
  EU-based); self-host remains an option later with no code change.
- **Consent = transparent, no prompt.** Collect by default, no first-run wall.
  Disclose in the README and in a short Settings line; provide a Settings toggle and
  honor `DELTA_TELEMETRY=0` and the community `DO_NOT_TRACK=1` standard. (Not legally
  required given anonymized data — this is trust insurance for a dev audience.)
- **Install counts come from the GitHub Releases API**, not Aptabase. A committed
  `scripts/install-stats.sh` sums `assets[].download_count`.
- **No telemetry in debug builds.** Gated so `pnpm tauri dev`, `pnpm dev:app`
  (`Delta Dev`), and `pnpm dev:mock` never touch production analytics.

## Goals

- Know **cumulative reach** (downloads/installs) per release, on demand.
- Know **active users** (daily/monthly) and the **version/OS mix** — the latter two
  come free from Aptabase's auto-enrichment.
- Know **which features get used**, especially the core "Copy for agents" action.
- A user can turn it off (Settings toggle or env var); it is disclosed.
- Zero backend to build or run; no measurable startup or runtime cost.

## Non-goals (deferred)

- Funnels, retention cohorts, session replay, per-user journeys.
- Any content-bearing or identifying data.
- Self-hosting the Aptabase server (start on managed cloud; revisit if it grows).
- An update/heartbeat ping of our own — Aptabase's active-user metric already
  answers "how many are live," so a separate ping is redundant.
- Crash/error reporting (Sentry etc.) — a reasonable follow-up, but out of scope.

## Two data sources, two questions

The question is really two questions with different answers. Don't force one tool
to do both.

| Question | Source | Cost |
|---|---|---|
| How many installed it (cumulative reach) | GitHub Releases API — `assets[].download_count`, summed. Brew-cask installs included (brew pulls the DMG from the release). | `scripts/install-stats.sh` |
| How many actively use it (DAU/MAU) | Aptabase active users | free with plugin |
| Which versions / OSes are live | Aptabase auto-enrichment | free with plugin |
| What they do | Aptabase events | the main work |

**Caveats to record so the numbers aren't over-read:**

- The tap is a *personal* Homebrew tap, so it is **not** in Homebrew's official
  `brew install` analytics (that covers homebrew-core only). GitHub download count is
  the brew proxy.
- `download_count` is an **upper bound** on installs — re-downloads, `brew reinstall`,
  and CI inflate it. Aptabase active-users is the truer "real people" number.
- Aptabase's user identity rotates every 24h, so its "users" is **daily/monthly
  uniques**, not lifetime installs. Lifetime reach only comes from download counts.

## Architecture

`tauri-plugin-aptabase` (Rust crate) + `@aptabase/tauri` (JS package). Three touch
points; a single gate governs whether anything is sent.

### Rust — `src-tauri/src/lib.rs`

- Register the plugin in the builder, next to the other `.plugin(...)` calls:

  ```rust
  #[cfg(not(debug_assertions))]
  {
      builder = builder.plugin(
          tauri_plugin_aptabase::Builder::new(dotenv!("APTABASE_KEY")).build(),
      );
  }
  ```

  Compiled out of debug builds entirely, so dev/mock never sends. Registration is
  inert (no network until an event is tracked).
- **Env opt-out** is read once at startup (`DO_NOT_TRACK`, `DELTA_TELEMETRY`) and
  surfaced to the frontend via a command (below). When env-disabled, the frontend
  gate is off and nothing is tracked.
- `app_started` is **not** fired from Rust `setup()` (it runs before the webview can
  read the user toggle). It is fired frontend-side so one gate covers every event
  (see below). Optionally keep `flush_events_blocking()` on the macOS `ExitRequested`
  arm of the run loop to flush the final batch on quit; the plugin also flushes
  periodically, so this is a nice-to-have, not required.

### Command — env/build permission

Add one command that reports whether telemetry is permitted by *build + env* (i.e.
release build, key present, not `DO_NOT_TRACK`/`DELTA_TELEMETRY=0`). Per the repo's
three-layer rule this lands in **all three** layers:

- `src-tauri/src/commands.rs` — `telemetry_allowed() -> bool`
- `src/api.ts` — `telemetryAllowed(): Promise<boolean>`
- `src/dev/mockBackend.ts` — returns `false` (mock/browser mode is never live)

The user toggle stays purely frontend (localStorage); this command only reports the
things the frontend can't see (compile flag + process env).

### Frontend — `src/analytics.ts` (new)

A thin wrapper that is the **only** place event names live and the **only** gate:

- `track(event: EventName, props?)` — no-ops unless **all** hold: running in a real
  Tauri webview (not `dev:mock`/tests), `telemetryAllowed()` is true, and the user
  toggle is not "off". The underlying `trackEvent` is wrapped in `try/catch` so
  analytics can never break the app.
- `EventName` is a string-literal union — the fixed taxonomy below, no free-form
  names.
- A telemetry-preference store mirroring `src/theme.ts` exactly: module-level store,
  `localStorage["delta.telemetry"]` (`"on"` default | `"off"`), a `storage` listener
  so toggling in one window propagates to others, and a `useTelemetryPref()` hook for
  the Settings UI.
- Fires `track("app_started")` once on app mount (after first paint), so sessions,
  active users, and version/OS all flow through the single gate.

### Not-in-Tauri detection

`@aptabase/tauri`'s `trackEvent` calls the plugin over IPC directly (not through
`api.ts`), so in `pnpm dev:mock` (plain browser, `VITE_MOCK_IPC`) it would throw.
The wrapper must short-circuit when not in a Tauri webview — reuse the same signal
`main.tsx` uses to pick the mock transport (the `VITE_MOCK_IPC` flag /
`"__TAURI_INTERNALS__" in window`).

## Event taxonomy

**Rule: feature names and bucketed counts only — never content.** No repo names,
paths, branch names, diff text, or comment text.

| Event | Properties | Why |
|---|---|---|
| `app_started` | — (Aptabase adds OS, OS version, app version, locale) | sessions, active users, version/OS mix, retention |
| `review_opened` | `{ file_count_bucket: "1-9" \| "10-49" \| "50+" }` | how much Delta is used, and on what size of change (bucketed, never exact) |
| `copy_for_agents` | `{ comment_count: number }` | **north-star** — proves people use Delta for its actual purpose |
| `comment_added` | — | core interaction volume |
| `comment_resolved` | — | is the resolved-comments feature used |
| `diff_layout_changed` | `{ layout: "unified" \| "split" }` | which layout people prefer |
| `find_used` | — | is in-diff find used |
| `cli_installed` | — | CLI adoption |
| `update_applied` | — | upgrade cadence / are people on current versions |

Aptabase **auto-attaches** OS, OS version, app version, and locale to every event —
so version/OS breakdowns and "did people upgrade" need no extra code.

Dropped during design (low signal for the noise): `markdown_preview_toggled`,
`file_wrap_toggled`.

## Privacy & opt-out

- **On by default, no first-run prompt** (per the settled consent decision).
- **Off-switch, three ways:** a Settings toggle (`localStorage["delta.telemetry"]`);
  `DELTA_TELEMETRY=0`; and `DO_NOT_TRACK=1`. Env vars are read in Rust at startup and
  win over the toggle.
- **Disclosure:** one line in the README's relevant section, and a short line in
  Settings beside the toggle — what's collected (anonymous feature usage, no content)
  and how to turn it off. Link the Aptabase privacy page.
- **Data residency:** EU.

## App key handling

The Aptabase app key is a **write-only ingestion key**, not a secret — it ships in
every distributed binary and is extractable with `strings` regardless. To avoid
inviting casual abuse of the project from the *public source*, load it at build time
from a gitignored `.env` via `dotenvy_macro` (`dotenv!("APTABASE_KEY")`), rather than
hardcoding it. Release builds are produced locally on the maintainer's Mac (per the
distribution setup), so `.env` lives there alongside the Apple credentials.

## Install-count script — `scripts/install-stats.sh`

Small, committed, dependency-light (`gh` + `jq`):

- Query `gh api repos/darioielardi/delta/releases`.
- Print per-release total (`tag_name`, summed `assets[].download_count`) and a grand
  total across releases.
- Pure read; no auth beyond the maintainer's existing `gh`.

## Tests / validation

- **Wrapper is inert off-Tauri:** unit test that `track()` is a no-op (no throw, no
  invoke) when the not-in-Tauri signal is set — so `dev:mock` and Vitest never emit.
- **Toggle gates events:** with the toggle "off", `track()` does nothing even when
  `telemetryAllowed()` is true; flipping it re-enables. Mirror the `theme.ts` store
  tests if present.
- **Env opt-out:** `telemetry_allowed()` returns false under `DO_NOT_TRACK=1` and
  `DELTA_TELEMETRY=0` (Rust unit test).
- **Debug build sends nothing:** the plugin is `#[cfg(not(debug_assertions))]`, so a
  debug `cargo test`/`tauri dev` has no Aptabase plugin registered.
- **Three-layer parity:** `telemetry_allowed` exists in `commands.rs`, `api.ts`, and
  `mockBackend.ts` (mock returns false), matching the repo rule.
- **Type/lint gates:** `npx tsc --noEmit` and `pnpm test` pass; `cargo test` in
  `src-tauri/` passes.
- **Manual, real app:** build a release locally, launch, confirm events land in the
  Aptabase dashboard; toggle off in Settings and confirm they stop.

## Effort

Roughly half a day. No backend to build or run. Breakdown: add deps + register
plugin (~30m); `analytics.ts` wrapper + telemetry-pref store (~1–2h); the
`telemetry_allowed` command across three layers (~30m); ~9 `trackEvent` call sites
(~1–2h); Settings toggle UI + README/Settings disclosure (~1h); `install-stats.sh`
(~20m); tests (~1h).
