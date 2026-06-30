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
