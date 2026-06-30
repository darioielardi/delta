# Homebrew Cask for Delta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Delta to Homebrew via a personal tap, with the cask kept current automatically on each release.

**Architecture:** A public `darioielardi/homebrew-tap` repo holds a single DMG-based cask (`Casks/delta.rb`). The existing local release flow (`scripts/publish-release.sh`) gains a final step that bumps the cask's `version` + `sha256` via a new standalone `scripts/update-cask.sh`. The `delta` CLI stays app-managed — the cask installs only `Delta.app`.

**Tech Stack:** Homebrew cask (Ruby DSL), Bash, `gh` CLI, `git`, `perl` (in-place edit). Tauri DMG already built/signed/notarized by `scripts/build-release-dmg.sh`.

## Global Constraints

Every task implicitly includes these. Exact values, copied from the spec:

- **Tap (brew name):** `darioielardi/tap` → **repo** `darioielardi/homebrew-tap` (**public**). Local clone for bootstrap: `~/projects/homebrew-tap`.
- **Install command:** `brew install --cask darioielardi/tap/delta`.
- **Cask token:** `delta`. Installs `Delta.app`.
- **Architecture:** arm64 only. DMG asset name pattern: `Delta_<version>_aarch64.dmg`. Cask declares `depends_on arch: :arm64`.
- **App identifier:** `com.darioielardi.delta` (drives the `zap` paths).
- **Release tag pattern:** `v<version>`. Already published: `v0.3.0`.
- **No in-app updater** → the cask has **no** `auto_updates`; it uses `livecheck` with `strategy :github_latest`. Brew (`brew upgrade`) is the update path.
- **`desc`** must be < 80 chars with no leading article: `Desktop app for reviewing git diffs with structured comments for AI agents`.
- **sha256 source:** bootstrap (Task 1) hashes the **published** asset; the automated path (Task 4) reuses the hash `publish-release.sh` computes from the DMG it uploaded (same bytes).
- **Commits:** Conventional Commits. Every commit ends with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer (per harness). Commit commands below omit it for brevity — add it.
- Spec: [docs/superpowers/specs/2026-06-30-homebrew-cask-design.md](docs/superpowers/specs/2026-06-30-homebrew-cask-design.md).

**Note on "tests":** this work is shell scripts + a cask, and the repo has no shell test framework (adding one for one script is YAGNI). Verification is therefore command-based: `brew style`/`brew audit`, `bash -n` syntax checks, and `--dry-run` runs with asserted output. Each task still ends with an independently checkable deliverable.

---

## Implementation notes (deviations from this plan as written)

Captured after execution so the plan stays honest:

- **`depends_on macos: :big_sur` was added** (the plan/spec had deferred it). `brew
  style` requires a macOS floor for a macOS-only cask, and the app binary's Mach-O
  `minos` is 11.0 (the Info.plist's `LSMinimumSystemVersion` of 10.13 is Tauri's
  misleading default). The shipped cask in the tap is the source of truth.
- **Cask stanza order** follows `brew style --fix`: `livecheck` before `depends_on`,
  and the `zap` array alphabetized. Task 1's heredoc below shows a pre-lint form;
  `brew style` (Step 4) reconciles it.
- **Task 2 verification was made non-destructive.** This machine already had a real
  `/Applications/Delta.app` and real reviews under `~/Library/Application Support/
  com.darioielardi.delta`. Instead of `brew install` to `/Applications` + `brew
  uninstall --zap` (which would delete those reviews), the install was tested into a
  scratch `--appdir` and uninstalled **without** `--zap`. Never run the `--zap`
  round-trip on a machine holding real Delta data.

---

### Task 1: Author and style-validate the cask

Produces the validated cask + tap README in a local repo at `~/projects/homebrew-tap`, **without** creating the remote yet (Task 2 does that, gated on this passing).

**Files:**
- Create: `~/projects/homebrew-tap/Casks/delta.rb`
- Create: `~/projects/homebrew-tap/README.md`

**Interfaces:**
- Produces: a cask token `delta` at `darioielardi/tap/delta`, installing `Delta.app`, url `https://github.com/darioielardi/delta/releases/download/v#{version}/Delta_#{version}_aarch64.dmg`. Task 3's `update-cask.sh` relies on the cask having **exactly one** `version "…"` line and **exactly one** `sha256 "…"` line, each at the start of its line (after indentation).

- [ ] **Step 1: Download the published v0.3.0 asset and compute its sha256**

Run (from the delta repo root):

```bash
gh release download v0.3.0 -R darioielardi/delta -p 'Delta_0.3.0_aarch64.dmg' -O /tmp/delta-0.3.0.dmg --clobber
shasum -a 256 /tmp/delta-0.3.0.dmg
```

Expected: a 64-hex-char hash. Cross-check it against the `SHA-256` shown in the v0.3.0 release notes (`gh release view v0.3.0`); they must match.

- [ ] **Step 2: Generate the cask file (with the real hash)**

Run:

```bash
SHA="$(shasum -a 256 /tmp/delta-0.3.0.dmg | awk '{print $1}')"
mkdir -p ~/projects/homebrew-tap/Casks
cat > ~/projects/homebrew-tap/Casks/delta.rb <<EOF
cask "delta" do
  version "0.3.0"
  sha256 "$SHA"

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
EOF
```

Note: `<<EOF` is unquoted so `$SHA` is substituted; `#{version}` contains no `$`, so it stays literal for Ruby. Confirm the written file has the real hash, not the literal `$SHA`:

```bash
grep sha256 ~/projects/homebrew-tap/Casks/delta.rb
```

Expected: `  sha256 "<64-hex>"`.

- [ ] **Step 3: Write the tap README**

Run:

```bash
cat > ~/projects/homebrew-tap/README.md <<'EOF'
# darioielardi/homebrew-tap

Homebrew tap for [Delta](https://github.com/darioielardi/delta) and other tools.

## Install Delta

```sh
brew install --cask darioielardi/tap/delta
```

macOS, Apple Silicon (arm64) only.
EOF
```

- [ ] **Step 4: Style-check the cask**

Run:

```bash
brew style ~/projects/homebrew-tap/Casks/delta.rb
```

Expected: `1 file inspected, no offenses detected` (or similar clean output). If RuboCop reports offenses, fix them in the cask and re-run until clean. Do **not** proceed with offenses.

- [ ] **Step 5: Commit the local tap repo**

Run:

```bash
cd ~/projects/homebrew-tap
git init -q
git add -A
git commit -m "feat: add delta cask"
```

Expected: one commit on `main` (or `master` — note which; Task 2 pushes it).

---

### Task 2: Create the public tap and verify a live install

Creates the remote repo, pushes, and proves the cask installs and uninstalls cleanly. **This creates a public GitHub repo — confirm before running Step 1.**

**Files:** none in the delta repo (operates on `~/projects/homebrew-tap` and Homebrew state).

**Interfaces:**
- Consumes: the validated local tap from Task 1.
- Produces: a live tap installable as `darioielardi/tap/delta`. Task 3 clones this remote.

- [ ] **Step 1: Create the remote and push**

Run (from `~/projects/homebrew-tap`):

```bash
cd ~/projects/homebrew-tap
gh repo create darioielardi/homebrew-tap --public --source . --remote origin --push
```

Expected: repo created at `https://github.com/darioielardi/homebrew-tap` and the branch pushed. Verify:

```bash
gh repo view darioielardi/homebrew-tap --json visibility,defaultBranchRef --jq '.visibility, .defaultBranchRef.name'
```

Expected: `PUBLIC` and the branch name.

- [ ] **Step 2: Tap and audit against the live tap**

Run:

```bash
brew tap darioielardi/tap
brew audit --cask darioielardi/tap/delta
```

Expected: audit passes (it resolves the url, verifies the sha256 against the live asset, and checks the livecheck/token rules). If audit fails, fix the cask in `~/projects/homebrew-tap`, commit, `git push`, run `brew update`, and re-audit. (Use plain `brew audit --cask`, not `--new`; `--new` adds homebrew-cask-submission rules that don't apply to a personal tap.)

- [ ] **Step 3: Install round-trip**

Run:

```bash
brew install --cask darioielardi/tap/delta
ls -d /Applications/Delta.app
```

Expected: install succeeds with no Gatekeeper error (the DMG is notarized) and `Delta.app` is present. Optionally launch it once to confirm it opens.

- [ ] **Step 4: Uninstall + zap**

Run:

```bash
brew uninstall --zap --cask delta
ls -d /Applications/Delta.app 2>/dev/null || echo "app removed"
```

Expected: `app removed`. `--zap` also deletes any of the listed `~/Library/...com.darioielardi.delta*` paths that exist (none may exist if the app was never launched — that's fine). No commit (work is in the tap repo, already pushed).

---

### Task 3: Write `scripts/update-cask.sh`

A standalone, idempotent bumper for the two volatile cask lines. Lives in the delta repo.

**Files:**
- Create: `scripts/update-cask.sh`

**Interfaces:**
- Consumes: the live tap from Task 2 (clones it).
- Produces: CLI `scripts/update-cask.sh --version X.Y.Z --sha256 <64-hex> [--dry-run] [--tap-repo owner/name]`. Task 4 (`publish-release.sh`) calls it as `scripts/update-cask.sh --version "$version" --sha256 "$sha256"`.

- [ ] **Step 1: Write the script**

Create `scripts/update-cask.sh` with exactly:

```bash
#!/usr/bin/env bash
set -euo pipefail

TAP_REPO="${DELTA_TAP_REPO:-darioielardi/homebrew-tap}"
CASK_PATH="Casks/delta.rb"
version=""
sha256=""
dry_run=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/update-cask.sh --version X.Y.Z --sha256 <64-hex> [--dry-run] [--tap-repo owner/name]

Bumps the version + sha256 in the Homebrew cask in the tap repo and pushes.
Idempotent: a re-run with the current values is a no-op.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      shift; [ "$#" -gt 0 ] || die "--version requires X.Y.Z"; version="$1" ;;
    --sha256)
      shift; [ "$#" -gt 0 ] || die "--sha256 requires a hash"; sha256="$1" ;;
    --tap-repo)
      shift; [ "$#" -gt 0 ] || die "--tap-repo requires owner/name"; TAP_REPO="$1" ;;
    --dry-run)
      dry_run=1 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

require_cmd git
require_cmd gh
require_cmd perl

[ -n "$version" ] || die "--version X.Y.Z is required"
[ -n "$sha256" ] || die "--sha256 <64-hex> is required"
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "invalid --version: $version"
printf '%s' "$sha256" | grep -Eq '^[0-9a-f]{64}$' || die "invalid --sha256: $sha256"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

gh repo clone "$TAP_REPO" "$workdir/tap" -- --depth 1 --quiet || die "failed to clone $TAP_REPO"
cask="$workdir/tap/$CASK_PATH"
[ -f "$cask" ] || die "cask not found in tap: $CASK_PATH"

vcount="$(grep -Ec '^[[:space:]]*version "[^"]*"' "$cask" || true)"
scount="$(grep -Ec '^[[:space:]]*sha256 "[^"]*"' "$cask" || true)"
[ "$vcount" -eq 1 ] || die "expected exactly one version line in cask, found $vcount"
[ "$scount" -eq 1 ] || die "expected exactly one sha256 line in cask, found $scount"

CASK_VERSION="$version" perl -i -pe 's/^(\s*version )"[^"]*"/$1"$ENV{CASK_VERSION}"/' "$cask"
CASK_SHA="$sha256" perl -i -pe 's/^(\s*sha256 )"[^"]*"/$1"$ENV{CASK_SHA}"/' "$cask"

if git -C "$workdir/tap" diff --quiet; then
  printf 'cask already at version %s / sha256 %s; nothing to do.\n' "$version" "$sha256"
  exit 0
fi

if [ "$dry_run" -eq 1 ]; then
  printf 'Dry run — would commit:\n'
  git -C "$workdir/tap" --no-pager diff -- "$CASK_PATH"
  exit 0
fi

git -C "$workdir/tap" add "$CASK_PATH"
git -C "$workdir/tap" commit -q -m "chore(release): delta v$version"
git -C "$workdir/tap" push -q
printf 'Bumped %s to version %s.\n' "$TAP_REPO" "$version"
```

Then make it executable:

```bash
chmod +x scripts/update-cask.sh
```

- [ ] **Step 2: Syntax check**

Run:

```bash
bash -n scripts/update-cask.sh && echo "syntax ok"
```

Expected: `syntax ok`.

- [ ] **Step 3: Missing-args guard**

Run:

```bash
scripts/update-cask.sh; echo "exit=$?"
```

Expected: prints `error: --version X.Y.Z is required` to stderr and `exit=1`.

- [ ] **Step 4: Bad-sha guard**

Run:

```bash
scripts/update-cask.sh --version 0.3.0 --sha256 nope; echo "exit=$?"
```

Expected: `error: invalid --sha256: nope` and `exit=1`.

- [ ] **Step 5: Dry-run renders the two-line bump**

Run (uses a fake-but-well-formed version/sha so the diff is non-empty; clones the real tap read-only, never pushes):

```bash
scripts/update-cask.sh --version 9.9.9 \
  --sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --dry-run
```

Expected: `Dry run — would commit:` followed by a diff showing **only** the `version` line changing to `9.9.9` and the `sha256` line changing to the `aaaa…` value. Exit 0.

- [ ] **Step 6: Idempotency**

Run (substitute the real v0.3.0 hash from Task 1 Step 1):

```bash
scripts/update-cask.sh --version 0.3.0 --sha256 <real-0.3.0-sha256> --dry-run
```

Expected: `cask already at version 0.3.0 / sha256 …; nothing to do.` and exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/update-cask.sh
git commit -m "feat(release): add update-cask.sh to bump the Homebrew cask"
```

---

### Task 4: Wire the cask bump into `publish-release.sh`

Calls `update-cask.sh` as the final release step, with a `--skip-cask` escape hatch and a non-destructive failure path (the release is already live by then).

**Files:**
- Modify: `scripts/publish-release.sh` (usage heredoc ~lines 8-15; `remote="origin"` ~line 77; arg loop ~lines 79-96; tail ~lines 141-145)

**Interfaces:**
- Consumes: `scripts/update-cask.sh` from Task 3; the `version` and `sha256` shell vars already present in `publish-release.sh`.

- [ ] **Step 1: Add `--skip-cask` to the usage text**

In the `usage()` heredoc, change:

```
Usage:
  scripts/publish-release.sh [--remote origin]
```

to:

```
Usage:
  scripts/publish-release.sh [--remote origin] [--skip-cask]
```

- [ ] **Step 2: Default the flag**

Find:

```bash
remote="origin"
```

Add immediately after it:

```bash
skip_cask=0
```

- [ ] **Step 3: Parse the flag**

In the `while` arg loop, add a new case before the `-h|--help)` case:

```bash
    --skip-cask)
      skip_cask=1
      ;;
```

- [ ] **Step 4: Call update-cask at the end**

At the very end of the script, after the final `printf 'SHA-256: %s\n' "$sha256"` line, append:

```bash

if [ "$skip_cask" -eq 0 ]; then
  printf '\nBumping Homebrew cask...\n'
  if ! "$ROOT_DIR/scripts/update-cask.sh" --version "$version" --sha256 "$sha256"; then
    printf 'warning: release %s is published, but the cask bump failed.\n' "$tag" >&2
    printf 'Re-run: scripts/update-cask.sh --version %s --sha256 %s\n' "$version" "$sha256" >&2
    exit 1
  fi
fi
```

(`$ROOT_DIR`, `$version`, `$sha256`, and `$tag` are all already defined earlier in the script.)

- [ ] **Step 5: Syntax check**

Run:

```bash
bash -n scripts/publish-release.sh && echo "syntax ok"
```

Expected: `syntax ok`.

- [ ] **Step 6: Verify the flag is wired**

Run:

```bash
scripts/publish-release.sh --help | grep -- --skip-cask
```

Expected: the usage line containing `[--skip-cask]`.

Note: the full publish path can't be exercised without cutting a real release; the substantive logic lives in `update-cask.sh` (tested in Task 3). This task is thin glue, covered by the syntax + usage checks.

- [ ] **Step 7: Commit**

```bash
git add scripts/publish-release.sh
git commit -m "feat(release): bump the Homebrew cask from publish-release.sh"
```

---

### Task 5: Update the main README install instructions

**Files:**
- Modify: `README.md:62-63`

- [ ] **Step 1: Replace the placeholder install lines**

Replace exactly these two lines:

```
You can download the latest release from the [releases](https://github.com/darioielardi/delta/releases) page, brew coming soon!
macOS only for now.
```

with:

```
On macOS (Apple Silicon):

```sh
brew install --cask darioielardi/tap/delta
```

Or grab the latest `.dmg` from the [releases](https://github.com/darioielardi/delta/releases) page. macOS, Apple Silicon (arm64) only.
```

- [ ] **Step 2: Verify**

Run:

```bash
grep -n "brew install --cask darioielardi/tap/delta" README.md
```

Expected: one match around line 64.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document Homebrew cask install"
```

---

## Self-Review

**1. Spec coverage:**
- Tap `darioielardi/tap`, public repo → Tasks 1-2. ✓
- arm64-only DMG cask, `depends_on arch:` → Task 1. ✓
- `livecheck :github_latest`, no `auto_updates` → Task 1. ✓
- `zap` for clean uninstall → Task 1, verified Task 2 Step 4. ✓
- CLI stays app-managed (no `binary` stanza) → cask in Task 1 has none. ✓
- `update-cask.sh` standalone, idempotent, fails loudly, `--dry-run` → Task 3. ✓
- Extend `publish-release.sh` with `--skip-cask` + non-destructive failure → Task 4. ✓
- Bootstrap v0.3.0 from the **published** asset hash → Task 1 Step 1. ✓
- README update → Task 5. ✓
- `desc` < 80 chars, article-free → used verbatim in Task 1. ✓
- Non-goal (launch-time CLI prompt) → correctly absent.

**2. Placeholder scan:** the only substituted values are `$SHA` (computed in Task 1 Step 1, written by the heredoc) and `<real-0.3.0-sha256>` in Task 3 Step 6 (the same computed hash) — both are real values produced earlier, not open TODOs. No "TBD"/"handle errors"/"similar to" language.

**3. Type/name consistency:** `update-cask.sh` flags (`--version`, `--sha256`, `--dry-run`, `--tap-repo`) match between Task 3's definition and Task 4's call site. `DELTA_TAP_REPO` / default `darioielardi/homebrew-tap` consistent. Cask `version`/`sha256` line shapes asserted in Task 1 Interfaces match the `grep`/`perl` patterns in Task 3.
