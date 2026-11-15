# GPUI migration: where the work lives

The move of the native client from the vendored GPUI 0.2.2 to the newer GPUI
(Longbridge `gpui-fast` plus the `gpui-mobile` Android backend) was done in a
working folder outside this repository, `F:\fancy-migrate`. These are its notes,
copied here on 2026-11-15 so the work can be found without that folder. Read
them before starting anything on the migration or on Android.

| What | Where it is now |
| --- | --- |
| The GPUI fork (gpui-fast + Android backend + the client's changes) | `Fancy-Mumble/gpui`, branch `develop` (local: `F:\fancy-migrate\gpui-next`, branch `fancy`) |
| Android host, client library, backend test program | `Fancy-Mumble/fancy-android` (local: `android-host`, `android-client`, `android-hello`) |
| The client ported to the new GPUI | `Fancy-Mumble/FancyMumble`, branch `wip/gpui-next-port` (local: `client-2-edit`, branch `port`). Its history starts from a snapshot of the client, not from the client's own history: re-apply it, do not merge it |

| Note | What it holds |
| --- | --- |
| `PROGRESS.md` | State of the fork: what was cherry-picked from which line, what is open |
| `PORT-RECORD.md` | The client port, change by change, with the test suite counts |
| `ANDROID-PROGRESS.md` | Android: what runs on the emulator, how to build, what is missing |
| `PHONE-LAYOUT.md` | The phone layout, measured against the web client's handheld UI |
| `android/*.patch`, `textbg.patch`, `port-scripts/` | Patches and scripts the notes refer to |

State on 2026-11-15: the port compiles and its suite passes, but it has no
performance tables yet and the DirectX path-buffer memory fix has not been
measured on the new renderer. The client still builds from the vendored 0.2.2
fork; do not switch before those two are done.
