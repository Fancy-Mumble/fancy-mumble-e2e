#!/usr/bin/env bash
# Relaunch the client, connect to the local Starling (see run-starling.mts),
# flood the channel with messages from bots, and measure idle CPU + memory at
# each stage. Private working set (PWS) is the Task Manager number.
#
# Usage (from anywhere): EXE=<path to mumble-tauri.exe> realistic.sh <label> [total] [perSecond]
# Needs a saved server "localhost" on the connect screen, and LINK_PORT set to
# the Starling operator port if the link previews should resolve.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/.tmp/perf"
mkdir -p "$OUT"
LABEL="${1:-run}"; TOTAL="${2:-3000}"; RATE="${3:-25}"
PS="powershell -NoProfile -ExecutionPolicy Bypass"
EXE="${EXE:-$REPO/vendor/client/target/release/mumble-tauri.exe}"
PORT="${CDP_PORT:-9333}"
export LINK_PORT="${LINK_PORT:-8081}"
cdp() { node "$HERE/cdp.mjs" "$PORT" "$@"; }

# Only the binary under test is ever stopped, never another running client.
WINEXE=$(cygpath -w "$EXE")
$PS -Command "Get-CimInstance Win32_Process -Filter \"Name='mumble-tauri.exe'\" | Where-Object { \$_.ExecutablePath -eq '$WINEXE' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -Confirm:\$false -ErrorAction SilentlyContinue }" >/dev/null 2>&1
sleep 3
LAUNCH=$(bash "$HERE/launch.sh" "$EXE" "app-stderr-$LABEL.log")
echo "$LAUNCH"
APP_PID=$(echo "$LAUNCH" | sed -E 's/^pid=([0-9]+).*/\1/')
echo "measuring pid $APP_PID"
M="$PS -File $HERE/measure.ps1 -RootPid $APP_PID -Seconds 10 -Label"
alive() { $PS -Command "if (Get-Process -Id $APP_PID -ErrorAction SilentlyContinue) { 'alive' } else { 'DEAD' }"; }
sleep 30
cdp eval "(() => { const row = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === 'localhost'); if (!row) return 'no localhost row'; let el = row; for (let i = 0; i < 6 && el && !(el.getAttribute && (el.getAttribute('role') === 'button' || el.tagName === 'BUTTON' || el.tagName === 'A')); i++) el = el.parentElement; (el ?? row).click(); return 'clicked server'; })()"
sleep 3
cdp eval "(() => { const b = [...document.querySelectorAll('button')].find(b => /^Connect as/.test(b.textContent.trim())); if (!b) return 'no connect button'; b.click(); return 'clicked ' + b.textContent.trim(); })()"
sleep 20
$M "$LABEL: connected, empty channel, idle"
cdp metrics 5 | tr -d '\n' | sed 's/  */ /g'; echo

echo "== flooding $TOTAL messages at $RATE/s"
(cd "$REPO" && node --import tsx "$HERE/flood.mts" "$TOTAL" "$RATE" 5 0) 2>&1 | tail -4
echo "client after flood: $(alive)"
sleep 25
$M "$LABEL: after flood, idle (1st sample)"
cdp metrics 10 | tr -d '\n' | sed 's/  */ /g'; echo
cdp shot "$OUT/shot-$LABEL-flooded.png"
sleep 60
$M "$LABEL: after flood, idle (2nd sample, +90s)"
cdp metrics 10 | tr -d '\n' | sed 's/  */ /g'; echo
echo "== scrolling the history"
cdp eval "(async () => { const list = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]; if (!list) return 'no scroller'; for (let i = 0; i < 40; i++) { list.scrollTop = Math.max(0, list.scrollTop - 900); await new Promise(r => setTimeout(r, 150)); } for (let i = 0; i < 60; i++) { list.scrollTop = list.scrollTop + 900; await new Promise(r => setTimeout(r, 150)); } return 'scrolled, top=' + list.scrollTop + ' of ' + list.scrollHeight; })()"
sleep 20
$M "$LABEL: after scrolling history, idle"
cdp metrics 10 | tr -d '\n' | sed 's/  */ /g'; echo
cdp shot "$OUT/shot-$LABEL-scrolled.png"
echo "client at end: $(alive)"
echo "realistic done"
