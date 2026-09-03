# A game overlay for the client: who is talking and the last message, over any game

Research, 2026-09-03. Nothing is built yet; this answers "if and how" and ends in a
recommended design. Facts about the client were verified against the working tree of
`vendor/client` (Tauri 2.10.1 / `tao` 0.34.6, `qt6ui` on cxx-qt 0.7) and the `tao` and
`tauri` sources in the local cargo registry; external claims carry a source in section 11.
Line numbers are as of this date.

## 0. TL;DR

The three requirements (no anti-cheat bans, no antivirus flags, no unexpected side effects)
rule out the way Mumble's own overlay works and leave one workable technique. Nine findings:

1. **Never inject.** Mumble's classic overlay (`mumble_ol.dll` hooked into the game via
   `SetWindowsHookEx`, Present() detoured) is the thing BattlEye blocks by file name, EAC
   reports as an "untrusted system file", CS2 Trusted Mode refuses, and antivirus heuristics
   flag as an injector. Whitelisting exists only for signed vendors who go through each
   anti-cheat's programme; Mumble lost it for months in 2020 over a certificate change.
2. **An external always-on-top, click-through window is the sanctioned technique today.**
   Discord replaced its injected overlay with exactly this in April 2024 ("a permanent
   `HWND_TOPMOST` window glued to whatever window it thinks is a game"). Riot's Vanguard FAQ:
   overlays "should continue to function", memory readers do not, and "there is absolutely
   no allow list". Xbox Game Bar is the same mechanism inside the OS.
3. **The client already has this window.** `commands/draw_overlay/` builds a transparent,
   topmost, click-through, capture-excluded window and follows a target HWND; the Nebula
   `MiniMode` card is the roster UI; `user-talking` and `new-message` are broadcast to every
   webview. The gap is a game detector, an ephemeral show/hide policy, settings, and the Qt
   port (which has no talking state at all).
4. **The window must not look like a cheat overlay.** Anti-cheat overlay detectors enumerate
   windows with `WS_EX_LAYERED | WS_EX_TRANSPARENT` (which is exactly what tao sets for
   click-through) that are topmost and cover the game's client area or more than ~90 % of
   the screen. So: widget-sized (about 320 px wide), never game-sized, hidden when idle, and
   the process never opens a handle to the game beyond `PROCESS_QUERY_LIMITED_INFORMATION`.
5. **The real side effect is presentation, not cheating.** One visible pixel over a game
   forces DWM out of independent flip into composed flip on machines without working MPO;
   that adds a frame of latency and breaks G-Sync/FreeSync in borderless mode. Discord's new
   overlay is criticised for exactly this. Hidden windows cost nothing ("the DWM will still
   use Independent Flip if there's nothing to composite on top of the game"). The design is
   therefore **ephemeral by default**: show while someone talks or a message is fresh, hide
   otherwise, and offer "always" and "never over fullscreen games" as explicit choices.
6. **True exclusive fullscreen cannot be overlaid by any non-injecting overlay.** Discord and
   Game Bar have the same limit. Windows' Fullscreen Optimizations make most DX11/DX12
   titles borderless behind the scenes, so it mostly affects DX9, OpenGL, some Vulkan, and
   users who disabled FSO. Detect it (`SHQueryUserNotificationState` returns
   `QUNS_RUNNING_D3D_FULL_SCREEN`) and tell the user once, rather than fighting it.
7. **Game detection uses only benign signals**: foreground window covers its monitor and
   has no caption; shell notification state is busy; executable path under a store's games
   folder; Windows' own `GameConfigStore` registry list; and the strongest, already in the
   tree: games announcing themselves over Discord Rich Presence to `fancy-presence`. Plus a
   per-executable allow/deny list the user builds from the overlay itself.
8. **Platform reality**: Windows is the target and works fully. macOS works (needs one
   `objc2` call tao does not expose, `fullScreenAuxiliary`). Linux X11 works. Linux Wayland
   cannot do always-on-top through tao at all (no layer-shell), and SteamOS Game Mode has a
   single external-overlay slot that MangoHud already occupies. Those get a hotkey-toggled
   window and honest settings copy, not a heuristic.
9. **Cost**: a second WebView2 is 70-150 MB of private working set in release builds, so the
   Tauri overlay window is created when a game is detected and destroyed when none has been
   for a while. The Qt port's overlay is a second `QQuickWindow` with five flags and is
   cheap, but needs the talking-state derivation lifted into `mumble-protocol` first.

## 0.1 Status (2026-09-03)

| Item | State |
| --- | --- |
| Research and design | This document |
| Proof-of-concept plan and the game-detection heuristic | `docs/GAME-OVERLAY-POC-PLAN.md` (same day) |
| Any code | None. |

## 1. The ask

An overlay the client can draw over any application or game, with a heuristic for where it
is useful, showing who is talking and the last message in the user's channel. Hard
requirements: it must not get the user banned, must not be flagged by antivirus, and must
not have unexpected side effects. Both front-ends matter: the Tauri client and the Qt6 port
(`vendor/client/crates/qt6ui`), of which only one runs at a time (`ui_mode.rs` /
`qt6ui/src/mode.rs` hand off via a marker file).

## 2. The four ways to draw over a game

| | A. In-process injection | B. External topmost window | C. OS-blessed hosts | D. Not an overlay |
| --- | --- | --- | --- | --- |
| Who uses it | Mumble classic overlay, Steam, Overwolf, NVIDIA App, Discord until 2024 | Discord since April 2024, Xbox Game Bar, ForceComposedFlip, cheat ESP overlays | Game Bar widget SDK (Windows), gamescope external-overlay slot (SteamOS), Vulkan implicit layers (MangoHud, Linux) | Toasts, sound cues, hardware displays |
| How | Load a DLL into the game (`SetWindowsHookEx`, `CreateRemoteThread`, or a launcher), detour `IDXGISwapChain::Present` / `wglSwapBuffers` / `vkQueuePresentKHR`, draw inside the frame | A separate window with `WS_EX_TOPMOST`, `WS_EX_LAYERED`, `WS_EX_TRANSPARENT`, `WS_EX_NOACTIVATE`, composited by DWM | A host process the OS or Valve owns composites your content | Nothing drawn over the game |
| Exclusive fullscreen | Yes | No | Game Bar: only via FSO; gamescope: yes | n/a |
| Anti-cheat | Blocked unless the vendor whitelists your signed DLL; the block itself is not a ban (BattlEye FAQ) but the user sees "Blocked loading of file" and it stops working after every certificate change | Not code in the game; Vanguard, VAC and BattlEye tolerate it; detectable as *a* window, so it must not resemble an ESP overlay (section 3.2) | Trusted by construction | None |
| Antivirus | Injector heuristics; Mumble and every small overlay project collects false positives | Nothing to flag | Nothing | Nothing |
| Side effects | Crashes the game when the hook fights another overlay; per-game breakage on updates | Composed-flip / VRR interaction (section 4.2); z-order fights; invisible over true FSE | Windows-only UWP packaging (Game Bar); one slot, taken (gamescope) | Toasts are suppressed by Focus Assist during games, which is the problem the overlay solves |
| Verdict | **No.** Fails all three requirements at once. | **Yes**, with the constraints in sections 3 and 4. | Game Bar widget: viable Windows-only extra, not the base. gamescope: unavailable in practice. | Fallback when B cannot show (true FSE, Wayland). |

### 2.1 Why not injection, in one paragraph

Mumble 1.3.1 (June 2020) changed its code-signing certificate; BattlEye started printing
"Blocked loading of file: mumble_ol_x64.dll" in Rainbow Six Siege and PUBG until the new
certificate was whitelisted (mumble issue #4286). EAC surfaces the same class of thing as
"Untrusted System File". CS2 Trusted Mode blocks all third-party DLLs unless the user adds
`-allow_third_party_software`, which drops them out of Trusted matchmaking. FACEIT AC only
tolerates overlays because it launches CS2 with that flag itself. Roblox's Hyperion crashes
the client on any code it dislikes and publishes nothing. A DLL that hooks Present() and is
loaded via `SetWindowsHookEx` is also the textbook antivirus injector signature. None of
that can be engineered around by a small project; it is a per-vendor business relationship
plus an EV certificate, and it still breaks on every certificate rotation.

### 2.2 Why an external window is enough

Discord's April 2024 overlay rewrite is the proof: "The new Discord overlay no longer uses
DLL injection, and is instead a permanent `HWND_TOPMOST` window glued to whatever window it
happens to think is a game" (McClure). Discord's own support page: works in windowed and
borderless fullscreen, not in true fullscreen, and is "expected to be compatible with
nearly all games". Xbox Game Bar is the same mechanism: "when an overlay such as the Game
Bar is present, the DWM reassumes control of the display, and a slight performance overhead
is incurred so that the overlay can be composited on top of the game in a safe and stable
way" (DirectX blog). The client's `draw_overlay` module already does it.

## 3. Anti-cheat and antivirus, per technique

### 3.1 Vendor stances

| Anti-cheat | Injected DLL | External topmost window | Source |
| --- | --- | --- | --- |
| Riot Vanguard (LoL, Valorant) | Kernel driver, blocks; no allow list at all | "Overlays and internal tools using the API, game client, and in-game APIs should continue to function"; "External tools reading memory will no longer work". A developer's direct question about transparent topmost windows (devrel issue #1071) was closed "unsuitable" without an answer | Vanguard FAQ; devrel #1071 |
| BattlEye | Blocks unknown DLLs by file, prints "Blocked loading of file"; "You won't risk getting banned for seeing these messages" | Not a DLL, not blocked | BattlEye FAQ; mumble #4286 |
| Easy Anti-Cheat | "Untrusted system file" for unsigned/unknown DLLs | Community reverse-engineering says EAC enumerates windows with layered/transparent styles and sizes and reports them to the game server; the game decides. Steam, Discord and Game Bar windows exist on every EAC machine, so a widget-sized window is normal | Microsoft Q&A threads; guidedhacking (community claim) |
| VAC / CS2 Trusted Mode | Blocked unless `-allow_third_party_software` | Windows are not scanned for; Trusted Mode stays on | dotesports; NVIDIA KB |
| FACEIT AC | Launches with `-allow_third_party_software`, warns on unknown drivers | Overlays work "but can result in performance issues" | FACEIT support |
| Roblox Hyperion | Crashes client on disliked code | Undocumented; treat as unknown, offer per-app disable | Roblox wiki |

Legitimacy under Vanguard comes from behaviour, not signature: no code in the game, no
memory reads, no input automation. That is the bar to design to.

### 3.2 What overlay detectors actually look for

Open-source detectors (the "Sagaan" overlay detector) and the anti-cheat community's own
write-ups describe the same signature: `EnumWindows`, then windows that are `WS_VISIBLE`,
`WS_EX_LAYERED`, `WS_EX_TRANSPARENT`, usually `WS_EX_TOPMOST`, and **at least as big as the
game's client area** or more than 90 % of the screen. The last clause is the discriminator
between a chat widget and an ESP overlay. tao's click-through sets exactly
`WS_EX_TRANSPARENT | WS_EX_LAYERED` (`tao-0.34.6/src/platform_impl/windows/window_state.rs:286`),
so the style bits are unavoidable and shared with Discord; what we control is geometry,
visibility and behaviour:

- Widget-sized, never sized to the game. The `draw_overlay` placement code that pins a
  window over the whole captured monitor is the one thing **not** to reuse.
- Hidden (`ShowWindow(SW_HIDE)`, not merely transparent) whenever there is nothing to show
  in the default mode, so it is not even enumerated as visible.
- No handle to the game process beyond `PROCESS_QUERY_LIMITED_INFORMATION`, which the tree
  already uses for the same purpose in `fancy-audio-device/src/wasapi.rs:144`. Never
  `PROCESS_VM_READ`, never `EnumProcessModules` on the game, never `ReadProcessMemory`.
  Kernel anti-cheats strip and log handle requests to the game; asking is the tell.
- No hooks. `SetWindowsHookEx` with a DLL injects. `SetWinEventHook` with
  `WINEVENT_OUTOFCONTEXT` does not inject, but polling `GetForegroundWindow` at 250-500 ms
  is simpler and is the precedent in `draw_overlay/win_tracker.rs`.
- Global hotkeys stay on `tauri-plugin-global-shortcut` (`RegisterHotKey`), not a
  low-level keyboard hook.

### 3.3 Antivirus

Nothing in approach B is a heuristic trigger: creating windows, reading window rects and
styles, `SHQueryUserNotificationState`, registry reads, and `QueryFullProcessImageNameW`
are what every launcher and screenshot tool does. The audit that matters is negative: the
client currently contains no `OpenProcess` with `VM_READ`, no `SetWindowsHookEx`, no
`ReadProcessMemory`, no `CreateFileMapping` (verified by grep); the overlay must keep it
that way. Section 9 lists the release-binary checks.

## 4. Side effects of a topmost window, and how each is bounded

### 4.1 True exclusive fullscreen: the overlay is invisible

A DX9/OpenGL/Vulkan-FSE game, or a DX11 game with Fullscreen Optimizations disabled, owns
the display; no composited window shows. Discord and Game Bar share the limit. Handling:
detect `QUNS_RUNNING_D3D_FULL_SCREEN`, keep the window hidden (showing it can cause the
game to drop out of exclusive mode), and surface one non-nagging hint in the client:
"overlay cannot show over this game in exclusive fullscreen; switch to borderless". Users
who care already run borderless because Discord, Game Bar and VRR need it too.

### 4.2 Independent flip, MPO, VRR and latency (the one that bites)

Mechanism, from McClure's analysis of Discord's overlay: "If even a single pixel of another
app is displayed over the game, then in order to display that pixel, the compositor has to
composite the window outputs together onto a secondary buffer, which must then be presented
at the native refresh rate of the monitor because it has inputs from two different programs
at different refresh rates, thus breaking GSync/FreeSync." Multi-Plane Overlay (MPO) avoids
this by giving the game and the overlay separate hardware planes, but MPO is the feature
users disable because of NVIDIA and AMD flicker, and on 24H2 the registry switch
(`OverlayTestMode=5`, now also `OverlayMinFPS=0`) is a common tweak. So MPO cannot be
assumed. The complementary fact, from ForceComposedFlip: "Even with MPO disabled, the DWM
will still use Independent Flip if there's nothing to composite on top of the game." A
hidden window costs nothing; a visible one costs composition and VRR on MPO-less machines.

Bounds:

- **Ephemeral by default** ("while active"): the window is shown when a talking edge or a
  fresh message arrives and hidden a few seconds after the last activity. Games that get
  no voice traffic never leave independent flip.
- **"Always" mode** is opt-in, with the setting copy stating the VRR trade-off.
- **"Never over fullscreen games"** mode keeps the widget for windowed apps only.
- Verification with PresentMon (section 9): "Hardware: Independent Flip" with the overlay
  hidden, and the measured delta with it visible, on an MPO-disabled machine.

### 4.3 Focus stealing

The draw overlay uses `.focused(false)`, which only avoids activation at creation. The game
overlay needs `.focusable(false)`, which tao maps to `WS_EX_NOACTIVATE`
(`window_state.rs:297`) so the window can never take keyboard focus from the game, plus
`set_ignore_cursor_events(true)` so it never takes the mouse. On Linux tao passes
`accept_focus(focusable && focused)` at creation (`linux/window.rs:87`); the no-focus popup
problem (tauri #11814) is unresolved for windows that need input, which this one does not.

### 4.4 Screen capture and streaming

`WindowExt::set_excluded_from_capture` (`platform/window/windows.rs:279`) already applies
`WDA_EXCLUDEFROMCAPTURE`, so the overlay is absent from the client's own screen share, OBS
and Game Bar recordings, and from anti-cheat screenshot features. Default on; a streamer
who wants the roster visible in the stream flips it off.

### 4.5 Memory and GPU

A WebView2 window is a process: 70-150 MB private working set in release builds (measured
earlier for this client). Bounds: create the window only after a game is detected, destroy
it after N minutes without one, and call the existing
`ICoreWebView2_19::SetMemoryUsageTargetLevel(LOW)` path while hidden. The page is a plain
React tree with no animation except the 120 ms talking-ring transition already in
`UserAvatar`. If that is still too heavy, the fallback is a native Direct2D/DirectComposition
window in Rust; it is more work (text, avatars) and not needed to validate the design.

### 4.6 The rest

| Effect | Bound |
| --- | --- |
| Games that re-assert their own topmost | Re-`SetWindowPos(HWND_TOPMOST)` with `SWP_NOACTIVATE` on each foreground poll tick, as ForceComposedFlip does every 500 ms |
| HDR games | The SDR overlay is tone-mapped by DWM; readable, colours slightly off; test, do not fight |
| `tauri-plugin-window-state` restoring stale geometry | Add the label to `.with_denylist(...)` in `app/builder.rs:63`; `draw-overlay` is missing there today |
| Multi-monitor and DPI | Place on the game's monitor (`MonitorFromWindow` on the foreground HWND) in physical pixels, the way `draw_overlay` sets position after build |
| Windows 11 rounded corners/border on the widget | `platform::strip_system_chrome` already exists |
| Alt-tab / taskbar noise | `skip_taskbar(true)` plus `WS_EX_TOOLWINDOW` semantics tao applies for it |
| Presentations, remote desktop | `QUNS_PRESENTATION_MODE` suppresses; RDP sessions show it like any window |

## 5. Detecting "a game where an overlay is useful"

All signals are read-only, need no handle to the game beyond limited-information, and are
cheap enough to poll every 500 ms from a Tokio task (the `win_tracker` pattern).

| # | Signal | API | Meaning | Cost / risk |
| --- | --- | --- | --- | --- |
| 1 | Foreground window is fullscreen-ish | `GetForegroundWindow`, `GetWindowRect`, `MonitorFromWindow` + `GetMonitorInfoW`, `GetWindowLongPtrW(GWL_STYLE)` lacks `WS_CAPTION`/`WS_THICKFRAME` | Borderless or FSO game, or a fullscreen video | none |
| 2 | Shell notification state | `SHQueryUserNotificationState` | `QUNS_BUSY`: fullscreen app (FSO games return this, not the D3D value); `QUNS_RUNNING_D3D_FULL_SCREEN`: true exclusive, overlay cannot show; `QUNS_PRESENTATION_MODE`: never show. PowerToys' Command Palette uses exactly this split | none; `Win32_UI_Shell` already enabled |
| 3 | Executable identity | `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `QueryFullProcessImageNameW` (pattern in `wasapi.rs:144`) | Path under `steamapps\common`, `Epic Games`, `GOG Galaxy\Games`, `Riot Games`, `Battle.net`, `WindowsApps`, `XboxGames`; exclusions: own pid, `explorer.exe`, browsers unless opted in | none |
| 4 | Windows' own game list | `HKCU\System\GameConfigStore\Children\*\MatchedExeFullPath` | Executables Game Bar / FSO has classified as games | needs the `Win32_System_Registry` feature |
| 5 | The game says so | `fancy-presence`: `PresenceEntry { application_id, pid }` + `Activity.name`, already emitted as `rich-presence-changed` | A process publishing Discord Rich Presence with a pid is a game by definition | already in the tree |
| 6 | Steam `RunningAppID` | registry | Reported stuck at 0 since the 2023 Steam UI; skip | unreliable |
| 7 | User rules | preferences | "Always for this exe" / "never for this exe", offered from the overlay's own settings row | none |

Decision: **show-eligible** when the foreground process is not ours, not on the user's deny
list, the shell is not in presentation mode, and either the user allow-listed it or
(signal 1 or 2 is fullscreen-ish **and** any of 3, 4, 5 says "game"). A fullscreen video
player therefore does not trigger it unless the user asks. **Cannot show** when
`QUNS_RUNNING_D3D_FULL_SCREEN`: stay hidden, record the hint. The hotkey overrides
eligibility both ways.

Other platforms: macOS uses `NSWorkspace.frontmostApplication` plus
`CGWindowListCopyWindowInfo` for a screen-sized window and the bundle path for the store
heuristic. Linux X11 reads `_NET_ACTIVE_WINDOW` and `_NET_WM_STATE_FULLSCREEN` plus
`/proc/<pid>/exe`. Wayland exposes no foreground window to clients, so there the overlay is
hotkey-driven or "always", and signal 5 (presence) is the only automatic one.

## 6. Platform matrix

| Platform | Topmost | Click-through | No focus | Capture exclusion | Foreground detection | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Windows 10/11 | `WS_EX_TOPMOST` via `always_on_top` | `WS_EX_TRANSPARENT\|LAYERED` via `set_ignore_cursor_events` | `WS_EX_NOACTIVATE` via `focusable(false)` | `WDA_EXCLUDEFROMCAPTURE` (exists) | full (section 5) | **primary** |
| macOS | `NSFloatingWindowLevel` via `always_on_top`; needs `NSWindowCollectionBehaviorFullScreenAuxiliary \| CanJoinAllSpaces` to appear over a fullscreen game's Space; tao only sets `CanJoinAllSpaces` (`visible_on_all_workspaces`), so one `objc2` call in `platform/window/macos.rs` | `setIgnoresMouseEvents` (exists) | `NSPanel`-style non-activating needs the same objc2 hook | `NSWindowSharingNone` (exists) | AppKit APIs, no anti-cheat concern | works, second |
| Linux X11 / XWayland | `gtk_window_set_keep_above` | GDK input region (exists) | `accept_focus(false)` at creation | not supported (`WindowExtError::Unsupported`) | EWMH atoms | works |
| Linux Wayland (GNOME, KDE, wlroots) | **not possible through tao** (tauri #3117 / tao #1134); layer-shell would fix it on KDE/wlroots only and tao does not expose it | input region works | works | no | none | hotkey-driven window only; say so in settings |
| SteamOS Game Mode (gamescope) | single `GAMESCOPE_EXTERNAL_OVERLAY` slot, occupied by mangoapp | n/a | n/a | n/a | n/a | not available |
| Android | n/a | | | | | none |

## 7. What the client already has

| Fact | Where |
| --- | --- |
| Transparent + topmost + click-through + capture-excluded window builder, single-instance replace, physical placement after build | `crates/mumble-tauri/src/commands/draw_overlay/mod.rs:109-138` |
| HWND-following 100 ms poll task, `EnumWindows` search, own-pid exclusion | `commands/draw_overlay/win_tracker.rs` |
| `WindowExt::set_excluded_from_capture`, `set_aspect_ratio`; per-OS backends | `src/platform/window/{mod,windows,macos,linux}.rs` |
| `strip_system_chrome` for frameless windows | `src/platform/mod.rs:162` |
| Per-window capability file precedent | `capabilities/draw-overlay.json` |
| window-state plugin denylist (overlay labels must be added) | `src/app/builder.rs:52-65` |
| Global shortcuts (`RegisterHotKey`-based plugin), bindings framework | `ui/src/core/features/settings/shortcutHelpers.ts` (`ShortcutBindings`, `GLOBAL_SHORTCUT_COMMANDS`) |
| `user-talking` event, tuple `(session, talking)`, emitted outside the state lock | `src/state/event_handler.rs:268`; local user in `state/audio_tasks.rs:177,205`; sweep in `state/audio.rs:382` |
| `new-message` event has no body; the notification path has title, stripped body and avatar | `src/state/handler/text_message.rs:81` and `:143` (`emit_channel_notification`) |
| `voice-state-changed`, `mic-amplitude`, own deafen via `selectSelfDeafened` | `state/audio.rs:180`, `audio_tasks.rs:336`, `ui/src/core/store/voiceSelectors.ts` |
| Roster card UI: `MiniMode` (320 px, occupants with talking ring + bars), `UserAvatar`, `TalkingBars` | `ui/src/ui/nebula/components/chrome/MiniMode.tsx`, `components/primitives/` |
| Overlay page precedent (transparent document, `take_*_context` bootstrap) | `ui/src/ui/standard/pages/DrawOverlayPage.tsx`; window-kind dispatch in `ui/standard/App.tsx:64-112`, `ui/nebula/index.tsx:30-42` |
| Cross-window state handshake (`sync-request` / `snapshot`) | `ui/src/ui/standard/components/chat/drawing/DrawingOverlay.tsx:265-281` |
| Rich-presence observation of games | `crates/fancy-presence` (`PresenceEntry`, `Activity.name`), event `rich-presence-changed` (`src/state/presence.rs:22`) |
| Only `OpenProcess` in the tree, limited-information | `crates/fancy-audio-device/src/wasapi.rs:144` |
| `windows-sys` features enabled | `Foundation, Graphics_Dwm, UI_WindowsAndMessaging, UI_Shell, Graphics_Gdi, System_Threading, System_SystemInformation` (`mumble-tauri/Cargo.toml:172`) |
| Preferences (`UserPreferences` + `DEFAULTS`), Nebula settings nav and search index | `ui/src/core/types/preferences.ts`, `core/preferencesStorage.ts`, `ui/nebula/components/settings/{SettingsNav,settingsSearchIndex}.ts(x)` |
| Qt port: one `ApplicationWindow` (`Qt.Window \| Qt.FramelessWindowHint`), no talking state anywhere, audio frames reach `QtEventHandler::on_udp_message` unmarked | `crates/qt6ui/qml/main.qml:20`, `crates/qt6ui/src/events.rs:409` |
| Shared engine with no talking derivation: `EventHandler::on_udp_message(UdpMessage::Audio { sender_session, is_terminator, .. })` | `crates/mumble-protocol/src/event.rs` |

## 8. Recommended design

### 8.1 Shape

A `commands/game_overlay/` module modelled on `draw_overlay/`, one window labelled
`game-overlay`, built with

```text
decorations(false) shadow(false) transparent(true) always_on_top(true)
skip_taskbar(true) resizable(false) focusable(false) visible_on_all_workspaces(true)
+ set_ignore_cursor_events(true) + set_excluded_from_capture(pref, default true)
+ strip_system_chrome + window-state denylist + capabilities/game-overlay.json
```

sized to its content (320 px wide, height from occupant count, capped at about 8 rows),
anchored to a user-chosen corner of the game's monitor with a margin, in physical pixels.

### 8.2 Lifecycle

```text
detector (500 ms poll, Tokio)         overlay window
  no game ........................... absent (destroyed after 3 min idle)
  eligible game, mode=whileActive ... created hidden; shown on talking edge / fresh
                                      message; hidden 4 s after last activity
  eligible game, mode=always ........ shown
  QUNS_RUNNING_D3D_FULL_SCREEN ...... hidden; one hint event to the main window
  presentation mode / own window fg . hidden
  hotkey ............................ toggles a manual override until next game change
```

The detector runs in Rust and emits `game-overlay-state` `{ visible, reason, exe }` so the
main window can show the hint and the settings page can show "detected: <exe>".

### 8.3 Content and data

Rows: each channel occupant as `UserAvatar(talking) + name + TalkingBars`, own mute/deafen
state as icons, and below it the last channel message: sender, body stripped with the
existing `strip_html_tags`, clamped to two lines, fading after 10 s. No controls: the window
is click-through.

Data path: the page listens to `user-talking`, `voice-state-changed` and `new-message`
directly (Tauri broadcasts to every webview), calls `get_messages` for the body on
`new-message`, and bootstraps from a new Rust command `game_overlay_snapshot` returning
`{ channel_name, occupants, talking_sessions, own_session, last_message }`. Rust already
holds all of it, which is simpler than the draw overlay's cross-window handshake.

### 8.4 Shared core and the Qt port

Lift the talking derivation (frame in / terminator / idle sweep, today duplicated in
`event_handler.rs` and `audio.rs`) into `mumble-protocol` as a `TalkingTracker` with an
`on_talking(session, bool)` callback, so `qt6ui` gets it for free. The Qt overlay is a
second QML `Window` with `Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint |
Qt.WindowTransparentForInput | Qt.WindowDoesNotAcceptFocus`, `color: "transparent"`, fed by
one new `#[qsignal] talking(session, bool)` and the existing `chat_message` signal; capture
exclusion via `winId()` + `SetWindowDisplayAffinity`, and the same detector crate.

### 8.5 Settings and hotkey

`UserPreferences.overlay = { mode: "off" | "whileActive" | "always", corner, showLastMessage,
hideFromCapture, appRules: Record<exePath, "allow" | "deny"> }`; a `toggleOverlay` binding
in `ShortcutBindings` plus one Tauri command. A Nebula settings page, `SETTINGS_NAV` entry,
search-index entry, locale keys in four languages, and the Standard mirror.

### 8.6 Phases

| Phase | Deliverable |
| --- | --- |
| 1 | Windows, Tauri: window + hotkey + snapshot command + page; manual only |
| 2 | Detector with signals 1-5 and 7, ephemeral policy, hint on exclusive fullscreen, settings page |
| 3 | PresentMon and Process Monitor verification (section 9); tune sizes and timings |
| 4 | macOS (`fullScreenAuxiliary` objc2 call) and Linux X11; Wayland copy in settings |
| 5 | `TalkingTracker` into `mumble-protocol`; Qt overlay window |

## 9. Verification

Requirement 1, anti-cheat: Process Monitor filtered on the client's pid while a game runs
shows no `Process Open` on the game with `VM_READ`/`VM_OPERATION`, and Process Explorer
shows no client DLL in the game. CS2 with Trusted Mode on: overlay visible, Trusted Mode
still reported on. A Vanguard title: overlay visible, no `VAN` restriction code. Bans cannot
be proven negative; what can be shown is that the process does nothing but own a window.

Requirement 2, antivirus: VirusTotal on the release installer before and after; Defender
with Attack Surface Reduction rules in audit mode logs nothing new.

Requirement 3, side effects, on an MPO-disabled machine (`OverlayTestMode=5`): PresentMon
reports "Hardware: Independent Flip" for the game while the overlay is hidden, and the
frame-time delta with it shown is recorded in the doc; a VRR monitor's OSD refresh readout
follows the game rate while hidden. A DX9 game in exclusive fullscreen: the overlay never
shows and the hint appears once. Keyboard input keeps reaching the game while the overlay
pops up (WS_EX_NOACTIVATE). The client's own screen share does not contain the overlay.

E2E: a `game-overlay` test in this repo opens the window through `TauriApp.invoke`
(`src/app.ts:212`), drives an `audio-bot` speaker (`src/util/audio-bot.ts`), switches
WebDriver to the overlay's window handle (no test does this yet; `getAllWindowHandles` is
the mechanism) and asserts the speaker's name and the last message text via new test ids in
`ui/src/core/testids.ts`, which has no talking ids today.

## 10. Assumptions made where the brief was open

- "Any application" means the widget may also sit over non-games when the user allow-lists
  them or picks "always"; the automatic heuristic only fires for games, because a fullscreen
  video or presentation is where an unexpected window is least welcome.
- Read-only overlay: no mute button, because click-through and no-focus are what keep it
  harmless; controls stay on the hotkeys and in mini mode.
- Windows first; the Qt port follows the Tauri client once the design is validated.
- The Game Bar widget SDK (still maintained, Sept 2024 SDK 7.2, with a "voice chat" activity
  API and pinned click-through transparent widgets) is a possible Windows extra, not the
  base, because it needs a Store-packaged UWP widget and IPC to the client.

## 11. Sources

- Discord support, Known Issue: Game Overlay (rollout 2024-04-15; windowed and borderless
  only): https://support.discord.com/hc/en-us/articles/25289844838551--Known-Issue-Game-Overlay
- Erik McClure, "The New Discord Overlay Breaks GSync and Borderless Optimizations":
  https://erikmcclure.com/blog/discord-overlay-breaks-gsync/
- Riot Games, Vanguard FAQ for Third Party Applications: https://www.riotgames.com/en/DevRel/vanguard-faq
- Riot developer-relations issue #1071, "Stance on transparent topmost overlay windows"
  (closed, unanswered): https://github.com/RiotGames/developer-relations/issues/1071
- mumble-voip/mumble #4286, BattlEye blocking `mumble_ol_x64.dll` after the 1.3.1 certificate
  change: https://github.com/mumble-voip/mumble/issues/4286
- BattlEye FAQ ("Blocked loading of file" is not a ban): https://www.battleye.com/support/faq/
- Easy Anti-Cheat "Untrusted System File" threads: https://learn.microsoft.com/en-us/answers/questions/3944541/untrusted-system-file-easy-anti-cheat
- CS2 Trusted Mode and `-allow_third_party_software`: https://dotesports.com/counter-strike/news/how-to-allow-third-party-software-in-cs2
- FACEIT support, FPS drops / input lag (launches with third-party software allowed):
  https://support.faceit.com/hc/en-us/articles/360015781379-FPS-drops-input-lag-issues
- Overlay-window detection heuristics: https://github.com/ExpLife0011/SAC-Sagaan-AntiCheat-OverlayDetector-
  and https://en.ciholas.fr/external-overlays-without-window/
- Microsoft DirectX blog, "Demystifying Fullscreen Optimizations": https://devblogs.microsoft.com/directx/demystifying-full-screen-optimizations/
- ForceComposedFlip (independent flip survives with nothing on top): https://github.com/fernandoenzo/ForceComposedFlip
- MPO status and registry switches on 24H2: https://learn.microsoft.com/en-us/answers/questions/3881462/how-can-i-disable-windows-mpo-in-2025-24h2-windows
- `SHQueryUserNotificationState` returning `QUNS_BUSY` for FSO games: https://learn.microsoft.com/en-us/answers/questions/1086527/shqueryusernotificationstate-returns-quns-busy-ins
- PowerToys PR #45891, fullscreen detection split: https://github.com/microsoft/PowerToys/pull/45891
- `GameConfigStore\Children\MatchedExeFullPath` as a game list: https://github.com/seerge/g-helper/issues/3935
- Steam `RunningAppID` stuck at 0: https://github.com/ValveSoftware/steam-for-linux/issues/9672
- Xbox Game Bar SDK changelog (Sept 2024): https://learn.microsoft.com/en-us/gaming/game-bar/changelog
- gamescope single external overlay slot: https://github.com/flightlessmango/MangoHud/issues/775
- Tauri always-on-top on Wayland: https://github.com/tauri-apps/tauri/issues/3117 and https://github.com/tauri-apps/tao/issues/1134
- Tauri Linux window without focus (open): https://github.com/tauri-apps/tauri/issues/11814
- macOS `fullScreenAuxiliary`: https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/fullscreenauxiliary
- Fred Emmott, "In-Game Overlays: How They Work" (injection taxonomy): https://fredemmott.com/blog/2022/05/31/in-game-overlays.html
- tao 0.34.6 style mapping: `platform_impl/windows/window_state.rs:262,286,297`,
  `platform_impl/linux/{window.rs:87,193,197, event_loop.rs:443}`, `platform_impl/macos/window.rs:289,968,1537`
