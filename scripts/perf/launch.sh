#!/usr/bin/env bash
# Launch the client with a DevTools port open and stderr/stdout captured, and
# print the WINDOWS pid of the new instance (bash's $! is an MSYS pid).
#
# The WebView2 profile lives under .tmp/ so the instance never shares a browser
# process with another running Fancy Mumble (which would swallow the debug
# flag). The Roaming config dir is still the real one - Tauri resolves it via
# the known-folder API, which ignores environment overrides.
#
# Usage: launch.sh <exe> [stderr-log]     (EXTRA_ARGS adds WebView2 flags)
EXE="${1:?path to mumble-tauri.exe}"
LOG="${2:-app-stderr.log}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$HERE/../../.tmp/perf"
mkdir -p "$TMP/EBWebView"
export WEBVIEW2_USER_DATA_FOLDER="$(cygpath -w "$TMP/EBWebView")"
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=${CDP_PORT:-9333} ${EXTRA_ARGS:-}"
export RUST_BACKTRACE=1
WINEXE=$(cygpath -w "$EXE")
cd "$(dirname "$EXE")" || exit 1
"$EXE" > "$TMP/$LOG" 2>&1 &
sleep 3
WPID=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='mumble-tauri.exe'\" | Where-Object { \$_.ExecutablePath -eq '$WINEXE' } | Sort-Object CreationDate -Descending | Select-Object -First 1).ProcessId")
echo "pid=$WPID exe=$WINEXE"
