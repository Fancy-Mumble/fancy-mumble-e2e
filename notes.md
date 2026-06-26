# Screen-sharing rework — working notes

Status dump for the "Rust-native screen sharing + custom picker + e2e regression
tests" effort. Living scratchpad; delete once the work lands.

Approved plan file (full detail): `C:\Users\Sebastian\.claude\plans\valiant-inventing-balloon.md`.

---

## Goal

Replace the browser-native screen capture (`getDisplayMedia` + JS
`RTCPeerConnection`) with:

1. A **custom in-app source picker** — two tabs (**Entire Screen** by monitor /
   **Window** single-window), each with a live preview thumbnail.
2. **Rust-side capture + WebRTC** — Rust captures the screen/window, encodes
   VP8, and is the WebRTC peer to the server SFU. 100% wire-parity with today
   (browser viewers unchanged).
3. **E2E regression tests first** — a green/purple checkerboard demo window, two
   clients, verify each client sees its **own** window and the **shared** window,
   comparing the actual transmitted pixels/colours.

## Key decisions (agreed with user)

- **RTC location:** *Full Rust WebRTC broadcaster peer.* "Rust capture → browser
  RTC" was the first choice, but bridging raw frames Rust→webview means a slow
  Tauri-IPC hop and/or double-encode ("multiple hops"). Per the user: *prefer
  full Rust if there's any doubt it hurts performance.* Rust sends VP8 RTP
  straight to the SFU; **browser viewers and the SFU are unchanged** (the SFU
  already negotiates VP8 from a standard SDP offer — see
  `vendor/server/3rdparty/webrtc-sfu/src/session/broadcast.rs`).
- **E2E:** *Full Selenium, real capture, NO mocking.* The user explicitly
  rejected mocking `getDisplayMedia` ("otherwise we don't know if it works").
  Real checkerboard windows are captured for real. To drive the current build's
  **native** OS picker (which Selenium can't touch), use **pyautogui** GUI
  automation "for now" (removable once the Rust picker exists).
- **Platforms:** Windows + Linux.

## Target architecture

```
Broadcaster (Rust):  xcap capture ─► RGBA→I420 ─► VP8 encode ─► webrtc crate ─► UDP ─► SFU
Signaling:           Rust sends SDP_OFFER/ICE via existing send_webrtc_signal cmd;
                     Rust intercepts the broadcaster's SDP_ANSWER/ICE in the WebRtcSignal handler.
Webview (broadcaster): custom picker UI + START/STOP announce + own preview (loopback viewer)
Viewers (unchanged):   browser recvonly RTCPeerConnection ◄─ SFU  (VP8 → <video>)
```

What stays in JS (`vendor/client/.../components/chat/stream/useScreenShare.ts`):
the incoming-signal dispatcher, **all viewer logic**, START/STOP announce,
late-joiner re-announce, store state. Only the **broadcaster half**
(`getDisplayMedia` + `connectBroadcasterToServer` + broadcaster PC) is replaced
by `invoke()` calls into Rust.

---

## DONE so far

### Phase 0 — e2e harness (test-first; currently red, by design)

- **`fixtures/checkerboard.py`** — Tk window painting a deterministic green
  `(0,180,0)` / purple `(150,0,150)` checkerboard. Args `--title --phase
  --cols --rows --cell --x --y`. `--phase 0`=green corner, `1`=purple corner
  (distinguishes the two clients). DPI-aware; prints `checkerboard-ready`.
- **`fixtures/verify_checkerboard.py`** — standalone proof of the *pixel
  contract*, runnable without app/server/driver. **Ran GREEN.**
  - Part A: classifier math on synthetic boards (phase via **min-mismatch over
    both hypotheses**, 15% tolerance, broken-board rejection).
  - Part B: real-display `ImageGrab` confirms the helper renders ~86k green /
    ~90k purple px for both phases.
  - Caught + fixed a real bug: deriving phase from a single corner cell is
    brittle to VP8 artifacts → now min-mismatch + colour-dominance guard
    (mirrored in JS classifier).
- **`src/util/checkerboard.ts`** — `CheckerboardWindow.launch()` spawns the Tk
  helper, resolves on the ready line, `.close()` kills the tree.
- **`src/pages/stream.page.ts`** — `StreamPage` page object, **implementation
  agnostic**:
  - `shareWindow(title, onNativePicker?)` — clicks the share toggle; if the
    **custom** picker (`screen-share-picker`) appears → drives it; else calls
    `onNativePicker()` (the pyautogui driver for the current build).
  - `watchByName(name)` — clicks the "is sharing" banner's Watch button.
  - `readCheckerboard()/waitCheckerboard()` — draw the stream `<video>` into a
    canvas, classify cell centres into green/purple/other; assert hue-class +
    structure, never exact RGB. Classifier matches the Python.
  - **No getDisplayMedia mock** (added then removed per user).
- **`src/tests/screenshare.multiclient.test.ts`** — 3 subtests:
  1. Alice shares → her own preview decodes to her checkerboard (phase 0).
  2. Bob watches Alice → sees the same green-first board.
  3. Each client sees its own (Alice phase 0, Bob phase 1) — distinct.
- **`src/app.ts`** — `TauriApp.stream` page; `LaunchOptions.captureWindowTitle`
  → sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--auto-select-desktop-capture-source`
  (real-capture auto-select; **did not reliably work**, see blocker).
- **`src/selectors.ts`** — re-export `STREAM_SOURCE_TITLE_ATTR`,
  `BROADCASTER_NAME_ATTR`.

### Client testids (in `vendor/client` submodule — additive, behaviour-preserving)

- **`ui/src/testids.ts`** — added `screenShareToggle`, `screenSharePicker`,
  `screenSharePickerTab`, `screenShareSource`, `screenShareConfirm`,
  `streamViewerVideo`, `broadcastBanner`, `broadcastWatch`, plus
  `STREAM_SOURCE_TITLE_ATTR` / `BROADCASTER_NAME_ATTR`.
- **`ui/.../chat/ChatHeader.tsx`** — `data-testid={TID.screenShareToggle}` on the
  **existing** share button (so one selector works for old + new builds).
- **`ui/.../chat/stream/ScreenShareViewer.tsx`** — `data-testid`/`data-own`/
  `data-session` on both `<video>`s (OwnBroadcastPreview + RemoteViewer);
  `data-testid`/`data-broadcaster-name` on the banner row; `data-testid`/
  `data-session` on the Watch button.

### Server / infra

- **SFU enabled in the fixture** (was the "no WebRTC relay configured" error):
  - `fixtures/mumble-server.ini` → `webrtcsfuenabled=true`, `webrtcsfuport=10000`,
    `webrtcsfupublicip=127.0.0.1`.
  - `fixtures/docker-compose.e2e.yml` → exposed `10000/udp`.
  - Server now logs `WebRtcSfuManager: SFU initialised (UDP port 10000, public IP
    127.0.0.1)`. The image already ships `/usr/bin/libwebrtc_sfu.so`; it's
    dlopen'd at runtime (no compile-time gate), so only the ini needed flipping.
- **Client release rebuilt** with the new testids:
  `vendor/client/target/release/mumble-tauri.exe` (custom-protocol).
- **`vendor/client/.../Cargo.toml`** — `xcap` was added then **reverted** to keep
  the baseline build clean. Re-add in Phase 1.
- **`scripts/inspect-picker.mts`** — TEMP diagnostic that screenshots the native
  picker (`.tmp/picker.png`). **Delete later.**

---

## CURRENT BLOCKER — drive the native picker with pyautogui

The current build uses `getDisplayMedia`, which opens Edge's **native** "Choose
what to share" dialog that Selenium cannot touch → the broadcast never starts
(no own-preview `<video>`, no "is sharing" banner on the peer). That's why all 3
subtests currently fail with timeouts. The SFU is up; this is the *only* thing
blocking a green run on the current build.

`--auto-select-desktop-capture-source` via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
was tried and did **not** reliably auto-select (broadcast still never started).

### Native picker layout (from `.tmp/picker.png`, screen 3840×2160 / 4K)

Edge dialog **"Choose what to share with http://tauri.localhost"**, centered:
- Tabs: **Window** (active) | **Entire Screen**.
- Grid of window thumbnails with title labels below each (our checkerboard
  windows show as distinctly green/purple; phase = corner colour distinguishes
  Alice's green-corner board from Bob's purple-corner board).
- Bottom: "Also share system audio" toggle.
- Bottom-right: **Share** (disabled until a source is selected) and **Cancel**.

### pyautogui driver — next concrete task

Build `fixtures/pick_share_window.py` (+ a `NativePickerDriver` in
`stream.page.ts` that spawns it after the toggle click), to:
1. Wait for the picker (poll a screenshot for the dialog / the green+purple
   thumbnails).
2. Ensure the **Window** tab is active.
3. Click the correct checkerboard thumbnail — match by **phase = corner colour**
   (green-first vs purple-first), constrained to the dialog bounds so it doesn't
   hit the real checkerboard windows visible behind the dialog.
4. Click **Share**.

Gotchas to handle:
- Both clients' checkerboard windows appear in *each* picker → must pick by phase.
- Leftover helper windows (e.g. an old `fancy-e2e-selftest`) can add extra
  green/purple boards → ensure clean state / unique titles per run.
- 4K coordinates; pyautogui uses physical px. Locate by colour signature, not
  hard-coded coords.
- The dialog is modal but the JS `getDisplayMedia` promise only resolves after
  Share is clicked — so the driver must run concurrently with the Selenium click.

---

## REMAINING WORK (phases)

- **Phase 1 — Rust capture + enumeration + thumbnails**
  - Re-add `xcap` to `cfg(not(target_os="android"))` deps.
  - `src/commands/screenshare/{mod,sources,capture}.rs`; register in
    `commands/registry.rs` + `commands/mod.rs`.
  - Commands: `list_capture_sources()` → screens+windows (id/kind/title/size);
    `capture_source_thumbnail(id)` → base64 PNG (lazy, IPC-safe).
  - Capture thread modelled on `audio/rodio_desktop.rs` (thread → frame channel).
- **Phase 2 — custom picker UI**
  - `ui/.../chat/stream/ScreenSharePickerDialog.tsx` (+ css). Reuse `Modal`,
    `TabbedPage`/`RadioCardGroup`, `MultiStreamGrid` styling.
  - Two tabs + preview cards (markup carries `screen-share-picker*` testids).
  - Wire into `ChatView` `startSharing` → open picker → `start_screen_broadcast({source})`.
  - i18n keys (en/de/fr/zh).
- **Phase 3 — Rust WebRTC broadcaster peer** (the core)
  - Deps (desktop only): `webrtc`, a VP8 encoder (`vpx-encode`/libvpx), RGBA→I420.
  - `src/commands/screenshare/broadcast.rs`: `start_screen_broadcast(source)` /
    `stop_screen_broadcast()`; offer via existing `send_webrtc_signal`; trickle ICE.
  - Intercept broadcaster `SDP_ANSWER`/`ICE` in
    `state/handler/webrtc_signal.rs` (viewer signals keep flowing to JS).
  - Replace the broadcaster half of `useScreenShare.ts` with `invoke()`s; keep
    dispatcher + viewer + START/STOP.
  - Own preview = **loopback viewer** (recvonly to SFU for own session) → real
    decodable `<video data-own="true">` (this is what the e2e reads back).
- **Phase 4 — parity / gating / audio / docs**
  - Keep `SCREEN_SHARE_MIN_VERSION` + SFU-availability gating + multi-tab
    `broadcasterServerId` routing.
  - System-audio capture: best-effort/optional in v1.
  - Update vitest `ui/.../__tests__/ScreenShare.test.ts` for the new broadcaster flow.
  - Document headed-display requirement + python3-tk in README; remove pyautogui
    crutch + `scripts/inspect-picker.mts`.

---

## How to build / run

```bash
# Server (SFU now enabled in the fixture)
docker compose -f fixtures/docker-compose.e2e.yml up -d --wait
docker logs fancy-e2e-mumble 2>&1 | grep -i sfu   # expect "SFU initialised ... UDP 10000"

# Build the client (after UI changes)
( cd vendor/client/crates/mumble-tauri/ui && npm run build )            # ui/dist
( cd vendor/client/crates/mumble-tauri && cargo build --release --features custom-protocol --bin mumble-tauri )  # ~6 min
# -> vendor/client/target/release/mumble-tauri.exe

# Run only the screenshare test (Windows native driver in .tools/)
E2E_NATIVE_DRIVER="$(pwd)/.tools/msedgedriver.exe" \
  node --import tsx --test --test-concurrency=1 src/tests/screenshare.multiclient.test.ts

# Verify the pixel contract alone (no app/server/driver needed)
python fixtures/verify_checkerboard.py        # PASS

# Typechecks
npx tsc --noEmit                              # e2e
( cd vendor/client/crates/mumble-tauri/ui && npx tsc --noEmit )   # client UI
```

## Environment facts

- Screen 3840×2160 (4K), Windows 11.
- `msedgedriver` 149 at `.tools/msedgedriver.exe` matches Edge 149.
- Workspace Rust lints (deny): `missing_docs`, `unused_results`,
  `missing_debug_implementations`, `unsafe_code`. Doc every pub item; handle
  every Result.
- Test run takes ~100s for the 3 subtests (each waits ~30s currently → timeouts).

## Test-run history

1. No SFU → 3 fails (own preview/banner never appear). Caused by (a) native
   picker undriveable AND (b) "no WebRTC relay configured".
2. Enabled SFU → still 3 fails (native picker undriveable).
3. Mock workaround → **rejected by user** (don't mock).
4. → pyautogui native-picker driver (current task). Picker screenshot captured.

## Files touched (so far)

E2E repo:
- `fixtures/checkerboard.py`, `fixtures/verify_checkerboard.py`
- `fixtures/mumble-server.ini`, `fixtures/docker-compose.e2e.yml`
- `src/util/checkerboard.ts`, `src/pages/stream.page.ts`,
  `src/tests/screenshare.multiclient.test.ts`, `src/app.ts`, `src/selectors.ts`
- `scripts/inspect-picker.mts` (TEMP — delete)

`vendor/client` submodule:
- `ui/src/testids.ts`
- `ui/src/components/chat/ChatHeader.tsx`
- `ui/src/components/chat/stream/ScreenShareViewer.tsx`
- `crates/mumble-tauri/Cargo.toml` (xcap added then reverted)
