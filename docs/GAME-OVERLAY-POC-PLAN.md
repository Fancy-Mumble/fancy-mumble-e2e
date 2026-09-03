# Game overlay proof of concept: architecture, and a heuristic that only fires for games

Plan, 2026-09-03. Follows `docs/GAME-OVERLAY-RESEARCH.md`, which settled the technique (an
external always-on-top, click-through window; never injection). This document plans the
proof of concept and designs the game detector; section 0.2 records what was then built.
Client facts were verified against the `vendor/client` working tree; Discord facts come
from its public detectable-games endpoint, its support pages, and third-party analysis
(section 10).

## 0. TL;DR

1. **Three pieces, Windows and Tauri only for the PoC**: a `fancy-gamedetect` crate (pure
   Rust, no Tauri, modelled on `fancy-presence`), a `commands/game_overlay/` module (window
   lifecycle, cloned from `draw_overlay/`), and a `GameOverlayPage.tsx` (roster + last
   message). macOS, Linux and the Qt port come after the PoC proves the heuristic.
2. **Shadow mode first.** The detector ships before the window does: it classifies the
   foreground app every 500 ms and shows its verdict and reasons in a diagnostics panel
   under Settings. The heuristic gets tuned on real machines before anything is drawn.
3. **Discord's detector is a list plus a manual "Add it".** It matches running processes
   against a server-side database of about ten thousand games (executable path fragments,
   launcher flags, per-game overlay flags), lets the user register any running app as a
   game, and turns the new overlay on for every detected game with a per-game toggle. We
   copy that shape but replace the central list with **local evidence**: the launcher
   manifests already on the disk, Windows' own game registry, Rich Presence, engine window
   classes, and rendering shape. Optionally, off by default, Discord's public list.
4. **A scored classifier with hard vetoes.** Positive evidence adds weight (installed
   under a store, Windows remembers it as a game, publishes presence, engine window class,
   borderless fullscreen). A deny-list of desktop software (shell, browsers, office, IDEs,
   CAD and creative tools, comms, remote desktop, media players, game *editors*, launchers)
   vetoes outright. User rules override everything. The threshold is deliberately high:
   a false negative costs a hotkey press, a false positive puts a window over someone's CAD.
5. **Ask once, like Game Bar.** For a "probably a game" verdict the main window asks once:
   "Show the voice overlay over `<exe>`?" The answer becomes a rule. That is Discord's
   "Add it" and Game Bar's "Remember this is a game" folded into one prompt.
6. **Exit criteria**: verdicts correct on the team's machines for a week of shadow mode
   (no false positive on a productivity app, games caught), the window shows over a
   borderless game within 300 ms of a talking edge and never takes focus, Process Monitor
   shows no game handle beyond limited information, and PresentMon shows independent flip
   while hidden.

## 0.2 Status (2026-09-03)

Built the same day, for Nebula on Windows. Where the built thing diverges from the plan
below, the plan has been corrected rather than left to rot.

| Milestone | State | Where |
| --- | --- | --- |
| M0 detector + diagnostics | **Landed** | `crates/fancy-gamedetect/` (41 tests); panel in `OverlaySettings.tsx` |
| M1 window + page | **Landed** | `crates/mumble-tauri/src/commands/game_overlay/`; `ui/nebula/components/overlay/GameOverlayPage.tsx` |
| M2 policy, ask-once, settings | **Landed** | `watcher.rs`; `GameOverlayPrompt.tsx`; `core/features/overlay/gameOverlay.ts` (8 tests) |
| M3 PresentMon / Process Monitor measurements | Not started | section 9 |
| M4 e2e test in this repo | Not started | section 9 |
| macOS, Linux, Qt port | Not started | out of PoC scope by design |

Corrections the build forced:

- **A launcher installed under a game store beats every name-based rule.** The Minecraft
  Launcher ships as `C:\XboxGames\Minecraft Launcher\content\minecraft.exe`: it scores
  +60 from E1 and is called `minecraft.exe`, so neither the deny-list of executable names
  nor the launcher-executable list in section 3.3 catches it. The veto is now derived from
  the *path* - any directory segment containing `launcher` or `bootstrapper` - which is
  Discord's `is_launcher` flag computed rather than looked up. The file name never counts,
  so a game called `Rocket Launcher.exe` is still a game.
- **The window must be born visible.** The plan had it created hidden and shown on demand,
  which is right for the compositor and wrong for WebView2: a *transparent* webview window
  hidden before it has ever painted comes back blank when shown - the same failure the main
  window hits on restore from the taskbar. The window is now created visible and only starts
  being hidden once the page has reported (`game_overlay_ready`) that it mounted. Nothing is
  lost: the page renders an empty tree when it has nothing to say, so the window is invisible
  in that window of time anyway.
- **The local user's own talking is not in `talking_sessions`.** That set holds *remote*
  speakers only; the local edge is emitted straight to the frontend and never recorded, so
  "is anyone talking" answered *no* in a channel where you are the one speaking - and the
  "while talking" mode therefore never showed the overlay at all. `AppState` now carries a
  lock-free `local_talking` flag, set on the same two edges that already emit the event
  (an atomic, not a field on `SharedState`: taking that lock in the outbound audio loop is
  how the mixer starts dropping samples). It also fixes the roster snapshot, which never
  rang your own avatar.
- **A poll cannot ask "is anyone talking" in the present tense.** The activity check read a
  momentary flag every 500 ms, so any utterance shorter than the tick - which is most of
  them, and nearly all of them under voice activation - fell between two polls and was never
  seen. Talking edges are now timestamped and the check asks how long ago, with a 1.5 s
  grace comfortably wider than the poll interval.
- **Hiding a webview before its first paint strands it for good.** The "born visible" fix
  above introduced its own deadlock: the window could still be hidden by the *no game in
  the foreground* branch while the page was still loading - which happens the moment you
  alt-tab to the client to look at the settings. A hidden `WebView2` stops painting, so it
  never reports ready, so the ready gate returned early forever and the overlay was never
  shown again. Every hide is now gated on readiness, `shown` is read back off the window
  rather than tracked separately, and the readiness signal is sent from a wrapper around the
  page rather than from the page itself, so a page that fails to render cannot strand it.
- **A secondary window needs `store:default` or it renders nothing at all.** Every window
  boots through `UiRoot`, which resolves the UI pack by reading `preferences.json` through
  the store plugin. The overlay's capability granted only `core:default` and the event
  permissions, so that read was refused by the ACL, the design never resolved, `UiRoot`
  returned `null` forever, and the window was a correctly-placed, correctly-shown,
  permanently empty rectangle. Nothing in the failure names the ACL - the page simply never
  mounts. (`capabilities/draw-overlay.json` has the same gap and presumably the same
  symptom; not touched here.)
- **Place the window against reality, not against a flag.** Placement ran once, on the tick
  that created the window - the one moment a freshly built window is least likely to accept
  a move - and a "have we placed it" guard then suppressed every retry, leaving it at the
  default cascade position for good. It is now recomputed each tick and applied only when
  the window is actually in the wrong place. Same class of bug as tracking `shown`
  separately from the window: derived state that silently drifts from the thing it
  describes.
- **An auxiliary window gets no `CssBaseline`.** That component lives inside the client app,
  so the overlay window inherited the browser's own `body { margin: 8px }`: a 320px card in
  a 320px window overflowed in both axes and the overlay drew scrollbars over the game. The
  page now zeroes the document's margin, padding and overflow on mount. It also reports
  `scrollWidth`/`scrollHeight` alongside the bounding rect, because a clipped card measures
  its truncated size and would stay clipped for good.
- **`set_size` sets the inner size.** Placement compared it against the *outer* size, which
  either thrashes the window every tick or never corrects it.
- **Capture exclusion makes the feature unscreenshottable.** `hideFromCapture` defaults on
  and applies `WDA_EXCLUDEFROMCAPTURE`, which does exactly what it says: the overlay cannot
  appear in a screenshot, a recording or a screen share. That is correct behaviour and a
  serious testing trap - it has to be off to capture evidence that the overlay works. The
  setting's hint now says so.
- **The diagnostics panel must report the window, not the policy.** It showed "on screen now"
  from the watcher's *intention* while no window existed at all, which made a real failure
  unreportable. It now asks the window (`is_visible`), carries any creation error, and names
  the state the policy is in (`HiddenReason`): switched off, waiting for the page to paint,
  no game in front, exclusive fullscreen, waiting for someone to speak, or manually hidden.
  It also reports what the page says it is drawing (`PageStatus`) and the window's real rect,
  because a visible window painting nothing is indistinguishable from a missing one.
- **A hotkey press outranks the activity timer.** As planned, "while active" gated the
  manual toggle too, so pressing the shortcut in a silent channel did nothing.
- The detector reads the foreground window only and opens exactly one handle
  (`PROCESS_QUERY_LIMITED_INFORMATION`), as specified.

## 1. How Discord decides, and what the PoC takes from it

| Mechanism | Discord | PoC |
| --- | --- | --- |
| Game database | `GET /api/v9/applications/detectable` (unauthenticated; ~10,000 entries). Fields: `id`, `name`, `executables[{os, name, is_launcher}]`, `hook`, `overlay`, `overlay_methods`, `overlay_warn`, `overlay_compatibility_hook`, `aliases`, `themes`. Executable names are path *fragments*, e.g. `win64/tslgame_be.exe`, matched against the tail of a running process path; `is_launcher: true` marks a launcher so it does not count as playing. Newer entries increasingly ship without executables because the game announces itself through the SDK instead | No central list to maintain. Local launcher manifests give the same "installed under a store" answer with exact install directories (section 3.2). An optional "use Discord's public game list" switch is feasible later: the client already calls Discord's application RPC endpoint for presence names (`state/presence.rs:355`, `assets::application_rpc_url`), so the privacy posture is not new, but it stays off in the PoC |
| Process scan | Periodic enumeration of all processes, name match | Only the **foreground** window's process is probed, every 500 ms. An overlay is about what is on screen, not what is running; this also avoids touching protected game processes at all |
| Manual registration | Settings, Registered Games, "Add it!" registers any running app; per-game overlay toggle | The ask-once prompt (section 3.5) plus allow/deny rules per executable in the diagnostics panel |
| Overlay activation | Auto-on for detected games since April 2024; attaches to the game's window; not in true fullscreen | Same: eligible verdict enables the window; exclusive fullscreen yields a `CannotShow` verdict and a one-time hint |
| Self-announcement | Games with the Discord SDK publish presence with their pid | `fancy-presence` already receives exactly that (`PresenceEntry.pid`, `Activity.activity_type`), section 3.2 E3 |

## 2. Architecture

```text
 mumble-tauri process
 +-------------------------------------------------------------------------+
 |  fancy-gamedetect (new crate)                                           |
 |   Probe (500 ms) -> Evidence sources -> Classifier -> Policy -> Verdict |
 |        |                 |                                 |            |
 |   Win32 foreground   installed-game index,            mode, rules,      |
 |   window facts       GameConfigStore, presence,       shell state       |
 |                      window class, deny-list                            |
 +-------------------------------|-----------------------------------------+
                                 | Verdict { Show{hwnd,monitor,exe,reasons} | Hide | CannotShow }
                                 v
 |  commands/game_overlay/ (new, modelled on draw_overlay/)                 |
 |   window lifecycle: Absent -> Created(hidden) -> Shown <-> Hidden -> Absent
 |   activity timer (talking edges, fresh message) decides Shown vs Hidden  |
 |   emits game-overlay-state; serves game_overlay_snapshot                 |
 +-------------------------------|-----------------------------------------+
                                 | Tauri events (broadcast to every webview)
                                 v
 |  ui: GameOverlayPage.tsx in the `game-overlay` window                    |
 |      Settings > Overlay: mode, corner, diagnostics (shadow-mode panel)   |
```

Threading: the probe runs on a Tokio task (the `win_tracker` precedent), the window
operations go through `AppHandle` on the main thread as `draw_overlay` does, and the
installed-game index is built once on a blocking thread and refreshed hourly or when a
new launcher manifest appears. Nothing blocks the protocol event loop (the audio-glitch
lesson from the screen-share work applies).

## 3. The detector

### 3.1 Probe: facts about the foreground window, all benign

| Fact | API | Note |
| --- | --- | --- |
| `hwnd`, `pid` | `GetForegroundWindow`, `GetWindowThreadProcessId` | skip if `pid` is ours or the window is cloaked (`DwmGetWindowAttribute(DWMWA_CLOAKED)`) |
| `exe_path` | `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `QueryFullProcessImageNameW` | the pattern in `fancy-audio-device/src/wasapi.rs:144`; the only handle the detector ever opens; anti-cheat kernels permit limited information |
| `class` | `GetClassNameW` | engine and toolkit fingerprints, section 3.2 E5 |
| `style`, `ex_style` | `GetWindowLongPtrW(GWL_STYLE / GWL_EXSTYLE)` | `WS_CAPTION`, `WS_THICKFRAME`, `WS_POPUP` |
| `rect`, `monitor` | `GetWindowRect`, `MonitorFromWindow`, `GetMonitorInfoW` | fullscreen-ish = rect covers the monitor |
| `shell` | `SHQueryUserNotificationState` | `QUNS_BUSY`, `QUNS_RUNNING_D3D_FULL_SCREEN`, `QUNS_PRESENTATION_MODE` |
| `package` | `GetPackageFamilyName(hProcess)` on the same limited handle | Store/UWP apps, including Xbox app games |

Results are cached per `pid` (exe path, class, package) so the steady-state cost per tick is
four cheap user32 calls. Never used: `PROCESS_VM_READ`, `EnumProcessModules`,
`ReadProcessMemory`, any hook.

### 3.2 Evidence sources and weights

Weights are the starting point for shadow-mode tuning, not a spec.

| Id | Evidence | How | Weight |
| --- | --- | --- | --- |
| E1 | Installed under a game store | `exe_path` starts with an install directory from the installed-game index (section 3.3) | +60 |
| E2 | Windows remembers it as a game | `HKCU\System\GameConfigStore\Children\*\MatchedExeFullPath` equals `exe_path` (written by Game Bar's "Remember this is a game" and by FSO detection) | +50 |
| E3 | Announces itself | a `fancy-presence` entry with `pid == foreground pid` and `activity_type` playing (0) or absent; listening/watching types count 0 | +70 |
| E4 | Rendering shape | rect covers its monitor and style lacks `WS_CAPTION` and `WS_THICKFRAME` (+25); `WS_POPUP` (+5); shell `QUNS_BUSY` (+10); `QUNS_RUNNING_D3D_FULL_SCREEN` (+30, and the verdict becomes `CannotShow`) | up to +45 |
| E5 | Engine window class | `UnityWndClass` (Unity), `UnrealWindow` (Unreal), `GLFW30` (GLFW, LWJGL 3, Minecraft), `SDL_app` (SDL 2/3, MonoGame, Ren'Py, GoldSrc/Source today), `Valve001` (older Source), `LWJGL`, `RGSS Player` (RPG Maker), `CryENGINE`, `Engine` (Godot, verify) | +40 |
| E6 | Toolkit class | `Chrome_WidgetWin_1` (Electron/Chromium), `Qt5QWindowIcon`/`Qt6*`, `HwndWrapper[*` (WPF), `WindowsForms10*`, `SunAwtFrame` (Java Swing), `CabinetWClass`/`Progman`/`WorkerW` (shell), `ApplicationFrameWindow` (UWP host, look at the package instead) | 0, and browsers/Electron are usually vetoed by E7 |
| E7 | Deny-list veto | section 3.4 | verdict `NotGame` |
| E8 | User rule | allow or deny per `exe_path` (or per package family) | overrides everything |

Classifier: `score = sum(weights)`; any veto or deny rule yields `NotGame`; an allow rule
yields `Game`; otherwise `>= 60` is `Game`, `30..59` is `Probably`, below is `NotGame`.
Every verdict carries its reasons (`"steam:common/ELDEN RING"`, `"class:UnityWndClass"`,
`"veto:browser"`) for the diagnostics panel and the log.

### 3.3 The installed-game index (the local replacement for Discord's list)

Built from what launchers already write to disk, the way Playnite, Lutris and Vortex find
games. Each adapter yields `{ store, name, install_dir, launch_exe? }`.

| Store | Where | Confidence |
| --- | --- | --- |
| Steam | `<Steam>\steamapps\libraryfolders.vdf` for every library, then `steamapps\appmanifest_*.acf` (`installdir`, `name`) under `steamapps\common\<installdir>`. Steam's location from `HKCU\Software\Valve\Steam\SteamPath` | high |
| Epic | `%PROGRAMDATA%\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON: `InstallLocation`, `LaunchExecutable`, `DisplayName`); Playnite reads exactly this directory | high |
| GOG | `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>` values `path`, `exe`, `gameName` | high |
| Ubisoft Connect | `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>\InstallDir` | high |
| EA app / Origin | `HKLM\SOFTWARE\WOW6432Node\EA Games\*` and `Origin Games\*` `Install Dir` values | verify in shadow mode |
| Battle.net | `%PROGRAMDATA%\Battle.net\Agent\product.db` (protobuf) or the per-game `InstallPath` registry keys under `Blizzard Entertainment` | verify |
| Riot | `%PROGRAMDATA%\Riot Games\Metadata\<product>\*.product_settings.yaml` (`product_install_full_path`) | verify |
| Xbox app / Store | `C:\XboxGames\*\Content` (contains `MicrosoftGame.config`); for packaged apps the package family name from the probe, matched against the Xbox app's installed list; `WindowsApps` itself is not readable, so packaged games without an `XboxGames` folder rely on E2 and E4 | medium |
| itch, Humble, standalone | no manifests; E2, E4, E5 and the ask-once prompt cover them | n/a |

Launcher executables are indexed too and **vetoed**: `steam.exe`, `EpicGamesLauncher.exe`,
`GalaxyClient.exe`, `Battle.net.exe`, `RiotClientServices.exe`, `UbisoftConnect.exe`/`upc.exe`,
`EADesktop.exe`, `Origin.exe`, `XboxPcApp.exe`, `steamwebhelper.exe`. That is Discord's
`is_launcher`.

### 3.4 The deny-list (why Explorer, CAD and office never get an overlay)

Vetoes apply by executable name (case-insensitive, without extension) and by window class,
and are the reason the threshold can stay generous for everything else:

| Category | Executables (seed) |
| --- | --- |
| Shell and ourselves | `explorer`, `SearchHost`, `ShellExperienceHost`, `LockApp`, the client's own exe and `qt6ui` |
| Browsers | `chrome`, `msedge`, `firefox`, `brave`, `opera`, `vivaldi`, `chromium`, `zen` |
| Office and documents | `winword`, `excel`, `powerpnt`, `outlook`, `onenote`, `AcroRd32`, `Acrobat`, `soffice*` |
| IDEs and terminals | `Code`, `devenv`, `idea64`, `rider64`, `clion64`, `pycharm64`, `studio64`, `WindowsTerminal`, `cursor` |
| CAD, 3D, creative | `acad`, `SLDWORKS`, `Inventor`, `CNEXT` (CATIA), `Fusion360`, `Rhino`, `blender`, `Photoshop`, `Illustrator`, `Adobe Premiere Pro`, `AfterFX`, `Resolve`, `Substance*`, `houdini*`, `maya`, `3dsmax`, `Cinema 4D` |
| Game editors | `Unity` (editor; the class `UnityWndClass` matches games too, so the name wins), `UnrealEditor`, `UE4Editor`, `Godot*` (editor builds), `GameMaker*` |
| Comms and meetings | `Teams`, `ms-teams`, `Zoom`, `slack`, `Discord`, `Telegram`, `WhatsApp` |
| Remote and streaming hosts | `mstsc`, `parsec*`, `Moonlight`, `vncviewer`, `obs64`, `Streamlabs*` |
| Media players | `vlc`, `mpc-hc64`, `mpv`, `wmplayer`, `PotPlayer*` (a fullscreen film is E4-positive, hence the veto; a user who wants the roster over films adds an allow rule) |

Shell state vetoes: `QUNS_PRESENTATION_MODE` always hides. A user allow rule beats a
veto, because the list is a default, not a policy.

### 3.5 Ask once

On the first `Probably` verdict for an executable (per install path, remembered even when
the answer is "later"), the main window shows one prompt: "Show the voice overlay over
`<name>`?" with "Yes", "No", "Not now". Yes and No become E8 rules; the prompt never
repeats for that path. `Game` verdicts need no prompt in "while active" mode; in a future
"strict" mode they could. This is the whole of Discord's "Add it" flow and Game Bar's
"Remember this is a game" checkbox, and it keeps the automatic threshold high.

### 3.6 Worked examples (expected verdicts, to be confirmed in shadow mode)

| Foreground app | Evidence | Score / verdict |
| --- | --- | --- |
| Explorer window | class `CabinetWClass`, not fullscreen, veto shell | `NotGame` |
| AutoCAD maximised | `acad.exe`, caption present, veto CAD | `NotGame` |
| Chrome fullscreen video | `Chrome_WidgetWin_1`, E4 +25, veto browser | `NotGame` (allow rule flips it) |
| VS Code fullscreen | `Chrome_WidgetWin_1`, E4 +25, veto IDE | `NotGame` |
| Elden Ring, borderless | E1 steam +60, E4 +25 (+10 busy) | 95, `Game` |
| Minecraft (Java) | `javaw.exe`, class `GLFW30` +40, E4 +25, presence via mod +70 | `Game` |
| Small itch.io game, SDL | E4 +25, `SDL_app` +40 | 65, `Game` |
| Unity game outside a store, windowed | `UnityWndClass` +40 only | 40, `Probably`, ask once |
| Unity **editor** | `Unity.exe`, veto editor | `NotGame` |
| Netflix app fullscreen | packaged app, E4 +25, `QUNS_BUSY` +10 | 35, `Probably`, ask once (default No) |
| Valorant (borderless) | E1 riot +60, E4 +25 | `Game`; no memory reads, no handle beyond limited info |
| DX9 game in exclusive fullscreen | E1 +60, `QUNS_RUNNING_D3D_FULL_SCREEN` | `CannotShow`, one hint |
| PowerPoint slideshow | `QUNS_PRESENTATION_MODE` | hidden regardless |

## 4. The overlay window module

`commands/game_overlay/{mod.rs, lifecycle.rs, placement.rs}`, cloned from `draw_overlay/`
with these differences:

- **Builder**: `decorations(false) shadow(false) transparent(true) always_on_top(true)
  skip_taskbar(true) resizable(false) focusable(false) visible_on_all_workspaces(true)`,
  then `set_ignore_cursor_events(true)`, `set_excluded_from_capture(pref)` and
  `strip_system_chrome`. `focusable(false)` (not the draw overlay's `focused(false)`) is
  what makes tao set `WS_EX_NOACTIVATE`.
- **Placement**: widget-sized (320 px wide, height from content, capped), anchored to the
  chosen corner of the game's monitor with a 16 px margin, physical pixels; re-asserted on
  every verdict tick if the monitor or corner changed; never sized to the game.
- **Lifecycle**: `Absent -> Created(hidden)` on the first `Show` verdict;
  `Hidden <-> Shown` driven by the activity timer; `-> Absent` after three minutes of
  `Hide`/`NotGame` verdicts (frees the WebView2 process) or on `CannotShow`.
  Show/hide use `window.show()/hide()` so a hidden overlay is not a visible window at all.
- **Activity timer** ("while active" mode): shown while any `user-talking` is true or the
  last message is younger than 10 s; hidden 4 s after the last activity; minimum shown
  time 2 s to avoid flicker on short utterances. "Always" mode keeps it shown while the
  verdict is `Show`.
- **Commands and events**: `game_overlay_snapshot` returns `{ channel_name, occupants,
  talking_sessions, own_session, voice_state, self_deaf, last_message { sender, text,
  at } }` from `SharedState`, with the body run through the existing `strip_html_tags`;
  `game_overlay_set_mode`, `game_overlay_toggle` (hotkey), `game_overlay_rule(exe, allow)`.
  Events: `game-overlay-state { verdict, reasons, exe, visible }` for the diagnostics panel
  and the hint; the existing `user-talking`, `voice-state-changed`, `new-message`.
- **Housekeeping**: `capabilities/game-overlay.json` (like `draw-overlay.json`, plus
  `core:window:allow-show/hide` are not needed because Rust drives visibility); add the
  label to the window-state denylist in `app/builder.rs:63`; register the window kind in
  `ui/standard/App.tsx` and `ui/nebula/index.tsx` dispatchers.

## 5. The page

`ui/src/ui/standard/pages/GameOverlayPage.tsx` (route by window label, the
`DrawOverlayPage` pattern: transparent document, bootstrap from `game_overlay_snapshot`,
then window-local `listen()` calls; no `useAppStore`). Content, top to bottom, on a
`NebulaSurface`-style translucent card: channel name and own mic/deafen icons; one row per
occupant with `UserAvatar(talking)` and `TalkingBars` (from `nebula/components/primitives`,
the `MiniMode` rows without the buttons); the last message as sender plus two clamped
lines, fading over the final 2 s of its 10 s life. No animation beyond the existing
120 ms talking ring. Test ids added to `ui/src/core/testids.ts` for the roster row and the
message line.

## 6. Settings and the diagnostics panel

Preferences: `overlay: { mode: "off" | "whileActive" | "always", corner, showLastMessage,
hideFromCapture, rules: Record<string, "allow" | "deny"> }` in `UserPreferences` and
`DEFAULTS`; a `toggleOverlay` binding in `ShortcutBindings`; a Nebula settings page
"Overlay" with a `SETTINGS_NAV` entry and search-index entry, mirrored in Standard.

The **diagnostics panel** is the PoC's main deliverable in shadow mode: it subscribes to
`game-overlay-state` and shows the foreground executable, window class, store match,
score, reasons and verdict, with "Allow"/"Deny" buttons that write rules, a rolling log of
the last 50 verdict changes, and "Copy log" for tuning across the team. It stays in the
product afterwards as the "why is the overlay (not) showing" screen.

## 7. Files

New: `vendor/client/crates/fancy-gamedetect/` (`probe.rs`, `index/{steam,epic,gog,ubisoft,ea,battlenet,riot,xbox}.rs`,
`evidence.rs`, `classify.rs`, `policy.rs`, `denylist.rs`, `lib.rs`; unit tests with fixture
manifests and synthetic probe facts); `crates/mumble-tauri/src/commands/game_overlay/`;
`capabilities/game-overlay.json`; `ui/src/ui/standard/pages/GameOverlayPage.tsx` and
`.module.css`; `ui/src/ui/nebula/components/settings/OverlaySettings.tsx`; locale keys.

Changed: `mumble-tauri/Cargo.toml` (`fancy-gamedetect`, `windows-sys` features
`Win32_System_Registry`, `Win32_Storage_Packaging_Appx`), `app/builder.rs` (denylist),
`commands/mod.rs` (registration), `state/mod.rs` (overlay slot), `ui/standard/App.tsx` and
`ui/nebula/index.tsx` (window kind), `core/types/preferences.ts`, `core/preferencesStorage.ts`,
`core/features/settings/shortcutHelpers.ts`, `core/constants/tauriEvents.ts`,
`core/testids.ts`, `settings/SettingsNav.tsx`, `settingsSearchIndex.ts`.

House rules that apply: no `unsafe` without a file-level `allow` with a reason and a
`SAFETY:` comment per block; files under 600 lines; no `too_many_lines` allows; every
feature gets a regression test; ASCII-only comments.

## 8. Milestones

| M | Deliverable | Done when |
| --- | --- | --- |
| M0 | `fancy-gamedetect` with probe, index, classifier; diagnostics panel; no window | The panel shows correct verdicts for the section 3.6 table on two team machines; unit tests for the classifier and each manifest parser pass on fixtures |
| M1 | Window + page, manual only (hotkey and panel button) | Overlay appears over a borderless game, is click-through, never takes focus, absent from the client's own screen share |
| M2 | Policy wiring: automatic show/hide from verdicts, ask-once prompt, exclusive-fullscreen hint | One week of shadow-mode logs show no false positive on productivity software; games caught without prompts in the common case |
| M3 | Measurements | Process Monitor: no handle to a game beyond limited information; PresentMon: independent flip while hidden, delta recorded while shown; CS2 Trusted Mode stays on with the overlay visible |
| M4 | e2e test in this repo | `audio-bot` speaks, WebDriver switches to the `game-overlay` handle, the speaker's name and the last message are asserted |

Explicitly not in the PoC: macOS and Linux probes, the Qt port's overlay, lifting the
talking derivation into `mumble-protocol`, Discord's public list, per-game overlay
positions.

## 9. Risks and open questions

- **Window class seeds are from memory and community sources**; Godot's main window class
  and the current Source class in particular must be confirmed in shadow mode. The
  classifier treats them as weight, never as a veto, so a wrong seed costs accuracy, not
  safety.
- **Packaged (Store) games** without an `XboxGames` folder are only caught by E2 and E4;
  acceptable for a PoC, the Xbox app's own installed list can be added later.
- **Anti-cheat cannot be proven negative**; the PoC records what the process does (one
  limited-information handle, one window) so the argument is inspectable.
- **Deny-list drift**: names change; keep it a data file with tests, and keep the user rule
  as the escape hatch in both directions.
- **Using Discord's list** would improve recall for games installed outside stores, at the
  price of a network fetch of a large file and dependence on an undocumented endpoint.
  Decide after shadow mode shows how many `Probably` prompts the local evidence produces.

## 10. Sources

- Discord detectable applications object and endpoint: https://docs.discord.food/resources/game
- Community mirror of the detectable list (~10,000 games; executables per OS, hook/overlay flags): https://github.com/Bluscream/discord-games
- Undocumented endpoint request, discord-api-docs #1862: https://github.com/discord/discord-api-docs/issues/1862
- Discord's new overlay: auto-on for detected games, per-game toggle, windowed and borderless only: https://support.discord.com/hc/en-us/articles/25289844838551--Known-Issue-Game-Overlay
- The new overlay is a topmost window "glued to whatever window it happens to think is a game": https://erikmcclure.com/blog/discord-overlay-breaks-gsync/
- Game Bar "Remember this is a game" and `GameConfigStore`: https://support.xbox.com/en-US/help/games-apps/game-setup-and-play/how-to-make-xbox-game-bar-remember-or-forget-a-game
- `GameConfigStore\Children\*\MatchedExeFullPath` used for game detection: https://github.com/seerge/g-helper/issues/3935
- Playnite's Epic adapter reads `%PROGRAMDATA%\Epic\EpicGamesLauncher\Data\Manifests\*.item`: https://raw.githubusercontent.com/JosefNemec/PlayniteExtensions/master/source/Libraries/EpicLibrary/EpicLauncher.cs
- GLFW window class `GLFW30`: https://github.com/glfw/glfw/issues/2651
- SDL window class `SDL_app`, and GoldSrc/Source moving from `Valve001` to it: https://github.com/ValveSoftware/halflife/issues/758 and https://wiki.libsdl.org/SDL2/SDL_RegisterApp
- `SHQueryUserNotificationState` semantics for FSO games: https://learn.microsoft.com/en-us/answers/questions/1086527/shqueryusernotificationstate-returns-quns-busy-ins
- Client precedents: `vendor/client/crates/mumble-tauri/src/commands/draw_overlay/`, `crates/fancy-presence/src/store.rs` (`PresenceEntry.pid`), `crates/fancy-audio-device/src/wasapi.rs:144`, `src/state/presence.rs:355`
