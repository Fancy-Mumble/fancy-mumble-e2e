#!/usr/bin/env bash
# Build a COMPLETE client artifact for the e2e suite.
#
# `cargo tauri build` alone does not produce one, and the three things it
# leaves out each fail whole suites for reasons that look like product bugs:
#
#   * libsignal_bridge.so  - a separate, workspace-excluded crate (AGPL
#     boundary). Without it next to the binary the client silently runs with
#     no Signal bridge, and every pchat/E2E suite fails with "no E2E badge".
#   * deepfilternet-denoiser - off by default, so `offers DeepFilterNet in
#     this build` fails against a binary that simply wasn't asked for it.
#   * qt6ui - a workspace-excluded crate the ghost-session suite drives.
#     SKIP_QT6UI=1 (as the handoff doc suggests) makes that suite fail on a
#     missing binary rather than on anything the server did.
#
# Usage:
#   scripts/build-client.sh              # everything
#   scripts/build-client.sh --no-qt6ui   # skip the Qt client (needs a Qt kit)
#
# Environment passes through, so a host that needs help finding system
# libraries can still set PKG_CONFIG_PATH / LD_LIBRARY_PATH / CROS_LIBVA_H_PATH
# and wrap this in `nix develop ... -c`.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLIENT="$PWD/vendor/client"
PROFILE_DIR="$CLIENT/target/release"
want_qt6ui=1
[[ "${1:-}" == "--no-qt6ui" ]] && want_qt6ui=0

# cros-libva 0.0.12 generates its VA-API bindings from whatever libva headers
# are installed, and its own source only compiles against < 2.23: on 2.23 the
# VP9 encode struct grew `seg_id_block_size` / `va_reserved8` and the crate's
# initializer no longer matches, which surfaces as an E0063 deep inside a
# dependency and looks nothing like "your libva is too new".
#
# Ubuntu 26.04 ships 2.23, so pin the headers to a 2.22 deb and point the crate
# at them. Extracted anywhere; CROS_LIBVA_H_PATH must name the directory that
# *contains* `va/va_version.h`.
if [[ -z "${CROS_LIBVA_H_PATH:-}" ]] && command -v pkg-config >/dev/null; then
    libva=$(pkg-config --modversion libva 2>/dev/null || echo "")
    # pkg-config reports the ABI (1.x) for libva 2.x, so compare the minor.
    minor=${libva#*.}; minor=${minor%%.*}
    if [[ -n "$libva" && "${minor:-0}" -ge 23 ]]; then
        echo "!! libva $libva is too new for cros-libva 0.0.12 (needs < 2.23)." >&2
        echo "   The build will fail with E0063 in cros-libva's VP9 encode buffer." >&2
        echo "   Fix: pin 2.22 headers and re-run:" >&2
        echo "     curl -LO https://launchpad.net/ubuntu/+archive/primary/+files/libva-dev_2.22.0-2_amd64.deb" >&2
        echo "     dpkg-deb -x libva-dev_2.22.0-2_amd64.deb /tmp/libva-2.22" >&2
        echo "     CROS_LIBVA_H_PATH=/tmp/libva-2.22/usr/include scripts/build-client.sh" >&2
        echo "   (cros-libva declares no rerun-if-env-changed, so after a failed" >&2
        echo "    build also run: cargo clean -p cros-libva)" >&2
    fi
fi

echo "==> signal-bridge (cdylib, separate crate)"
(cd "$CLIENT/crates/signal-bridge" && cargo build --release)
mkdir -p "$PROFILE_DIR"
cp "$CLIENT/crates/signal-bridge/target/release/libsignal_bridge.so" "$PROFILE_DIR/"

# `cargo tauri build` starts a file watcher, so an exhausted inotify pool makes
# it abort with a bare "Too many open files" that names no file and looks like a
# broken toolchain. Say what it actually is, and how to fix it, before building.
instances=$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo 0)
# `|| true` because find exits non-zero on the /proc entries of other users'
# processes, and `set -o pipefail` would otherwise make this diagnostic abort
# the build it exists to explain.
inuse=$(find /proc/*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l || true)
if [[ "$instances" != 0 && "$inuse" -ge "$instances" ]]; then
    echo "!! inotify instances exhausted ($inuse/$instances) - the Tauri CLI's watcher" >&2
    echo "   cannot start and the build will abort with \"Too many open files\"." >&2
    echo "   Fix: sudo sysctl fs.inotify.max_user_instances=512   (or close editors/watchers)" >&2
    echo "   Or:  E2E_BUILD_NO_CLI=1 scripts/build-client.sh   (plain cargo, needs ui/dist current)" >&2
fi

echo "==> client (with deepfilternet-denoiser)"
(
    cd "$CLIENT/crates/mumble-tauri"
    export SKIP_QT6UI=$(( want_qt6ui ? 0 : 1 ))
    if [[ -n "${E2E_BUILD_NO_CLI:-}" ]]; then
        # No Tauri CLI: no watcher, and no frontend build either - this reuses
        # whatever is in ui/dist, so only take this path when the bundle is
        # current. `custom-protocol` is what embeds that bundle in the binary.
        cargo build --release -p mumble-tauri --features custom-protocol,deepfilternet-denoiser
    else
        cargo tauri build --no-bundle -- --features deepfilternet-denoiser
    fi
)

# The bridge must sit next to the binary: the loader searches the exe's own
# directory first (see load_signal_bridge in state/pchat/signal_bridge.rs).
# `cargo tauri build` can rewrite target/release, so copy AFTER it, not before.
cp "$CLIENT/crates/signal-bridge/target/release/libsignal_bridge.so" "$PROFILE_DIR/"

echo
echo "==> artifact check"
fail=0
bin="$PROFILE_DIR/mumble-tauri"
[[ -x "$bin" ]] && echo "  ok   client binary" || { echo "  MISS client binary"; fail=1; }
[[ -f "$PROFILE_DIR/libsignal_bridge.so" ]] \
    && echo "  ok   libsignal_bridge.so" || { echo "  MISS libsignal_bridge.so"; fail=1; }
if (( want_qt6ui )); then
    qt="$CLIENT/crates/qt6ui/target/debug/qt6ui"
    [[ -x "$qt" ]] && echo "  ok   qt6ui" || echo "  WARN qt6ui not built (ghost-session suite will fail)"
fi
exit $fail
