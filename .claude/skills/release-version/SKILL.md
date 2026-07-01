---
name: release-version
description: >
  Use when cutting a new release of the delta desktop app — building a signed,
  notarized macOS DMG and publishing it (git tag, GitHub release, Homebrew cask
  bump). Triggers: "release a patch/minor/major version", "publish a new
  version", "cut a release", "ship vX.Y.Z". macOS-only.
license: MIT
---

# Release a new version

Two dedicated scripts do everything. `build-release-dmg.sh` produces a signed,
notarized, stapled DMG and bumps `package.json` (uncommitted). `publish-release.sh`
commits the bump, tags, pushes, creates the GitHub release, and bumps the Homebrew
cask. Build first, then publish.

## Preconditions (all required — the scripts hard-fail otherwise)

- **Run from the main worktree**, on `main`, pulled and clean:
  `cd /Users/dario.ielardi/projects/delta && git checkout main && git pull --ff-only`.
  Do NOT run from a `.claude/worktrees/*` worktree. `build-release-dmg.sh` aborts
  if the tree is dirty (untracked files count too).
- **Source `~/.zshrc` in the same command.** The Apple credentials
  (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`, `APPLE_SIGNING_IDENTITY`)
  live in `~/.zshrc`, which is only loaded for *interactive* shells. A non-interactive
  agent/tool shell does NOT source it, so the vars read as unset and the build dies at
  `require_notary_auth`. Every release command below is prefixed with `source ~/.zshrc &&`.
  Env does not persist between separate shell calls — re-source each time.
- macOS with `cargo`, `xcrun`, `spctl`, `shasum`, `gh` on PATH (all present on this machine).

## Procedure

Both steps are long (Rust release compile + Apple notarization over the network) and
can exceed a 10-minute foreground timeout, so **run each in the background** — the Bash
tool's background mode, or `… > /tmp/release.log 2>&1 &` — and read the log on completion.
The concrete version (e.g. `0.11.1`) is chosen by step 1 and printed at the end; `publish`
reads it from `package.json` itself, so you only need it for the verify command. Artifacts
are Apple-Silicon only: `Delta_X.Y.Z_aarch64.dmg`.

**0. Prep** (from Preconditions): `cd /Users/dario.ielardi/projects/delta && git checkout main && git pull --ff-only`, tree clean.

**1. Build** — pick one bump: `--patch` | `--minor` | `--major` | `--version X.Y.Z`

```bash
source ~/.zshrc && cd /Users/dario.ielardi/projects/delta && \
  scripts/build-release-dmg.sh --patch
```

Runs `tsc --noEmit`, `pnpm test`, `cargo test`, then bumps `package.json`, builds +
signs + notarizes + staples + verifies the DMG. On success it prints the version,
DMG path, and SHA-256, and leaves the version bump **uncommitted** so you can test the
DMG locally first. On any failure it reverts the bump (keeps the tree clean for a retry).

> The `Warn skipping app notarization, no APPLE_ID … or APPLE_API_KEY …` line during
> `tauri build` is **intentional, not an error**: the script strips notary creds for the
> bundle step (`env -u …`) and notarizes the *DMG* exactly once, explicitly, afterward.
> Confirm you see `status: Accepted`, `The staple and validate action worked!`, and
> `accepted / source=Notarized Developer ID`.

**2. Publish** — publishes the DMG for whatever version `package.json` currently holds

```bash
source ~/.zshrc && cd /Users/dario.ielardi/projects/delta && \
  scripts/publish-release.sh
```

Re-verifies the DMG, commits the bump as `chore(release): vX.Y.Z`, tags `vX.Y.Z`,
pushes `HEAD` + tag, creates the GitHub release with the DMG attached, and bumps the
Homebrew cask in `darioielardi/homebrew-tap` (via `update-cask.sh`). Flags: `--skip-cask`
to skip the cask bump, `--remote <name>` for a non-`origin` remote.

The `pnpm` aliases `build:release-dmg` / `publish:release` map to these scripts, but
calling the scripts directly makes flag forwarding unambiguous.

## Verify when done

```bash
cd /Users/dario.ielardi/projects/delta && git status --porcelain && git log --oneline -1 && \
  gh release view vX.Y.Z --json tagName,url,assets --jq '{tag:.tagName, url:.url, assets:[.assets[].name]}'
```

Expect: clean worktree, HEAD = `chore(release): vX.Y.Z`, release live with the
`Delta_X.Y.Z_aarch64.dmg` asset, and "Bumped darioielardi/homebrew-tap to version X.Y.Z"
in the publish log.

## Common mistakes

| Mistake | Consequence / fix |
|---|---|
| Running without `source ~/.zshrc` | Build dies: "notarization credentials are missing". Prefix every command. |
| Treating the app-bundle notarization warning as a failure | It's intentional — the DMG gets notarized separately. Check for `status: Accepted`. |
| Running from a `.claude/worktrees/*` worktree | Wrong tree / dirty-tree abort. Always `cd` to the main worktree on `main`. |
| Foreground run hits the tool timeout | The build/notarize can exceed 10 min. Run in the background and read the log. |
| Re-running publish after a mid-publish failure | The `vX.Y.Z` tag guard blocks it. Inspect/delete the partial tag before retrying. |
| Editing files other than `package.json` before publish | `publish-release.sh` refuses ("only package.json may be changed"). Commit or stash unrelated changes first. |
