# Android backend progress (final state, 15 Nov ~00:15)

Scripts (scratchpad\agent-android-backend\): emu.ps1 start|stop (fancy-gpui-next, headless, no audio, pins emulator-5554: a phone is plugged in, never use it), apk.ps1 (test program build+package+install), apk-client.ps1 (client APK: com.fancymumble.gpui, adds libc++_shared.so), ui.ps1 (adb driver: tap/swipe/text/key/shot/log/tapText). Env: agent-gpui-android\android-env.ps1 + CARGO_INCREMENTAL=0 + CMAKE_POLICY_VERSION_MINIMUM=3.5 (CMake 4 vs Opus).
Nothing running. Emulator stopped. Captures/logs: F:\fancy-migrate\notes\android\.

## Works on the emulator (test program F:\fancy-migrate\android-hello; gpui-next commits)
- Fling momentum (already worked; Android spline). Fixed: tap that stops a fling clicked (d186ac8).
- Long press = right click with Android timing, haptic, cancel on move/2nd finger (6f372d6).
- Insets: status/nav/cutout + keyboard, animated (0fa77a2; host 5b9bf38).
- Back: Escape to app; unhandled -> moveTaskToBack (0d14d1e).
- Fonts mmapped, system CBDT emoji (8edb285, d0c5cad): PSS 78.9 -> 52.0 MB.
- Keyboard config: suggestions/autocorrect/caps/Send; multi-line; caret by tap; paste (9ba47e4; host 9171fce).
- Lifecycle phases, memory warnings (onTrimMemory), saved state across process death, density/size change (39f1e1e); hardware typing (4dd9c69).
- Boot launch: system refuses starts before boot_completed (not ours). Freeform resize OK. Pinch via `adb emu event send`: safe.
- Services (907c9ad, 9b7e007; host a09e3ae, f723d27): permissions, foreground service + Disconnect, notifications, links, SAF pick, share-in, WebView in sub-windows with postMessage bridge.
- Test program memory: 52.9 MB PSS (mem-hello-after.txt).

## Client
- F:\fancy-migrate\client-android-trial (own repo; port f71ddc0 + 3 patches) and F:\fancy-migrate\android-client (cdylib). Client runs on the emulator, connect screen, desktop layout, 72.4 MB PSS.
- Patches for the port/project: notes\android\client-lib-split.patch, screenshare-gate.patch, engine-log-try-init.patch.
- Phone layout plan: notes\PHONE-LAYOUT.md (with review section on top).

## On the Pixel 7 (another session, 15 Nov ~01:27, at the user's request)
- android-client built for aarch64 (release, android-env.ps1 + CARGO_INCREMENTAL=0 + CMAKE_POLICY_VERSION_MINIMUM=3.5; log F:\fancy-build\android-client-aarch64.log) and installed on the phone (28171FDH2001RC) as com.fancymumble.gpui with a copy of apk-client.ps1 for arm64 (other session's scratchpad\scripts\apk-phone.ps1; your files restored afterwards).
- Starts, renders on Mali-G710 via Vulkan (wgpu picked it over GL). 240 MB PSS of which Graphics 139 MB, Native Heap 33 MB. Desktop layout; the title bar sits under the status bar.
- Pushed (user's request, `develop` only): Fancy-Mumble/gpui (= gpui-next `fancy`), Fancy-Mumble/fancy-android (android-host, android-client, android-hello as subtrees).

## The port landed (15 Nov ~02:30; the port session was shut off, the merge done for it)
- FancyMumble `develop` = 14f49e29 "gpui: on gpui-next, with the work of 14 November carried over", on top of the rearranged tree 7ecc0387 (develop was fast-forwarded from 6f3544b8 to 7ecc0387 first). Made from client-3 `port-2312` (8b79489, the 23:12 merge) replayed onto e6390c2c (00:57) and carried over the rearrangement; landing clone F:\fancy-build\fm-land.
- The client now takes GPUI from git: Fancy-Mumble/gpui branch `develop` (Cargo.lock: 1c42c15). Local GPUI work: a `[patch."https://github.com/Fancy-Mumble/gpui"]` in .cargo/config.toml, not a path in Cargo.toml.
- What the merge carried over (00:57 work vs. the port): player settings/pause/minimise/out-of-sight on the composed player (new player/minimising.rs: one WinEvent hook per thread for all players); flex_shrink_1, paint_image(bounds, bounds, ..), playing.live; build.rs delay-loads uiautomationcore/userenv/winmm (tests/imports.rs).
- gpui-next commit 1c42c15 (pushed to Fancy-Mumble/gpui develop): the 0.2.2 fork's sized path textures (directx_path_target.rs; fast/frame.rs PathSource Sized/Whole). 21 MB vs 31 MB dedicated GPU at 1394x792. Zero-blur shadows needed nothing (upstream draws them).
- Checked: cargo check --all-targets; 862 client tests + imports test; gpui_windows 40 tests; a demo window captured (look.ps1) next to the port's exe.
- Then (~03:00): the library split, the screen-share gate and the engine's try_init landed as FancyMumble `develop` 747b5b08, with what Android (and, for the player page, non-Windows) leaves unused marked `cfg_attr(.., expect(dead_code, reason))` where it is; build.rs delay-loads with rustc-link-arg-bins; the program's own test target is off.
- android-client takes fancy-gpui from FancyMumble `develop` and gpui/gpui_mobile from Fancy-Mumble/gpui `develop` by git (Cargo.lock: 747b5b08, 1c42c15); android-hello the same for GPUI; android-host's build.gradle no longer names F: (output under `-PfancyBuildDir` when given; set in ~/.gradle/gradle.properties on this machine). All three pushed to Fancy-Mumble/fancy-android `develop` (3332e75). client-android-trial is no longer used.
- Checked: android-client built for aarch64 in release from the repositories alone, packaged (apk-phone.ps1) and run on the Pixel 7: Mali-G710 via Vulkan, 125 MB PSS at the server list.

## Remains
- aarch64 check (skipped for disk): `cargo check --target aarch64-linux-android` in android-hello. (Done on the phone build above.)
- Phone layout steps; client wiring to services; saving files (ACTION_CREATE_DOCUMENT); OnBackInvokedCallback for targetSdk 36; screen-share viewer on Android (fancy-screenshare gate inside the crate); phone-only checks (voice with screen off, real Gboard, real share sheet apps).
- Port agent: its `port` branch has my two accidental commits c52c4b2, 480e0e7 (reported).

## Next commands
1. emu.ps1 start; apk.ps1 (test program) or: build android-client (cargo build --offline --target x86_64-linux-android in F:\fancy-migrate\android-client) then apk-client.ps1; adb shell am start -n com.fancymumble.gpui/dev.gpui.mobile.GpuiInputActivity.
2. emu.ps1 stop when done.

## Disk
F:\fancy-build\gpui-android ~6 GB: its deps\ and .fingerprint\ are already gone (not by me), so a rebuild is from scratch anyway; everything but the two .so files (113 MB) can be deleted. android-avd 4.6 GB (keep for the emulator; could be recreated by wiping userdata).
