#!/usr/bin/env bash
#
# Keep the channel viewer's copy of the shared profile card identical to the
# client's.
#
# The card is one component by design - the same pixels in the desktop client
# and in the web viewer - but the two live in separate repositories, so there is
# no import path between them. The client's copy is the source; this script
# copies it across, and `--check` fails when the two have diverged, which is
# what a CI job or a pre-release check should run.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/vendor/client/crates/mumble-tauri/ui/src/shared/profilecard"
dst="$root/vendor/channelviewer-frontend/src/shared/profilecard"

if [[ ! -d "$src" ]]; then
  echo "sync-profile-card: no source at $src" >&2
  exit 1
fi

# Tests stay with the source: the viewer vendors the component, not its suite.
copy() {
  rm -rf "$1"
  mkdir -p "$1"
  (cd "$src" && find . -type f -name '*.ts*' ! -name '*.test.*' -print0) |
    (cd "$src" && xargs -0 -I{} cp --parents {} "$1")
}

if [[ "${1:-}" == "--check" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  copy "$tmp"
  if diff -ru "$tmp" "$dst" >/dev/null 2>&1; then
    echo "sync-profile-card: viewer copy is current"
  else
    echo "sync-profile-card: viewer copy has drifted from the client:" >&2
    diff -ru "$tmp" "$dst" >&2 || true
    echo >&2
    echo "Run scripts/sync-profile-card.sh to bring it back." >&2
    exit 1
  fi
else
  copy "$dst"
  echo "sync-profile-card: copied $(find "$dst" -type f | wc -l) files into the viewer"
fi
