#!/usr/bin/env bash
# Run only the suites that are currently red, for a fast iteration loop.
#
# The full sweep takes ~45 min, most of it spent re-proving that the green
# suites are still green and that the gated ones are still gated. While working
# a cluster you want the opposite: just the reds, now.
#
# The list is the failing set from the 2026-08-08 sweep MINUS everything that
# now gates itself (calendar, friend-chat, channelviewer, admin UI, qt6ui,
# user-manager, parity) - those cost ~0 and prove nothing about a fix.
#
# Keep it honest: when a file goes green, move it out of RED and into the full
# sweep's job. When the list empties, Phase 2 is done.
#
# Usage:
#   scripts/red-set.sh                  # every red file
#   scripts/red-set.sh pchat screen     # only reds matching these substrings

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RED=(
    # -- persistent chat / crypto delivery ----------------------------
    src/tests/signal-pchat.multiclient.test.ts
    src/tests/pchat.multiclient.test.ts
    src/tests/pchat-control-plane.multiclient.test.ts
    src/tests/meetings.multiclient.test.ts
    # -- channel lifecycle -------------------------------------------
    src/tests/channels.multiclient.test.ts
    src/tests/hidden-channels.multiclient.test.ts
    src/tests/admin-channel-delete.multiclient.test.ts
    # -- control plane / social --------------------------------------
    src/tests/fancy-control-plane.multiclient.test.ts
    src/tests/reactions.multiclient.test.ts
    src/tests/scheduled-messages.multiclient.test.ts
    src/tests/audit-log.test.ts
    # -- media --------------------------------------------------------
    src/tests/screenshare.multiclient.test.ts
    src/tests/screenshare.gpu.test.ts
    src/tests/screenshare.performance.test.ts
    src/tests/screen-share-health.test.ts
    src/tests/camera-share.test.ts
    src/tests/denoiser-deepfilternet.multiclient.test.ts
)

files=("${RED[@]}")
if [[ $# -gt 0 ]]; then
    filtered=()
    for file in "${files[@]}"; do
        for want in "$@"; do
            [[ "$file" == *"$want"* ]] && filtered+=("$file") && break
        done
    done
    files=("${filtered[@]}")
fi

(( ${#files[@]} )) || { echo "no red files match: $*" >&2; exit 1; }
echo "red set: ${#files[@]} file(s)"
exec node --import tsx scripts/e2e.mts "${files[@]}"
