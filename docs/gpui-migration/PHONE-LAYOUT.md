# Phone layout for fancy-gpui on Android

Plan only. Nothing here is built. Reference behaviour: the web client's
"Nebula mobile" (`vendor/client/crates/mumble-tauri/ui/src/ui/nebula/components/mobile/`).
Target: `fancy-gpui` (`vendor/client/src/ui/gpui`) on gpui-fast + gpui-mobile
(`F:\fancy-migrate\gpui-next\crates\gpui_mobile`).

## Review, after the Android backend work (14 Nov, late)

Written by a sub-agent from source reading, then checked against what the
backend does now (`F:\fancy-migrate\notes\ANDROID-PROGRESS.md`, gpui-next
`FANCY_CHANGES.md`, section "Android backend"). The plan stands; these
corrections override the sections below where they disagree:

1. **Finding 4 is out of date.** gpui_mobile now reports `Window::insets()`
   (safe area and keyboard, animated), implements `on_app_lifecycle` and
   `on_memory_warning` (`onTrimMemory`), hands back saved state after process
   death (`android::lifecycle::{set_saved_state, restored_state}`), and has a
   foreground service (`android::services::connection`). Step 2's "if
   Android returns zeros" no longer applies; steps 16 and 17 shrink to wiring
   the client to `services::connection` and `cx.on_memory_warning`.
2. **Long press (3.2, step 7): no helper is needed.** The platform turns a
   held, still finger (Android's own timeout and slop) into a right button
   press and release, with the haptic tick, and the finger's lift clicks
   nothing. The eleven `MouseButton::Right` sites work unchanged; step 7 is
   a check on the phone, not code. What stays: long press inside the
   composer and message text should become selection later.
3. **Back (2.4, step 4).** On Android back (button and gesture) arrives as
   the Escape key, and an Escape the app leaves unhandled (GPUI's propagate)
   sends the app to the background. So `Shell::phone_back` is the Escape
   action's handler, with the order of 2.4, ending in `cx.propagate()` when
   nothing is open. `on_back_gesture` is iOS's edge swipe; not used here. The
   keyboard takes back first (hides itself) on its own.
4. **Platform packages (section 5):** gpui-mobile's `packages::{notifications,
   webview, permission_handler, file_selector, share, ...}` call Java classes
   (`GpuiNotifications`, ...) that the host does not have; they would fail at
   run time. Use `gpui_mobile::android::services::{permissions, connection,
   notifications, share_in, web_view}` instead (built and checked on the
   emulator), `cx.open_url` for links, `cx.prompt_for_paths` for opening
   files (works through `GpuiPathPicker`). Saving (`prompt_for_new_path`) is
   still missing: owed in the backend (`ACTION_CREATE_DOCUMENT`).
5. **Player (row "WebView2 YouTube player", step 18):** `services::web_view`
   puts the system WebView in a sub-window at a rectangle (a
   `NativeActivity` draws no views of its own content), with an https base
   and a `postMessage` bridge. A sub-window is always above the GPUI
   surface: GPUI content cannot overlay it, so the player must be hidden
   (`set_visible(false)`) whenever a menu, sheet or dialog covers the card,
   as `Placement::Hidden` already does on Windows.
6. **Screen share (row and step 19): viewing is not portable as written.**
   `fancy_screenshare::viewer` is compiled for Linux and Windows only, and
   the crate does not build for Android (xcap). Receive-only on Android needs
   the gate in `F:\fancy-migrate\notes\android\screenshare-gate.patch`.
7. **Share-in is done** (`services::share_in`), not "later".
8. **Pinch** on the lightbox: GPUI's recognizer has no pinch yet; two fingers
   are safe (the first one pans). Pinch-zoom is GPUI work, not the client's.
9. **Units:** GPUI's logical pixel on Android is the dp (scale = density / 160),
   confirmed on the emulator (420 dpi, scale 2.625), and follows a density
   change at run time.

Paths below: `W:` = `vendor/client/crates/mumble-tauri/ui/src/ui/nebula/components/mobile`,
`G:` = `vendor/client/src/ui/gpui/src`, `M:` = `gpui-next/crates/gpui_mobile/src`.

## 0. Findings that shape the plan

1. The native client has ONE view, `Shell` (`G:ui/mod.rs`, 2543 lines). `Shell::render_body`
   (mod.rs:2440) lays a row: `rail::render` | `sidebar::render` | `conversation::render`
   (settings and the connect screen replace the whole body). Everything else is an overlay
   chained in `Shell::render` and `Shell::with_panels` (mod.rs:2380-2543).
   There is no responsive code today. The phone arrangement is one new function next to
   `render_body`, not a second UI.
2. `Shell::dismiss` (mod.rs:1868) is already an ordered "close the topmost thing" stack
   (video shrink, stage, mention list, lightbox/emoji/GIF/menu/prompt/info, edit/reply,
   pick mode, mover/channel form/pins, admin page, ACL/later/friends/settings, editor/picker/
   devices/certs). It is exactly what the Android back gesture needs for "close the dialog
   first". Pane popping goes after it.
3. The web mobile UI is chosen by user agent only (`core/utils/platform.ts`: regex
   `Android|iPhone|iPad|iPod`, NOT a media query); `NebulaClientApp.tsx:2504` renders
   `<MobileShell>` instead of the window layout. Mirror that: choose the phone arrangement by
   `cfg(target_os = "android")` (plus a `FANCY_GPUI_PHONE=1` env switch to test it on
   desktop), not by window width.
4. gpui-mobile gaps that matter (verified in source):
   - `prompt_for_new_path` on Android returns `Ok(None)` always
     (`M:android/platform.rs:1252`); `prompt_for_paths` is files only, not directories
     (`M:android/document_picker.rs`). Saves and folder picks need the `file_selector` package.
   - Android window has `safe_area_insets()` (`M:android/window.rs:1086`) but no `insets()`
     trait override and no IME inset found, so the keyboard-aware API
     (`Window::insets()`, `WindowInsets { safe_area, ime }`, gpui `platform.rs:1203`) must be
     checked on device; the default returns zeros.
   - No `on_memory_warning` / `on_app_lifecycle` implementation found in `M:android/`
     (the trait hooks exist, `gpui/src/platform.rs:474-482`).
   - No foreground service anywhere in gpui_mobile.
   - Long press exists as an event (`LongPressEvent`, `gestures.rs:445`, 500 ms default,
     `GestureTuning.long_press_duration`) and as `TouchClickEvent.long_press`
     (`interactive.rs:284`); `div` has `on_back_gesture` (`div.rs:424`). There is no
     `on_long_press` builder on `div` that I found; use `ClickEvent::Touch(e).long_press` in
     `on_click`, or a `PlatformInput::LongPress` listener (verify at step 7).
5. Audio on Android already exists in the engine: `crates/mumble-tauri/src/audio/android.rs`
   (oboe). The native client's engine is shared, so voice is not a view concern.

## 1. View classification

| Native view / file | On a phone |
|---|---|
| `kit/*` (buttons, fields, rows, dialog, select, slider, toolbar...) | Reuse. Sizes change (section 3) |
| `page/*`, `rich.rs`, `embeds.rs`, `picture.rs`, `pictures/` (message bodies, links, pictures) | Reuse as is |
| `conversation.rs` (message list + `composer`) | Reuse, full width; drop the `pr(19)` scrollbar gutter, `COLUMN_MOST` irrelevant |
| `sidebar.rs` (channel tree, search, dock) | Reuse as the NAV pane, full width |
| `rail.rs` (server tiles, 40px, `WIDE` 220) | Re-arrange: horizontal strip above the channel list (web `MobileServerStrip.tsx`), foldable (`MobileStripHost.tsx`) |
| `connect.rs` (`server_column` + `landing`) | Two-pane: servers list = NAV, `landing`/server form = CONTENT (web `MobileServersPane` + `MobileConnectPane`) |
| `settings/*` (`nav.rs` list + pages) | Two-pane: `settings::nav` = NAV, `settings::page` = CONTENT with a back header (web does the same via `MobileHeader onBack`). Settings is already full-body (memory: settings surface is full-screen) |
| `friends.rs` | Reuse as the "People" tab list; DM opens CONTENT |
| `members.rs` (+ `members/roster.rs`, `row.rs`) | Side drawer from the right, 86% / max 380 px, scrim (web `MembersDrawer`) |
| `aside.rs`, `pins.rs`, `later.rs`, `acl.rs`, `acl_people.rs`, `channel_form.rs`, `mover.rs`, `emoji.rs`, `gifs/`, `picker.rs`, `devices.rs`, `server_editor.rs`, `certificates.rs`, `onboarding.rs`, `profile_page.rs`, `about_editor/`, `admin_pages/` | Bottom sheets or full-screen sheets (see 2.3); content reused |
| `menu.rs` (context menus, prompts, `render_info`) | Reuse; menus open from long press anchored to the touch point, clamped to safe area; long menus become a bottom sheet |
| `card.rs`, `hover_card.rs` | Tap opens `card` (kept card) as a bottom sheet; hover variant disabled |
| `lightbox.rs` | Reuse full-screen; add pinch-zoom later; back closes it |
| `stage/*` (share viewer: `view.rs`, `strip.rs`, `large.rs`, `overlay.rs`, `popout.rs`, `pan.rs`) | Viewer reused full-screen; `popout.rs` (second window) desktop-only; `overlay.rs` drawing over the sharer's screen desktop-only |
| `band.rs`, `frame.rs` (custom title bar, window controls, resize grips) | Desktop-only. Not drawn on Android |
| `global_keys.rs`, `keys.rs` (Ctrl+... shortcuts), `settings/shortcuts.rs` | Desktop-only (hidden); hardware keyboards still deliver `keys.rs` actions |
| `settings/advanced.rs` window-behaviour switches (tray, start minimized, global keys) | Hide on Android (web does the same with `!isMobile`, `AdvancedSettings.tsx:144,266,294`) |
| `ui/kit/split_view.rs` (list 300 px + detail) | Becomes the pane switch itself on phone: list OR detail, never both |
| Voice dock (in `sidebar.rs`) | Split as web: `MobileCallBar` (band above composer: speaker, mute, leave) + full-screen `MobileVoiceScreen` (collapsible) |

## 2. Navigation

### 2.1 Web mobile model (reference)

Files: `W:MobileShell.tsx`, `MobilePaneStack.tsx`, `MobileTabBar.tsx`, `MobileSheet.tsx`,
`MobileHeader.tsx`, `MobileServerStrip.tsx`, `MobileStripHost.tsx`, `MobileCallBar.tsx`,
`MobileVoiceScreen.tsx`, plus `ui/nebula/backGesture.ts`.

- State: `pane: "nav" | "content"` (MobileShell:73), `voiceOpen`, `model.membersOpen`,
  `model.screen` (`chat | messages | settings | connect`). Not new state per screen: every
  screen is "a list beside a page", one switch covers all.
- Tab bar (3 tabs: Chats/Servers, People=friends, Settings): height 76 + bottom inset,
  hidden while a conversation is the front pane (a half-typed message must not be one tap
  from being lost). Pressing the active tab returns to its list. Changing screen resets to
  the list.
- Panes: both stay mounted; content slides over nav (220 ms), nav parallaxes 25 %. Swipe right
  on content = back; swipe left on nav = forward to the last conversation; swipe left on a
  conversation = pull in members drawer. Swipes ignored on inputs and horizontal scrollers.
- Sheets (`MobileSheet`): bottom, 92 % ("full") or 58 % ("half"), grab handle, 52 px header,
  pull-to-dismiss, scrim tap closes. Used for panels that are columns on a window.
- Server strip: 88 px high, folds away with a vertical swipe; its visibility is persisted.
- Back (`backGesture.ts` + `MobileShell` `useBackStep`), in order: 1) any open overlay/menu/
  dialog; 2) voice screen; 3) members drawer; 4) content pane to nav; 5) at the channel list
  with a conversation available: open it (NOT exit, because the edge swipe is ambiguous);
  6) non-home screen to chat; 7) at home: let Android leave the app.

### 2.2 Native equivalent: one navigation state

Add to `Shell` (new file `G:ui/phone/nav.rs`, small, with a trait boundary per design rules):

```
enum Pane { Nav, Content }
struct PhoneNav { pane: Pane, voice_open: bool, strip_hidden: bool }   // members_open lives in panels.members.open
enum Tab { Chats, People, Settings }                                   // maps to existing screen state
```
Existing state is reused: `panels.settings.open`, `panels.friends.open`,
`shows_connect_screen()`, `open` (current `Conversation`), `panels.members.open`. `PhoneNav`
only adds `pane`, `voice_open`, `strip_hidden`.

Render: `render_body` gets a third branch `if phone { phone::render_body(...) }`:
header (`MobileHeader` equivalent, height min(skin header, 66)) + stacked panes + tab bar.
Pane stack = two absolutely positioned layers with a horizontal offset driven by an
animated `p` in 0..1 (as `MobilePaneStack.place`), nav keeps its state while hidden
(do not unmount `sidebar` / `conversation`; GPUI entities already survive). Gestures from
GPUI touch events (`TouchEvent`, `TouchDragEvent`): slop 10 px, horizontal bias 1.2, commit at
33 % or 0.35 px/ms fling, same constants as the web. Skip swipes that start inside the
composer field or a horizontally scrolling element.

### 2.3 Sheet vs full pane

| Surface | Phone presentation |
|---|---|
| Channel tree, servers list, friends list, settings list | NAV pane |
| Conversation, DM, settings page, connect/server form | CONTENT pane |
| Members roster (`members.rs`) | Right drawer + scrim |
| Voice call (`stage`-less voice view) | Full-screen over everything, above panes; call bar in chat |
| Pins, later (scheduled), channel info (`aside.rs`), card (`card.rs`) | Half or full bottom sheet |
| Emoji picker, GIF browser, `mention` list | Bottom sheet above keyboard / inline list above composer |
| Channel form, mover, ACL, admin pages, profile page, about editor, server editor, certificates, devices | Full-screen CONTENT-style page with back arrow (not a sheet: they have forms) |
| Context menu (`menu.rs`) | Popup at touch point; over ~8 rows becomes half sheet |
| Prompt / confirm (`render_prompt`, `kit/dialog.rs`) | Centered dialog, width = min(400, screen - 32) |
| Lightbox, stage viewer | Full-screen |

### 2.4 Back button / gesture

Hook: `div().on_back_gesture` on the root `Shell` div (gpui `div.rs:424`) plus the hardware back
key if gpui-mobile maps it to `Escape` (check `M:android/keyboard.rs`). Handler
`Shell::phone_back(cx)`, first match wins:

1. `Shell::dismiss`-style overlays: lightbox, emoji, GIFs, menu, prompt, info card, mention
   list, stage, video shrink, edit/reply, pick mode, pins, mover, channel form, ACL, later,
   admin page, editor, picker, devices, certs. (Refactor `dismiss` to return `bool`
   "did something", it currently falls through to `cx.notify()`.)
2. `voice_open` then close it.
3. Members drawer then close it.
4. Settings/friends/connect page open on CONTENT pane then `pane = Nav`.
5. `pane == Content` (conversation) then `pane = Nav`.
6. On Nav of a non-home tab then switch to Chats (web step 6).
7. On Chats Nav with an open conversation: follow the web and open it instead of leaving
   (same edge-swipe ambiguity). Only the connect/servers screen at home leaves.
8. Nothing handled: do not `prevent_default`, so Android backgrounds the app. (Same as the web:
   the listener is held only while something can answer.)

The existing `dismiss` already does step 1 and also closes settings/friends; on phone those
two are panes, so split them out so they take step 4 instead.

## 3. Touch targets, long press, hover

### 3.1 Sizes (dp; GPUI px on Android = dp at the platform scale, verify scale in step 2)

Android minimum 48 dp. Current native sizes (all from `G:ui/`):

| Element | File:line | Now | Verdict |
|---|---|---|---|
| Button Small / Medium / Compact | kit/button.rs:524 | 34 / 36 / 35.1 | Too small, raise to 48 on phone |
| IconButton default | kit/button.rs:176 | 28 x 28 (plated 38) | Too small, 48 hit area (icon stays 18-20, pad the hit box) |
| Channel row (sidebar) | sidebar.rs:307-310 | carded min 49; compact 38; plain `py 10` (~40) | 38/40 too small, min 48 |
| Header tool buttons | conversation.rs:440 | 28 / 38 plated | Too small |
| Member row | members/row.rs:108 | 29 | Too small, 48 |
| Sidebar user/occupant row | sidebar.rs:573 | 30 | Too small, 48 |
| Chip | kit/chip.rs:88 | 27 | Too small; 36 visual with 48 hit |
| Tick box | kit/tick_box.rs:31 | 15 | Too small, 24 visual, 48 hit row |
| Switch | kit/control.rs:246 | 32 x 18 | Too small visual, row hit area 48 |
| Radio | kit/control.rs:274 | 16 | Too small, same |
| Settings control row | kit/control.rs:155,422 | `height` field / min 30 | min 48 |
| Slider | kit/slider.rs:22-26 | bar 4, knob 12, row 24 | Knob 20, hit 48 tall |
| Rail tile | rail.rs:15 | 40 | Strip tile 48 |
| Search field | kit/search_field.rs:43 | 45-47 | OK, raise to 48 |
| Composer field | conversation.rs:852 | min 54, max 180 | OK |
| Menu item | menu.rs:1764 | min 38 | Too small, 48 |
| Band | band.rs:16 | 44 | Not drawn on phone |
| Web tab bar | tokens `handheldChrome` | 76 | Use 64 + bottom inset |
| Web header | `handheldChrome` | min(skin, 66) | Same |

Mechanism: one `Metrics` global (`G:ui/kit/metrics.rs`, new) with `touch: bool`; `Button`,
`IconButton`, `ListRow`, `Control`, `Chip` read it in their `render` and substitute
`max(h, 48)`. Do NOT touch each call site: the kit is the choke point (aurora atomic
composition rule). Where a visual must stay small (switch, tick) pad the hit box with
transparent padding.

### 3.2 Long press = secondary click

Right-click handlers to give a touch equivalent (all `MouseButton::Right`):

| Handler | Opens |
|---|---|
| sidebar.rs:338, 582, 854 | channel / user / row menus |
| members/row.rs:195 | member menu |
| conversation.rs:979, 2534 | message menu, picture menu |
| rail.rs:245, 304 | server tile menu |
| connect.rs:362 | saved-server menu |
| stage/large.rs:45, stage/strip.rs:88 | share tile menu |

Implement one helper `kit::secondary(el, handler)` that registers both
`on_mouse_down(Right)` and the touch long press (`LongPressEvent`, 500 ms,
`TouchPhase::Started` fires the menu, anchor = `start_position`), and call it from those 11
sites. Haptic tick through gpui-mobile `vibration` package when it fires. Long press must
cancel the following tap/click (`ClickEvent::Touch.long_press` already marks it,
`interactive.rs:284`), and must not start on text selection areas (composer, message text:
there long press = selection handles, add later).

### 3.3 Hover-only affordances

| Hover thing | File:line | Touch equivalent |
|---|---|---|
| Message action bar (react/reply/edit...) appears on hover | conversation.rs:957 `on_hover` | Long press opens the message menu / a reaction bar sheet; optional: tap selects message and shows the bar (web `ReactionBar` disables hover on mobile) |
| Profile card on rest over a name | hover_card.rs, members/row.rs:191, sidebar.rs:588 | Tap on avatar/name opens the kept card (`card.rs`) as a sheet; no hover timer |
| Hover pill in actions | actions.rs:196 | Tap toggles |
| Tooltips (`kit/tooltip.rs`) | many | Long press shows tooltip (gpui has `long_press_tooltip_active` in div.rs:2454) or drop; every icon button needs an accessible label |
| Hover highlight on rows (`hover` colour) | kit/button.rs, control.rs | Use pressed state only |
| Cursor changes, resize grips (`frame.rs`) | many | Drop |
| Scrollbar gutter | conversation.rs composer `pr(19)` | Drop, overlay scrollbars |
| Double click to enter a channel (README: click reads, double click enters) | sidebar.rs | Tap reads/opens, an explicit Join button or long press menu "Join" enters (web `ChannelsPane` joins and opens on tap) |
| Keyboard shortcuts (README Keys section) | keys.rs | None; hardware keyboard only |

## 4. Safe areas and the keyboard

- Source: `window.insets()` (`WindowInsets.safe_area` + `.ime`, gpui `platform.rs:1203`,
  `window.rs:3115`), with `on_insets_changed` callback (continuous during animation per its
  contract). If the Android backend does not feed it (finding 4), add it in gpui-mobile from
  `M:android/window.rs` `safe_area_insets_logical()` plus an IME inset listener
  (`WindowInsets.Type.ime()`); that is a gpui-mobile task, step 2.
- Root of the phone layout applies `pt = safe_area.top`, `pl/pr = left/right` (the web does
  this once in `MobileShell`, `sx pt/pl/pr: SAFE_AREA`); bottom is applied by whichever band
  is the bottom edge: tab bar (`height = bar + bottom`, `pb = bottom`) or, on a conversation,
  the composer wrapper (`ChatPane`: `pb: SAFE_AREA.bottom`).
- Keyboard: bottom inset = `max(safe_area.bottom, ime.bottom)`. When the IME is up the
  composer's wrapper uses `ime.bottom` (which already contains the nav bar) and the tab bar is
  not drawn anyway. Message list keeps its scroll anchor at the newest message while the
  viewport shrinks (do not jump up). The composer `max_h(180)` becomes
  `min(180, viewport - ime - header - 120)`.
- Sheets and dialogs with fields (prompt, rename, server editor, channel form): offset by
  `ime.bottom`; scroll the focused field into view (`kit/focus.rs`).
- Status bar icon colour follows theme light/dark (web `core/systemBars.ts`; gpui-mobile has the
  JNI call at `M:android/jni.rs:1391`).
- Edge-to-edge: draw the `ChatBackdrop`/theme backdrop under the bars; content padded.
- Display cutout/rounded corners: `WindowInsets.corner_radii` for the sheet's top radius.
- Android IME text input exists (`M:android/text_input.rs`); the composer's marked-text field
  (`kit/marked_field.rs`, `marking.rs`) must be tested with composition (Gboard).
- Back-gesture bar must not be covered: drawer and sheets respect `safe_area.bottom`.

## 5. Windows-only (and desktop-only) modules

| Module | Desktop (Windows) | On Android | gpui-mobile package? |
|---|---|---|---|
| Tray `G:tray.rs` (tray-icon, menu mute/deafen/leave/show/quit, green talking dot) | Icon in notification area | Ongoing **foreground-service notification** ("In voice: #channel") with Mute, Deafen, Leave actions; keeps mic + socket alive in background. Required, else Android kills audio when backgrounded | `notifications` has show/cancel/channels, but NO foreground service and no action buttons, nothing to start a `Service` or hold a wake lock. Needs a new Java service in gpui-mobile + `foregroundServiceType=microphone|mediaPlayback`, `FOREGROUND_SERVICE_*` and `POST_NOTIFICATIONS` permission (`permission_handler::Permission::Notification`). Not present |
| Global keys `G:hotkeys.rs`, `ui/global_keys.rs`, global-hotkey (`RegisterHotKey`), push-to-talk / whisper / mute / deafen from other apps | Works while another program has focus | Not possible. Replace with: on-screen hold-to-talk button in call bar and voice screen (touch down = talk, up = stop), whisper via member menu long press; optional headset/media button toggles mute via `media_session` `MediaAction`; volume key PTT only while foreground (key events from `M:android/keyboard.rs`). Hide the "Global keys" switch | `media_session` (media buttons, notification controls: `set_action_handler`) yes; hardware keys through `keyboard.rs` yes; global PTT: no |
| Working-set trim `G:trim.rs` (`SetProcessWorkingSetSize`, 8 s after pictures) | Gives idle pages back | Remove. Replace with `Platform::on_memory_warning` (Android `onTrimMemory`): drop decoded picture caches (`G:pictures/`, put-away in engine), stop animations, shrink lists. `trim::soon` call sites (pictures/mod.rs:307,324,520; ui/mod.rs:703; ui/playing.rs:152) become a no-op on Android | Hook exists in gpui core (`platform.rs:482`), **Android implementation not found** in gpui_mobile; add it. Memory is also bounded by the RAM budget rule |
| WebView2 YouTube player `G:player/` (`web_view.rs`, `win32.rs`, child window placed per frame by `place.rs`; `Screens` trait boundary in `mod.rs`) | Child window over the card | Implement a second `Screens` backend using the system WebView positioned at the card rectangle via the platform-view system (hybrid composition, `M:platform_view.rs`). `Placement` (device px + clip + `Hidden` under overlays) maps onto the view's frame; hide when a sheet/menu is above. Fallback if composition misbehaves: open the URL externally | `webview` (`load_url`, `load_html`, `evaluate_javascript`, `go_back`, `dismiss`, `platform_view_handle()`): yes. `url_launcher` for the fallback: yes |
| File pickers: `cx.prompt_for_paths` / `prompt_for_new_path` at ui/menu.rs:1350,1374,1425,1443; about_editor/view.rs:601; certificates.rs:66,83; lightbox.rs:172; settings/logs.rs:48 | Native dialogs | Files: Storage Access Framework. Open already works through `document_picker.rs` (copies to a readable local path, files only). **Save: `prompt_for_new_path` returns None on Android**, so: save-picture, save-shared-file, certificate export, logs export must call `file_selector::get_save_path` / `share::share_uri`; directory pick (recording folder, certificate folder) via `get_directory_path` or drop the option (use app cache dir + share sheet) | `file_selector` yes (open_file(s), get_save_path, get_directory_path); `image_picker`, `share` (share_text/share_uri), `path_provider` yes |
| Notifications `G:notify.rs` (notify-rust / notify-send) | Toast/notification centre | `NotificationManager` via gpui-mobile; channel per kind (messages, mentions, voice); tap deep-links to the conversation; permission on Android 13+ | `notifications` (initialize/show/cancel/cancel_all, Importance, NotificationChannel): yes; `permission_handler` yes; `deeplink` yes for the tap |
| Screen share `G:share/` (+ `crates/fancy-screenshare`, Windows D3D capture, Linux module, `share/whereabouts/win32.rs` = where a shared window lies for the drawing overlay) | Send screen/window/camera, receive and draw over it | **Receive-only** v1: viewing (`stage/*`) works since decode is portable (`share/decode.rs`, str0m/openh264). Sending absent: the capture crate has no Android target (`Cargo.toml` only `linux`/`windows` deps); picker `Screen`/`Window` rows hidden. Camera share later via the `camera` package. MediaProjection capture is a later project (needs foreground service type `mediaProjection`). `whereabouts` + overlay drawing on the sharer's side: not applicable | `camera` yes; no screen-capture package |
| `G:ui/stage/popout.rs` (viewer in its own window), window frame `ui/frame.rs`, `band.rs` | Multi-window / custom title bar | Not on Android: full-screen viewer only | n/a |
| `G:startup.rs`, `away.rs`, `silence.rs` | Startup timing; idle/away detection; silence | Keep; `away` uses desktop idle input: on Android use `on_app_lifecycle` (Background = away). `silence.rs` portable | lifecycle hook in gpui core, Android impl not found |
| Clipboard image paste (composer "send a picture from the clipboard") | OS clipboard | Keep for text; pictures via picker | `clipboard`, `image_picker` yes |
| Opening links (`links.rs`) | Browser | `url_launcher::launch_url` | yes |
| `paths.rs` (data dir by OS env) | `%APPDATA%` etc. | `path_provider` app files dir | yes |
| Fullscreen `F11`, `Ctrl+Q`, drag-drop of files on conversation | Desktop | Absent; "share" intent receive later (`deeplink`) | partial |
| Audio devices UI `devices.rs`, `settings/voice*.rs` | Pick input/output, noise etc. | Reduce to: noise suppression/AGC/gain/PTT-mode; device picker only if gpui-mobile/oboe exposes it (earpiece vs speaker toggle needed); runtime `Microphone` permission | `microphone`, `audio`, `permission_handler` yes; engine has oboe backend (`crates/mumble-tauri/src/audio/android.rs`) |
| Lifecycle: connection survives background | n/a | Foreground service keeps it; reconnect banner (`reconnect.rs`) on resume | n/a |

## 6. Build order (each step small and checkable)

1. **Phone flag.** Add `Metrics { phone: bool, touch: bool }` global set from
   `cfg(target_os="android")` or `FANCY_GPUI_PHONE=1`; window size 390x844 when forced on desktop.
   Check: desktop run with the env looks unchanged; a unit test sees the flag.
2. **Insets plumbing.** Read `window.insets()` into a `Shell` field refreshed by
   `on_insets_changed`; a debug overlay draws the four insets. If Android returns zeros,
   add the gpui-mobile side (safe area + IME). Check: on device the overlay bars move when the
   keyboard opens.
3. **Phone body, one pane.** `phone::render_body` shows only `sidebar` (Nav) or
   `conversation` (Content) by `PhoneNav.pane`, no animation, header with back arrow. Check:
   forced-phone desktop run: tap channel opens conversation, back arrow returns.
4. **Back handling.** `Shell::phone_back` ordering from 2.4 on `on_back_gesture` and Escape.
   Check: test per level (overlay, voice, drawer, pane, tab, leave) in `ui/tests*.rs`.
5. **Touch metrics in the kit.** `max(h, 48)` in `Button`, `IconButton`, `ListRow`, `Control`,
   `Chip`, `Slider`, menu items when `touch`. Check: a test walks the debug selectors and asserts
   every clickable has height >= 48 in phone mode (list the exceptions).
6. **Tab bar + tabs.** Chats / People / Settings from existing screen state; hidden on an open
   conversation; active-tab press goes to list. Check: switching never leaves a stale page.
7. **Long press helper.** `kit::secondary`, wired to the 11 right-click sites; haptic; cancels
   click. Check: `LongPressEvent` test at 500 ms opens each menu at the touch point.
8. **Hover replacements.** Message menu/reaction sheet, tap-for-card, disable hover timers
   (`hover_card.rs`), tap-to-join channel. Check: no `on_hover` path is the only way to an action.
9. **Composer and keyboard.** Composer above the IME, list anchored, `max_h` rule, sheets with
   fields lifted. Check on device with Gboard, including composition and the mention list.
10. **Members drawer + sheets.** Right drawer, bottom sheet container, move pins/later/aside/
    card/emoji/GIF into it; full-screen pages for forms. Check: each is reachable and closed by back.
11. **Server strip + servers pane + settings two-pane.** Horizontal rail (`rail.rs` variant),
    fold gesture, `connect.rs` and `settings` as Nav/Content, settings Windows-only switches hidden.
12. **Pane animation and swipes.** Slide, parallax, edge swipe, forward swipe, drawer swipe, with
    the web constants. Check: swipe starting in the composer or a code block does nothing.
13. **Call bar and voice screen.** Bar above composer, full-screen voice screen, hold-to-talk
    button, whisper via menu; `Microphone` permission request first. Check: talk works with the
    screen on.
14. **Files.** Route all `prompt_for_*` through one `files` module: Android uses
    `file_selector` for open/save/dir and `share_uri` as export fallback. Check: send a picture,
    save a picture, export a certificate.
15. **Notifications.** Port `notify.rs` to `notifications` with channels, permission, tap deep link.
16. **Foreground service.** Add service + ongoing notification with mute/deafen/leave actions
    in gpui-mobile; start on join, stop on leave. Check: lock the screen, voice continues,
    action buttons work.
17. **Memory.** Implement `on_memory_warning` for Android (`onTrimMemory`), drop picture caches
    there, remove `trim.rs` use on Android. Check: peak RSS inside the 400 MB cap in a
    picture-heavy channel while backgrounding.
18. **Video player.** Android `Screens` backend over the system WebView at the card's rectangle;
    external-browser fallback first. Check: YouTube card plays and scrolls with the list, hides
    under a sheet.
19. **Screen share receive.** Make the stage viewer full-screen with pinch/pan, hide send sources
    and `whereabouts` overlay on Android. Check: view a Windows sharer's stream.
20. **Polish and gate.** Light/dark status bar icons, cutouts, rotation (landscape keeps two-pane
    above 600 dp as a later option), accessibility labels on icon buttons, run the full test
    suite on desktop to prove nothing regressed.

Later (not v1): screen/camera send, headset PTT, share-intent receive, tablet two-pane.

## Files relied on

Web: `W:MobileShell.tsx`, `MobilePaneStack.tsx`, `MobileTabBar.tsx`, `MobileSheet.tsx`,
`MobileHeader.tsx`, `MobileStripHost.tsx`, `MobileCallBar.tsx`, `MobileVoiceScreen.tsx`,
`ui/nebula/backGesture.ts`, `ui/nebula/tokens.ts` (`SAFE_AREA`), `ui/nebula/theme.ts`
(`handheldChrome`), `core/utils/platform.ts`, `ui/nebula/NebulaClientApp.tsx:2504`.
Native: `G:../README.md`, `ui/mod.rs`, `ui/sidebar.rs`, `ui/rail.rs`, `ui/conversation.rs`,
`ui/kit/button.rs`, `kit/control.rs`, `kit/split_view.rs`, `ui/menu.rs`, `ui/hover_card.rs`,
`tray.rs`, `hotkeys.rs`, `trim.rs`, `notify.rs`, `player/mod.rs`, `share/*`, `Cargo.toml`.
gpui-next: `gpui/src/gestures.rs`, `gpui/src/platform.rs`, `gpui/src/elements/div.rs`,
`gpui_mobile/src/android/{platform,document_picker,window}.rs`, `gpui_mobile/src/packages/*`,
`gpui_mobile/src/platform_view.rs`.
