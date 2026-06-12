#!/usr/bin/env bash
# Run the FancyMumble e2e suite locally in HEADED mode (visible window, no xvfb).
#
# Linux uses WebKitWebDriver; a window appears when $DISPLAY is set (i.e. not
# wrapped in xvfb-run). macOS is unsupported by tauri-driver.
#
# Usage:
#   scripts/run-local.sh [-b|--build] [-g|--grep PATTERN] [-k|--keep-server] [--bin PATH]
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

BUILD=0; KEEP=0; GREP=""; BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    -b|--build) BUILD=1 ;;
    -g|--grep) GREP="${2:?pattern}"; shift ;;
    -k|--keep-server) KEEP=1 ;;
    --bin) BIN="${2:?path}"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

command -v docker >/dev/null || { echo "docker not found on PATH" >&2; exit 1; }
command -v node   >/dev/null || { echo "node not found on PATH" >&2; exit 1; }
command -v tauri-driver >/dev/null || {
  echo "tauri-driver not found. Install: cargo install tauri-driver --locked" >&2; exit 1; }
command -v WebKitWebDriver >/dev/null || \
  echo "WARN: WebKitWebDriver not on PATH (apt-get install webkit2gtk-driver), or set E2E_NATIVE_DRIVER" >&2

bin_path="${BIN:-$repo/vendor/client/target/release/mumble-tauri}"
[ -n "$BIN" ] && export E2E_APP_BIN="$BIN"

[ -d node_modules ] || { step "Installing e2e dependencies"; npm ci; }

if [ "$BUILD" = 1 ] || [ ! -x "$bin_path" ]; then
  [ -n "$BIN" ] && { echo "No binary at --bin path: $BIN" >&2; exit 1; }
  step "Building client frontend (a few minutes)"
  ( cd vendor/client/crates/mumble-tauri/ui && npm ci && npm run build )
  step "Building client binary (cargo tauri build --no-bundle)"
  ( cd vendor/client && cargo tauri build --no-bundle )
fi
[ -x "$bin_path" ] || { echo "Client binary missing at $bin_path (use --build or --bin)" >&2; exit 1; }

compose="fixtures/docker-compose.e2e.yml"
step "Starting Mumble test server"
docker compose -f "$compose" up -d --wait

cleanup() {
  if [ "$KEEP" = 1 ]; then
    echo "Leaving server running (--keep-server). Stop: docker compose -f $compose down -v"
  else
    step "Stopping Mumble test server"
    docker compose -f "$compose" down -v
  fi
}
trap cleanup EXIT

step "Running e2e suite (headed - a window will open)"
glob="src/tests/**/*.test.ts"
base=(--import tsx --test --test-isolation=none --test-concurrency=1)
if [ -n "$GREP" ]; then
  node "${base[@]}" --test-name-pattern "$GREP" "$glob"
else
  node "${base[@]}" "$glob"
fi
