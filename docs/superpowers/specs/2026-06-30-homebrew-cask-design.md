# Homebrew cask for Delta — design

- **Date:** 2026-06-30
- **Status:** proposed
- **Scope:** distribute the macOS app via a personal Homebrew tap, with the cask
  bump wired into the existing release flow.

## Context

Delta ships as a signed, notarized, stapled **DMG**. The release flow is local
(run on the maintainer's Mac with Apple credentials), in two scripts:

- `scripts/build-release-dmg.sh` — bumps the version, builds, signs, notarizes,
  staples, and prints the SHA-256. Produces `Delta_<version>_aarch64.dmg`.
- `scripts/publish-release.sh` — tags `v<version>`, pushes, and
  `gh release create`s the GitHub release with the DMG attached.

There is **no Tauri/Sparkle updater** (no `tauri-plugin-updater`, no `.sig`
artifacts). Today users download the DMG from the releases page by hand; the
README says "brew coming soon!".

The `delta` CLI is **app-managed**: the app symlinks its own binary onto PATH
and wires shell rc files via an in-app installer (`launch/mod.rs`, `CLI_NAME`,
`RC_MARKER`). This is a deliberate UX affordance, not something Homebrew should
take over.

This spec adds a Homebrew **cask** so `brew install --cask darioielardi/tap/delta`
works, and keeps it current automatically on each release.

## Decisions (settled)

- **Tap:** `darioielardi/tap` (repo `darioielardi/homebrew-tap`). Generic name so
  the one-liner reads `darioielardi/tap/delta` (no `delta/delta` repetition) and
  the tap can hold future tools.
- **Architecture:** **arm64 only.** The release already builds a single host-arch
  (aarch64) DMG; no universal/Intel build. Intel users get a clean cask error.
- **CLI:** stays **app-managed**. The cask installs only `Delta.app` — no `binary`
  stanza, no PATH symlink. Avoids the `git-delta` collision, preserves the
  in-app discovery moment, and the cask can't replicate the shell-rc wiring anyway.
- **Automation:** **extend `publish-release.sh`** to bump the cask, via a new
  standalone `scripts/update-cask.sh` helper.

## Goals

- `brew install --cask darioielardi/tap/delta` installs the current release.
- `brew upgrade --cask delta` updates it; `brew uninstall --zap delta` removes app
  data. A `livecheck` lets brew detect new releases.
- Each `publish-release.sh` run bumps the cask in the tap with no manual step.
- The cask bump is also runnable standalone (to seed the first cask and to recover
  from a failed push).

## Non-goals (deferred)

- **Launch-time CLI acknowledgment prompt** — an app feature (surface the CLI on
  first launch so brew-installed users discover it without reading the README).
  Recommended as the immediate follow-up; **out of scope here**.
- Universal / Intel builds.
- A self-updater (Sparkle / Tauri updater) — brew owns upgrades.
- Submitting to the official `homebrew-cask` (notability bar); the personal tap
  stands on its own.
- `depends_on macos:` floor — omitted until we confirm the real minimum, rather
  than guess a version that wrongly blocks valid installs.

## The tap repo — `darioielardi/homebrew-tap`

Contents:

- `Casks/delta.rb` — the cask (below).
- `README.md` — install instructions.

The cask is **hand-maintained** in the tap; automation only rewrites its two
volatile lines (`version`, `sha256`). So manual edits (e.g. adding a `zap` path)
survive future bumps.

## The cask — `Casks/delta.rb`

```ruby
cask "delta" do
  version "0.3.0"
  sha256 "<sha256 of the published Delta_0.3.0_aarch64.dmg>"

  url "https://github.com/darioielardi/delta/releases/download/v#{version}/Delta_#{version}_aarch64.dmg"
  name "Delta"
  desc "Desktop app for reviewing git diffs with structured comments for AI agents"
  homepage "https://github.com/darioielardi/delta"

  depends_on arch: :arm64

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Delta.app"

  zap trash: [
    "~/Library/Application Support/com.darioielardi.delta",
    "~/Library/Caches/com.darioielardi.delta",
    "~/Library/Preferences/com.darioielardi.delta.plist",
    "~/Library/Saved Application State/com.darioielardi.delta.savedState",
    "~/Library/WebKit/com.darioielardi.delta",
    "~/Library/HTTPStorages/com.darioielardi.delta",
  ]
end
```

Notes:

- `url` is templated on `#{version}`; the `aarch64` token is fixed (arm64-only).
- No `auto_updates` — there is no in-app updater, so brew is the upgrade path.
- `depends_on arch: :arm64` turns an Intel install into a clear error instead of a
  broken app.
- `zap` paths cover the `com.darioielardi.delta` identifier (app support — which
  holds recents/reviews — caches, prefs, saved state, WebKit/HTTP storage). The
  app-installed **CLI symlink is intentionally not zapped** — it's app/user-owned.
- `desc` is kept < 80 chars and article-free to satisfy `brew audit` style.

## Release automation

### New `scripts/update-cask.sh`

Standalone, idempotent. Bumps the two volatile lines in the tap's `Casks/delta.rb`.

- **Inputs:** `--version X.Y.Z` and `--sha256 <hex>` (required). Optional
  `--dry-run` (render + diff, no commit/push) and `--tap-repo <owner/name>`
  (default `darioielardi/homebrew-tap`, overridable via `DELTA_TAP_REPO`).
- **Mechanism:** clone the tap to a temp dir (`gh repo clone` / authenticated
  https), regex-replace the single `version "…"` and single `sha256 "…"` lines in
  `Casks/delta.rb`, commit `chore(release): delta v<version>`, push, clean up.
- **Fail loudly:** abort if the cask file is missing, or if either line does not
  match **exactly once** (guards against silent drift if the cask structure
  changed). No-op-and-report if the values already match (idempotent re-runs).

### `publish-release.sh` change

After the release is live (`gh release create` has succeeded), call
`scripts/update-cask.sh --version "$version" --sha256 "$sha256"` unless `--skip-cask`
was passed.

- The `sha256` passed here is the one `publish-release.sh` already computes from
  `"$dmg_path"` — and since that exact file is what `gh release create` uploaded,
  the local hash equals the published asset's hash. No re-download in this path.
- The bump is the **final** step: the release already exists, so a tap-push failure
  must not unwind it. On failure, print a clear remediation
  (`re-run scripts/update-cask.sh --version <v> --sha256 <h>`) and exit non-zero so
  it's noticed; the published release stands.
- Add `--skip-cask` to the arg parser and usage text.

## Bootstrap (one-time)

1. Create the **public** GitHub repo `darioielardi/homebrew-tap` with a `Casks/`
   dir (`gh repo create darioielardi/homebrew-tap --public`). A private tap would
   force git auth on every user's `brew tap`.
2. Seed `Casks/delta.rb` for **v0.3.0** (already published). The sha256 **must come
   from the published asset**, not the local `target/` DMG — stapling rewrites the
   DMG post-notarization and the local copy may have been rebuilt since. Download
   the release asset and hash it:
   `gh release download v0.3.0 -p 'Delta_0.3.0_aarch64.dmg' -O - | shasum -a 256`
   (cross-check against the SHA-256 in the v0.3.0 release notes).
3. Commit the cask + tap README; push.
4. Verify: `brew tap darioielardi/tap && brew install --cask delta`, launch, then
   `brew uninstall --zap delta`.

Thereafter `publish-release.sh` maintains the cask automatically.

## README (main repo)

Replace the "brew coming soon!" line in the Installation section with:

```
brew install --cask darioielardi/tap/delta
```

Keep the manual DMG download from the releases page as the documented alternative.

## Tests / validation

- `brew style Casks/delta.rb` and `brew audit --cask --new Casks/delta.rb` (or the
  tapped `darioielardi/tap/delta`) pass.
- Real install round-trip: `brew install --cask darioielardi/tap/delta` →
  launches (Gatekeeper clean, since notarized) → `brew uninstall --zap delta`
  removes the app and the listed data paths.
- `scripts/update-cask.sh --version 0.3.0 --sha256 <hash> --dry-run` renders the
  expected two-line change and nothing else.
- `update-cask.sh` re-run with the same values is a no-op (idempotent); with a
  malformed cask it aborts with a clear error.
