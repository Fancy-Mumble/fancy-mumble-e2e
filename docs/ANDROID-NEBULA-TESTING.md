# Testing Nebula on Android

Nebula had never been looked at on Android, and the first thing found on
trying was why: **the client did not compile for Android at all** on
`wip/voice-latency-2`. That is fixed (see [What was broken](#what-was-broken)),
and the two commands below put the pack on an emulator.

The e2e suite cannot do this for you. It drives the *desktop* client through
`tauri-driver` and Selenium (`src/driver.ts`); there is no Android WebDriver in
the rig, so everything here is by hand.

## Run it

Two terminals, from the repo root.

```powershell
# 1. a server the device can reach
npm run server:android

# 2. build, install, launch (starts an emulator if none is attached)
./scripts/android.ps1 -Fresh
```

In the app, connect to:

| where the client runs | host | port |
| --- | --- | --- |
| Emulator | `10.0.2.2` | 64738 |
| Phone on the LAN | the LAN address the server prints | 64738 |
| This machine | `127.0.0.1` | 64738 |

SuperUser's password is `superuser` (`ANDROID_SERVER_PASSWORD` overrides it).

`10.0.2.2` is the emulator's route to the host's loopback, so nothing has to be
port-forwarded. A physical phone needs the LAN address *and* an inbound
firewall rule for 64738 on this machine.

### Why `-Fresh`

Nebula is `DEFAULT_UI_DESIGN` (`ui/src/ui/registry.ts`), and the default is
consulted only when a profile has no stored preference. `-Fresh` uninstalls
first, so the app opens on a first-run profile - in Nebula, with nothing to
configure. Without it you get whatever the last session left behind.

To switch packs inside the app: **Settings > Personalize**, which Nebula ships
its own version of (`ui/nebula/components/settings/PersonalizeSettings.tsx`).
The `?ui=` launch override the e2e suite uses is desktop-only - on Android the
webview loads from the asset protocol and there is no URL to put it in.

### Hot reload

```powershell
./scripts/android.ps1 -Dev
```

`cargo tauri android dev`, so edits under `ui/src` land without a rebuild. It
holds the terminal. Verified 2026-09-09: editing a string in
`core/locales/nebula/en/sidebar.json` changed the running app on the emulator
about two seconds later, with no rebuild and no reinstall.

**The default build cannot hot-reload, and that is the usual confusion.**
`./scripts/android.ps1` without `-Dev` bundles `ui/dist` into the APK; the
webview then loads `tauri.localhost` and no dev server is involved at all. If
you are looking at an installed APK waiting for an edit to appear, it never
will. Under `-Dev` the URL still *reads* `tauri.localhost` - Tauri proxies the
dev server through its own protocol - so check the loaded resources instead:
`@vite/client` and `/src/main.tsx` mean you are on the dev server.

The Rust watcher stays on, and the crate's own `.taurignore` already keeps it
off `ui/` - so a UI edit reloads through Vite with no rebuild, while a Rust
edit rebuilds the way it should. Do not reach for `--no-watch` to "fix" a
rebuild you think a UI edit caused: it makes the CLI exit the moment the app
launches, which leaves Vite orphaned, takes the port with it, and turns
"Ctrl+C to stop" into a lie. (`-NoWatch` is there if you want it anyway.)

Four things have to be right, and `-Dev` now does all of them for you:

- **The dev-server address must resolve from both sides.** The CLI polls the
  dev URL from *this machine* before it will build; the webview fetches it from
  *the device*. `10.0.2.2` is the emulator's name for this host and means
  nothing here, so the CLI hangs forever on `Waiting for your frontend dev
  server to start`. A LAN address needs the right adapter picked out of seven
  and a firewall rule. `127.0.0.1` is the only address that works at both ends
  - Vite here, `adb reverse` there - and it covers a USB phone too. On Windows
  passing `--host` is compulsory: without it the CLI substitutes "the public
  network address" and prompts when there are several, which a script cannot
  answer.
- **1420 belongs to the desktop `cargo tauri dev`.** That session cannot move
  off it - the port is baked into `build.devUrl` in `tauri.conf.json` and Vite
  is `strictPort`, so it dies with `Port 1420 is already in use` and no way to
  configure around it. The Android session *can* move, because it passes its
  own `devUrl`, so `-Dev` starts at **1421** and leaves 1420 alone even when it
  is free. Claiming a free 1420 only breaks the next desktop session to start.
- **The port override has to travel as a file.** `--config` accepts JSON or a
  path, and only the path survives: PowerShell strips the inner quotes out of a
  JSON literal handed to a native exe, and the CLI then rejects
  `{build:{devUrl:...}}`.
- **That file must have no BOM.** Windows PowerShell's `Set-Content -Encoding
  utf8` writes one, and the CLI reports `expected value at line 1 column 1` -
  which reads like malformed JSON rather than three bytes too many.

### Verified

Driven end to end on 2026-09-09, on the `Pixel_9` AVD (API 36, x86_64):
onboarding, add server `10.0.2.2:64738`, connect. The client pings the server
(`0/100 online, 8 ms, Mumble 1.6.0`) and logs in - it sits in `#Starling` as
`AndroidTester`. The pack was confirmed over CDP rather than by eye:
`performance.getEntriesByType('resource')` in the webview names
`nebula-*.js` / `nebula-*.css`.

**What that showed: Nebula has no mobile layout.** It renders its desktop
three-pane layout on a 1080x2424 phone - sidebar, channel list and message
pane side by side, with the message pane clipped off the right edge and its
text wrapping one word per line. The title bar also draws under the Android
status bar, so the clock sits on top of "Fancy Mumble": no safe-area inset.
Standard branches on `isMobile` in several components; Nebula only does in
three (`ReactionBar`, `ScreenShareStage`, `ChannelList`).

### APK size

`scripts/android.ps1` builds with `CARGO_PROFILE_DEV_DEBUG=0` and
`CARGO_PROFILE_DEV_STRIP=symbols`. Without that, the debug APK is **438 MB** -
430 MB of it DWARF in `libmumble_tauri_lib.so`, which Gradle's debug packaging
is configured to keep (`jniLibs.keepDebugSymbols`). An emulator whose `/data`
is halfway used refuses it outright:

    INSTALL_FAILED_INSUFFICIENT_STORAGE: Failed to override installation location

`-Symbols` keeps them, for when you need native stack frames out of a Rust
crash. It is a full rebuild each way, because a profile change re-fingerprints
every crate.

Two more traps behind the same error message:

- **Gradle leaves slack in a repackaged APK.** Building over an existing
  `outputs/apk` produced a 438 MB file holding 72 MB of entries - the old
  library still sitting in the zip, unreferenced. The script deletes the
  output directory before building; without that the size fix looks like it
  did nothing, because the APK's size does not move.
- **Pick the AVD by free space.** Of the four here only `Pixel_9` is empty;
  the others carry 4-9 GB in `/data` and refuse a install with
  `INSTALL_FAILED_INSUFFICIENT_STORAGE`. The script prefers `Pixel_9`.

## What was broken

Seven compile errors, all in `crates/mumble-tauri`, all of the same shape - a
desktop-only thing reached from code that Android also compiles:

| Site | Fix |
| --- | --- |
| `commands/stream_view.rs` - `native_stream_audio_playout`, `set_native_stream_audio_volume` | `#[cfg(native_stream_viewer)]` plus the `not(...)` stubs the file's other commands already have |
| `state/audio.rs` x3 - `stream_audio::register` | gated `not(target_os = "android")`, matching the module's own gate in `audio/mod.rs` |
| `commands/window.rs` - `WebviewWindow::set_icon` | split into two `apply_window_icon`; Tauri has no `set_icon` on mobile, and the command's doc comment already promised mobile an `Ok` |
| `commands/game_overlay/mod.rs` - `use fancy_gamedetect::…` | `fancy-gamedetect` moved out of the desktop-only dependency block; the module gates its watcher and window but keeps the config types, so it needs the crate's types everywhere. The crate builds anywhere - `probe/stub.rs` is what macOS already uses |

Nothing here changes desktop behaviour: every edit is a cfg boundary or a
stub on a path that no desktop build takes.

This is not a `wip/voice-latency-2` problem. Each break arrived with the
desktop feature that introduced it, and all three commits are on `develop`:

- `cf9d17e` overlay: draw a card over the game (2026-09-03)
- `a59fa04` chrome: draw the mark, and the taskbar icon with it (2026-09-03)
- `f3d147b` screenshare: share the desktop's audio with the picture (2026-09-05)

CI has an Android job that would have caught all three on the push that
introduced them, and it did not, because **CI has not run since 2026-07-19**
(`gh run list`). So `develop` has not produced an Android build in over a
month, and nothing said so. The fixes here are in the working tree of the
branch they were made on; they belong on `develop`.

## What you will not be testing

Android is missing more than Nebula is. Do not read these as Nebula defects:

- **Voice.** Audio capture and playback are not implemented on Android
  (`vendor/client/ANDROID_DEV.md`); voice controls answer with an error.
- **Screen share, game overlay, Discord presence, the updater.** Desktop-only
  by `#[cfg]`, so their commands do not exist in the Android build.
- **Signal-protocol private chat.** Its `libsignal_bridge.so` is loaded at
  runtime and is not in this APK - CI cross-compiles it and drops it into
  `jniLibs` (`.github/workflows/ci.yml`), which the local build does not do.
  The client treats it as absent, the same as against a server without it.
- **Push notifications.** No `google-services.json`, so Firebase is skipped -
  the Gradle build says so and carries on.

Nebula's own gaps are worth knowing before you go looking for them: it ships no
calendar, scheduled messages, forums or role wizard. That list is
`SUPPORTED` in [`src/ui-flavour.ts`](../src/ui-flavour.ts), which is where to
update it if a pack grows one.

## Prerequisites

Already satisfied on this machine, listed for the next one. The full version is
`vendor/client/ANDROID_DEV.md`.

- Android SDK with platform 36, an NDK, and an x86_64 AVD
- `ANDROID_HOME` set; `scripts/android.ps1` picks the newest installed NDK
  itself rather than pinning CI's version, which is not the one installed here
- Rust targets: `rustup target add x86_64-linux-android` (plus
  `aarch64-linux-android` for a physical phone)
- `cargo install tauri-cli --version "^2"`
- `PROTOC` pointing at a `protoc` binary - `mumble-protocol`'s build script
  needs it for the target build too
