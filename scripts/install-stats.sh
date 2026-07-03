#!/usr/bin/env bash
set -euo pipefail

# Reports GitHub release download counts for Delta — a proxy for cumulative
# installs (Homebrew-cask installs are included, since brew downloads the DMG
# asset from the release). It is an upper bound: re-downloads, brew reinstalls,
# and CI inflate it. "How many actively use it" comes from Aptabase, not here.

REPO="${DELTA_REPO:-darioielardi/delta}"

command -v gh >/dev/null 2>&1 || { echo "error: gh CLI not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq not found" >&2; exit 1; }

gh api --paginate "repos/${REPO}/releases" | jq -s '
  add
  | map({ tag: .tag_name, downloads: ([.assets[].download_count] | add // 0) })
  | . as $rows
  | ($rows | map(.downloads) | add // 0) as $total
  | ($rows[] | "\(.tag)\t\(.downloads)"), "----\tTOTAL: \($total)"
' -r | column -t -s $'\t'
