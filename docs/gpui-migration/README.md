# GPUI migration: where the work lives

The move of the native client from the vendored GPUI 0.2.2 to the newer GPUI
(Longbridge `gpui-fast` plus the `gpui-mobile` Android backend) was done in a
working folder outside this repository, `F:\fancy-migrate`. These are its notes,
copied here on 2026-11-15 so the work can be found without that folder. Read
them before starting anything on the migration or on Android.

| What | Where it is now |
| --- | --- |
| The GPUI fork (gpui-fast + Android backend + the client's changes) | `Fancy-Mumble/gpui`, branch `develop` (local: `F:\fancy-migrate\gpui-next`, branch `fancy`). Fork changes are listed in its `FANCY_CHANGES.md` |
| The client, on the new GPUI | `Fancy-Mumble/FancyMumble`, branch `develop`: `14f49e29` (the port, with the work of 14 November until 00:57 carried over, on the `src/ui` / `src/crates` tree) and `747b5b08` (the view as a library for Android). It takes `gpui` from `Fancy-Mumble/gpui` by git; `vendor/gpui` is gone |
| Android host, client library, backend test program | `Fancy-Mumble/fancy-android`, branch `develop` (local: `android-host`, `android-client`, `android-hello`). `android-client` takes `fancy-gpui` from `Fancy-Mumble/FancyMumble` and `gpui`/`gpui_mobile` from `Fancy-Mumble/gpui` by git; no local copy of the client |
| The port before it landed (superseded) | `Fancy-Mumble/FancyMumble`, branches `wip/gpui-next-port` (the client at 18:08, 14 November) and `wip/gpui-next-port-2312` (at 23:12). Snapshot histories; kept for reference only |

| Note | What it holds |
| --- | --- |
| `PROGRESS.md` | State of the fork: what was cherry-picked from which line, what is open |
| `PORT-RECORD.md` | The client port, change by change, with the test suite counts |
| `ANDROID-PROGRESS.md` | Android: what runs on the emulator and on a Pixel 7, how to build, what is missing, how the port landed |
| `PHONE-LAYOUT.md` | The phone layout, measured against the web client's handheld UI |
| `android/*.patch`, `textbg.patch`, `port-scripts/` | Patches and scripts the notes refer to; the three Android patches are now in `FancyMumble` `develop` (`747b5b08`) |

State on 2026-11-15, after the landing: the client builds from the new GPUI.
Its suite: 862 passed, 0 failed, 49 ignored, plus the start-up imports test;
`gpui_windows` 40 passed. The DirectX path-buffer memory fix is carried over
into the fork's both draw paths and measured: 21 MB of dedicated GPU memory
against 31 MB without it, on the main screen at 1394 x 792. Still not done:
performance tables (frame times, idle CPU, scrolling) against the 0.2.2
build. On Android the client builds from the repositories alone and runs on
a Pixel 7, GPU-rendered on its Mali-G710; the phone layout is still to come.
