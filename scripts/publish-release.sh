#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  scripts/publish-release.sh [--remote origin]

Publishes the already-built and tested DMG for the current package.json version.
If package.json has an uncommitted version bump, this commits it before tagging.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

package_version() {
  node -e "console.log(JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version)"
}

product_name() {
  node -e "console.log(JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json', 'utf8')).productName)"
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

ensure_publishable_worktree() {
  local status
  status="$(git status --porcelain --untracked-files=all)"

  if [ -z "$status" ]; then
    return
  fi

  local unexpected
  unexpected="$(printf '%s\n' "$status" | awk '$2 != "package.json" { print }')"
  if [ -n "$unexpected" ]; then
    printf '%s\n' "$status" >&2
    die "only package.json may be changed when publishing"
  fi
}

commit_version_bump_if_needed() {
  local version="$1"

  if git diff --quiet -- package.json && git diff --cached --quiet -- package.json; then
    printf 'No uncommitted package.json version bump; publishing current HEAD as v%s.\n' "$version"
    return
  fi

  git add package.json
  git commit -m "chore(release): v${version}"
}

remote="origin"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote)
      shift
      [ "$#" -gt 0 ] || die "--remote requires a remote name"
      remote="$1"
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

require_cmd git
require_cmd gh
require_cmd node
require_cmd spctl
require_cmd xcrun
require_cmd shasum

version="$(package_version)"
product="$(product_name)"
tag="v${version}"
dmg_path="$(find_dmg "$version" "$product")"

printf 'Verifying DMG before publishing...\n'
spctl -a -vvv -t open --context context:primary-signature "$dmg_path"
xcrun stapler validate "$dmg_path"

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  die "local tag already exists: ${tag}"
fi

if git ls-remote --exit-code --tags "$remote" "refs/tags/${tag}" >/dev/null 2>&1; then
  die "remote tag already exists: ${tag}"
fi

ensure_publishable_worktree
commit_version_bump_if_needed "$version"

git tag "$tag"
git push "$remote" HEAD
git push "$remote" "$tag"

sha256="$(shasum -a 256 "$dmg_path" | awk '{print $1}')"
notes_file="$(mktemp)"
trap 'rm -f "$notes_file"' EXIT

{
  printf 'Signed and notarized macOS DMG.\n\n'
  printf 'SHA-256:\n\n'
  printf '```text\n'
  printf '%s  %s\n' "$sha256" "$(basename "$dmg_path")"
  printf '```\n'
} > "$notes_file"

gh release create "$tag" "$dmg_path" --title "${product} ${tag}" --notes-file "$notes_file"

printf '\nPublished %s.\n' "$tag"
printf 'DMG: %s\n' "$dmg_path"
printf 'SHA-256: %s\n' "$sha256"
