#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  scripts/build-release-dmg.sh --patch
  scripts/build-release-dmg.sh --minor
  scripts/build-release-dmg.sh --major
  scripts/build-release-dmg.sh --version X.Y.Z

Builds a signed, notarized, stapled DMG release candidate.
Leaves the package.json version bump uncommitted so you can test before publishing.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_clean_worktree() {
  if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    git status --short >&2
    die "worktree must be clean before bumping the release version"
  fi
}

require_notary_auth() {
  NOTARY_ARGS=()

  if [ -n "${APPLE_API_KEY:-}" ] || [ -n "${APPLE_API_ISSUER:-}" ] || [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    [ -n "${APPLE_API_KEY:-}" ] || die "APPLE_API_KEY is required for API-key notarization"
    [ -n "${APPLE_API_ISSUER:-}" ] || die "APPLE_API_ISSUER is required for API-key notarization"
    [ -n "${APPLE_API_KEY_PATH:-}" ] || die "APPLE_API_KEY_PATH is required for API-key notarization"
    [ -r "$APPLE_API_KEY_PATH" ] || die "APPLE_API_KEY_PATH is not readable"
    NOTARY_ARGS=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
    return
  fi

  if [ -n "${APPLE_ID:-}" ] || [ -n "${APPLE_PASSWORD:-}" ] || [ -n "${APPLE_TEAM_ID:-}" ]; then
    [ -n "${APPLE_ID:-}" ] || die "APPLE_ID is required for Apple ID notarization"
    [ -n "${APPLE_PASSWORD:-}" ] || die "APPLE_PASSWORD is required for Apple ID notarization"
    [ -n "${APPLE_TEAM_ID:-}" ] || die "APPLE_TEAM_ID is required for Apple ID notarization"
    NOTARY_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
    return
  fi

  die "notarization credentials are missing; set APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_PATH"
}

package_version() {
  node -e "console.log(JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version)"
}

product_name() {
  node -e "console.log(JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json', 'utf8')).productName)"
}

bump_version() {
  node - "$1" "${2:-}" <<'NODE'
const fs = require("fs");

const bump = process.argv[2];
const explicit = process.argv[3] || "";
const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`unsupported package version: ${version}`);
  }
  return match.slice(1).map(Number);
}

let next;
if (bump === "version") {
  if (!/^\d+\.\d+\.\d+$/.test(explicit)) {
    throw new Error(`--version must be X.Y.Z, got: ${explicit}`);
  }
  next = explicit;
} else {
  const [major, minor, patch] = parseVersion(pkg.version);
  if (bump === "major") {
    next = `${major + 1}.0.0`;
  } else if (bump === "minor") {
    next = `${major}.${minor + 1}.0`;
  } else if (bump === "patch") {
    next = `${major}.${minor}.${patch + 1}`;
  } else {
    throw new Error(`unknown bump: ${bump}`);
  }
}

pkg.version = next;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(next);
NODE
}

find_dmg() {
  local version="$1"
  local product="$2"
  local count=0
  local found=""

  while IFS= read -r candidate; do
    count=$((count + 1))
    found="$candidate"
  done < <(find src-tauri/target/release/bundle/dmg -maxdepth 1 -type f -name "${product}_${version}_*.dmg" -print 2>/dev/null)

  [ "$count" -eq 1 ] || die "expected exactly one DMG for ${product} ${version}, found ${count}"
  printf '%s\n' "$found"
}

bump=""
explicit_version=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --patch|--minor|--major)
      [ -z "$bump" ] || die "choose only one version option"
      bump="${1#--}"
      ;;
    --version)
      [ -z "$bump" ] || die "choose only one version option"
      shift
      [ "$#" -gt 0 ] || die "--version requires X.Y.Z"
      bump="version"
      explicit_version="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

[ -n "$bump" ] || {
  usage >&2
  die "choose --patch, --minor, --major, or --version X.Y.Z"
}

require_cmd git
require_cmd node
require_cmd pnpm
require_cmd cargo
require_cmd xcrun
require_cmd spctl
require_cmd shasum
require_clean_worktree
require_notary_auth
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || die "APPLE_SIGNING_IDENTITY is required so the build can sign the app (e.g. 'Developer ID Application: Your Name (TEAMID)')"

old_version="$(package_version)"
product="$(product_name)"

printf 'Validating current tree before version bump...\n'
npx tsc --noEmit
pnpm test
(cd src-tauri && cargo test)

new_version="$(bump_version "$bump" "$explicit_version")"
printf 'Version bumped: %s -> %s\n' "$old_version" "$new_version"

# Revert the uncommitted version bump if anything below fails, so a failed run
# doesn't leave package.json dirty and wedge the next run on require_clean_worktree.
trap 'git checkout -- package.json' ERR

# Sign during the build, but suppress Tauri's own notarization by unsetting the
# notary credentials for this command only (NOTARY_ARGS already captured them above).
# The DMG is notarized exactly once, explicitly, below.
env -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
    -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
    pnpm tauri build --bundles dmg

dmg_path="$(find_dmg "$new_version" "$product")"

printf 'Notarizing final DMG...\n'
xcrun notarytool submit "$dmg_path" "${NOTARY_ARGS[@]}" --wait

printf 'Stapling final DMG...\n'
xcrun stapler staple "$dmg_path"

printf 'Verifying final DMG...\n'
spctl -a -vvv -t open --context context:primary-signature "$dmg_path"
xcrun stapler validate "$dmg_path"

sha256="$(shasum -a 256 "$dmg_path" | awk '{print $1}')"

printf '\nRelease candidate built.\n'
printf 'Version: %s\n' "$new_version"
printf 'DMG: %s\n' "$dmg_path"
printf 'SHA-256: %s\n' "$sha256"
printf '\nTest this DMG locally. If it is good, run scripts/publish-release.sh.\n'
