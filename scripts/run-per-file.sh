#!/usr/bin/env bash
# Run the e2e suite one node process per file, reaping drivers in between.
#
# `npm run test:e2e` runs every file in one process and sets no `--test-timeout`,
# which has two failure modes this script exists to avoid:
#
#   * A hung file blocks the run forever. `--test-timeout` bounds a **file**, not
#     a test, so a value tight enough to catch a hang also kills legitimate long
#     files — and when the runner gives up on one file mid-run it cancels the
#     rest. One sweep lost ~92 tests to cancellations that way.
#   * A timed-out file's `after()` never runs, so its `tauri-driver` keeps
#     127.0.0.1:4447 and every later file dies with "tauri-driver exited early
#     ... native WebDriver is almost certainly missing" — a misleading message
#     for a port that is simply still held.
#
# A process per file bounds the damage to the file that caused it, and reaping
# between files means a leak cannot cascade.
#
# Usage:
#   scripts/run-per-file.sh                 # every file
#   scripts/run-per-file.sh forums pchat    # only files matching these
#
# Environment:
#   E2E_FILE_TIMEOUT   seconds per file (default 420)
#   E2E_APP_BIN        client binary; defaults to the release build

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The repo ships its own msedgedriver under .tools. Without it on PATH every
# file dies in `before` with the "native WebDriver is almost certainly missing"
# message above, which reads like a broken harness rather than a $PATH.
[[ -d .tools ]] && export PATH="$PWD/.tools:$PATH"

timeout_s="${E2E_FILE_TIMEOUT:-420}"
results="$(mktemp)"
trap 'rm -f "$results"' EXIT

# Anything still holding a driver port, before we start and between files.
reap() {
    for name in tauri-driver msedgedriver WebKitWebDriver; do
        taskkill //F //IM "$name.exe" >/dev/null 2>&1 || pkill -f "$name" >/dev/null 2>&1 || true
    done
}

mapfile -t files < <(find src/tests -name '*.test.ts' | sort)
if [[ $# -gt 0 ]]; then
    filtered=()
    for file in "${files[@]}"; do
        for want in "$@"; do
            [[ "$file" == *"$want"* ]] && filtered+=("$file") && break
        done
    done
    files=("${filtered[@]}")
fi

echo "running ${#files[@]} file(s), ${timeout_s}s each"
reap

for file in "${files[@]}"; do
    name="$(basename "$file" .test.ts)"
    printf '%-42s ' "$name"
    log=".tmp/per-file/$name.log"
    mkdir -p "$(dirname "$log")"

    timeout "${timeout_s}" node --import tsx --test --test-reporter=spec "$file" >"$log" 2>&1
    status=$?

    # awk on the last field rather than a regex anchored at column 0: the spec
    # reporter prefixes its summary with a multibyte glyph, so `^.` matches one
    # *byte* of it and silently never fires — which then reads as "ran no test".
    pass=$(awk '/ pass [0-9]+$/ { n = $NF } END { print n + 0 }' "$log")
    fail=$(awk '/ fail [0-9]+$/ { n = $NF } END { print n + 0 }' "$log")

    if [[ $status -eq 124 ]]; then
        echo "TIMEOUT after ${timeout_s}s"
        echo "$name timeout 0 0" >>"$results"
    else
        echo "pass $pass  fail $fail"
        echo "$name ok $pass $fail" >>"$results"
    fi

    reap
done

echo
echo "──────── summary ────────"
awk '{ p += $3; f += $4;
       if ($2 == "timeout") t++;
       else if ($4 == 0 && $3 > 0) g++;
       else if ($4 > 0) b++;
       else z++ }
     END { printf "%d passing, %d failing across %d file(s)\n", p, f, NR;
           printf "  %d green, %d with failures, %d ran no test, %d timed out\n",
                  g + 0, b + 0, z + 0, t + 0 }' "$results"
echo "logs in .tmp/per-file/"
