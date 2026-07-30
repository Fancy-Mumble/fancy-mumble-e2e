# Handover: Starling moderation fixes + running the e2e suite against Starling

Written 2026-07-28. Everything below is in the working tree (nothing committed),
in `vendor/starling` and this repo. Nothing is pushed.

## 1. What was done

Three Starling bugs reported from a live session, all fixed and unit-tested, plus
a full e2e suite run against a Starling built from today's source.

**Nothing here is verified against a live client.** The unit tests pass and the
e2e suite ran, but the three fixes were never confirmed by hand in the app.
That is the first thing to do tomorrow.

## 2. Starling changes (`vendor/starling`, uncommitted)

All in `crates/services/session-lifecycle/`.

### 2.1 SuperUser can be made priority speaker — `src/lib.rs`

`on_speak_state` refused every speak-state change against the SuperUser. murmur
groups mute/deafen/suppress/priority_speaker into one block and refuses all four
for account 0 (`vendor/server/src/murmur/Messages.cpp:1131`), with no exception
even for the SuperUser acting on itself.

The guard now fires on `restricts(state)` — mute/deafen/suppress only. Priority
speaker is a *grant*, and the rule exists so nothing can be taken **away** from
the account that repairs a broken ACL table. A message carrying both a mute and
a priority flag still counts as restrictive, so a mute cannot ride past the
guard on the back of a grant.

**This is a deliberate divergence from murmur**, recorded in `docs/GAP-ANALYSIS.md` §2.

### 2.2 A moderator's mute was never enforced — `src/handshake.rs`

The big one. `on_speak_state` set `mute` on the connection record and broadcast
it to every client, so the user *rendered* as muted — and stayed audible.

`announce_changed` rebuilt the `Session` for session-view without `mute`,
`deaf`, `suppress` or `priority_speaker`, and session-view's `Upsert`
**replaces** rather than merges (`session-view/src/lib.rs:181`). `voice` reads a
speaker's silence *only* from session-view (`voice/src/view.rs:146`), so the
mute was un-applied in the one place that decides whether packets are forwarded.

Fix: a single `session_record(&PendingConnection) -> Session` used by both
`announce_up` and `announce_changed`, written out field by field with **no
`..Session::default()`** — the struct-update syntax is what hid the omission, and
a new field on the message should now fail to compile and force a decision.

Also fixed by the same change: any unrelated edit (a channel move, a comment)
was silently clearing a moderator's mute, `connected_at_ms` was being reset to 0
on every change, and `address`/`cert_hash`/`fancy_version` were dropped on both
announce paths. `cert_hash` matters — see §5.

### 2.3 Muting logged two things that never happened — `src/lib.rs`

Muting someone produced three log lines in the client: "You gave priority
speaker status to X", "You muted X", "You undeafened X".

A Mumble client logs one line per field **present** in a `UserState`, not per
field changed (`vendor/server/src/mumble/Messages.cpp:600` tests
`msg.has_priority_speaker()` and nothing else). The echo was sending all three
fields every time, so restating an unchanged `false` was narrated as an event.

murmur mutates the client's own message and writes in a coupled field only when
it actually forces one (`Messages.cpp:1303`). New `echoed(requested, before,
after)` helper reproduces that: present if asked for **or** changed underneath,
absent otherwise.

### 2.4 Client-side registration (`UserState.user_id`) — `src/lib.rs`, `src/state.rs`

Was gap U7: `on_user_state` never read `user_id`, so the client's *Register*
button sent a message the server parsed and ignored, silently.

New `on_register`: `SelfRegister` on root for yourself, `Register` on root for
someone else (`Messages.cpp:1203`), refuses an already-registered target, and
**requires the target to hold a certificate**. That last one is load-bearing:
this path stores no password, and `authenticate` refuses a password-less account
claimed by name alone (`userdata/src/accounts.rs:227`), so registering a
certificate-less user writes an account its owner can never log into while
permanently burning the name (`NameTaken` for everyone after).

Plus `Connections::set_account` in `state.rs`, and a `refused()` helper that
sends `DenyType::Text` so failures reach the user as prose instead of silence.

### 2.5 Docs — `docs/GAP-ANALYSIS.md`

Re-verified every entry against the code by reading handlers. It had drifted in
the flattering direction: `UserRemove`(8) (kick/ban), temporary-channel
collection and positional-audio passthrough were all listed as missing and all
built. Baseline corrected to 17 handled / 7 ignored / 3 unanswered. IDs were
deliberately **not** renumbered after removing entries, so A1/A3 and U2/U6 have
gaps — renumbering would break any reference to them.

## 3. Running the e2e suite against Starling — the traps

This took five attempts. Read this before trying.

**The one that wasted the most time:** the connect wizard only shows a port
field in **expert mode**; in normal mode it *always dials 64738* and
`E2E_SERVER_PORT` is ignored (`src/pages/connect.page.ts:44`). A run pointed at
a spare port therefore drove all 39 files against whatever was already on 64738
— 201 connections to the wrong server — while the intended instance sat idle
with zero. **Starling must be on 64738, so anything else there has to stop.**

Other traps, in the order they bite:

| Trap | Symptom | Fix |
|---|---|---|
| `starling --port N` | `unknown argument "--port"` | CLI is `starling --all-in-one --config <file>`. `src/util/starling.ts` still uses `--port`, so `starling-voice.multiclient.test.ts` **cannot start a server today** (7 cancelled). Unfixed. |
| `unix:` endpoints on Windows | `"unix:/run/starling/x.sock" is not an endpoint` | Rewrite to `pipe:<name>` in the config. Refused deliberately, not silently downgraded. |
| SuperUser password | every admin test hangs on the password dialog, then `chat.waitLoaded` times out at 45s and the whole file dies in `before()` | `starling set-superuser-password testpassword --config <file>` **before** first boot. The fixture hard-codes `testpassword`. This alone was 64 cancellations. |
| 21 of 39 files need murmur | `Command failed: docker exec fancy-e2e-mumble ...` | They call `setSuperUserPassword()` in `src/util/server.ts`, which shells out to the murmur container. It only has to *exist* — the test then connects to `E2E_SERVER_PORT`. Bring murmur up on unused ports (64900/64901/64902/10001/6503) purely to satisfy it. |
| No test timeout | one hung file blocks forever | `npm run test:e2e` sets no `--test-timeout`; node's default is none. Note it bounds each **file**, not each test — 150s killed a legitimate file and cascaded 92 cancellations. |
| Leaked drivers | `tauri-driver exited early ... native WebDriver is almost certainly missing` | **Misleading message.** Real cause is usually `can not listen to address: 127.0.0.1:4447` in `.tmp/tauri-driver-*.log` — a timed-out file's `after()` never ran, so its driver still holds the port. Run one node process per file and reap between. |

`<temp>/run-per-file.sh` (scratchpad,
will be gone) did: start Starling on 64738 → murmur shim on spare ports → one
`node --test` per file with a reap in between. Worth recreating as a repo script.

### Prerequisites that were stale

- `starling.exe` was a day old → `cargo build -p starling`.
- The client binary was from Jul 19, built from `b79e5aa` while `vendor/client`
  is at `66a9241` — **1137 files apart**, including the UI rework. Rebuild with
  `SKIP_QT6UI=1 cargo tauri build --no-bundle` (the `qt6ui` sub-build fails;
  it's a separate workspace-excluded crate only one test uses).
- `npm ci` in the UI dir can die with `EPERM` on a locked `rolldown` binding and
  leave `node_modules` half-installed. `npm install` repairs it.

## 4. Suite results (2026-07-28, Starling on 64738, today's build)

**23 passed / 54 failed / 27 cancelled** across 104 tests in 39 files.

Passing: `smoke.connect`, `messaging`, `audio.resample`, `channels`,
`voice-state`, `voice-state-sync` (4/5), `admin-create-role` (2/4),
`audit-log` (2/9), `hidden-channels` (1/8), `qt6ui-disconnect-ghost`,
`signal-pchat` (1/5), `server-compatibility` (1/3).

Cannot pass regardless of server — `forums` (10) uses `data-testid` values that
exist nowhere in the client; `channelviewer` (3) needs Ice on :5005;
`link-preview` (1) needs the plugin.

Genuine Starling gaps — `audit-log`: *"server_audit has no rows — ingest fan-out
not wired"*. `starling-voice` (7): cannot start a server, see §3. All 11
screen-share/WebRTC tests: see §5.8, which also explains the "plugin gating"
cancellations in `meetings`/`pchat-control-plane`/`scheduled-messages`/`calendar-*`.

Two numbers not to trust: `admin-channel-delete`'s "server did not crash"
assertion calls `isServerRunning()`, which inspects the **murmur shim**, not
Starling — it would pass with Starling dead. And 12 of the 27 cancellations are
`cancelledByParent`, not independent signals.

## 5. Open, not fixed

1. **`voice-state-sync`: "saved UNMUTED state should be restored after reconnect,
   true !== false"** — the only failure that could be a regression from §2.
   Probably not: it is *self*-mute, while the changes were moderator flags, and
   `announce_up` now sends `pending.self_mute`, which is `false` on a fresh
   reconnect exactly as `..Session::default()` was. **Unverified** — an A/B was
   impossible because `vendor/starling` has ~120 modified files of in-progress
   work, so stashing would revert far more than these changes. Either re-run the
   file alone to check for flakiness, or revert only the three
   `session-lifecycle` files for one build.
2. **The Register menu entry is missing in the stock client.** The client needs
   `p->iId < 0 && !p->qsHash.isEmpty() && (pPermissions & (Register|Write))`
   (`vendor/server/src/mumble/MainWindow.cpp:1817`). Permissions are fine
   (`Perm::SUPERUSER` includes `REGISTER`) and the gateway does request client
   certificates. The suspect was the flood at `handshake.rs:589`, which reads
   `hash` from **session-view** — empty before the §2.2 fix. **Retest after a
   rebuild; this may already be fixed.** Predicted signature if not: whoever
   connected *first* sees the entry, whoever connected *last* does not.
3. **`on_move` can move another user but a client cannot reach it** — the
   permission logic is all there, but the cross-session guard at
   `session-lifecycle/src/lib.rs:743-753` drops a `UserState` naming another
   session before `on_move` sees it, because `is_speak_state` is false for a
   plain move. Needs the same "route ahead of the refusal" exception `user_id`
   got. GAP-ANALYSIS U2 is right that it does not work, wrong about why.
4. **Self-deafen coupling is not echoed** — `set_self_flags` forces `self_mute`
   when self-deafening (`state.rs:341`), but the echo only carries what the
   client sent, so others render the user deaf but not self-muted. Same class as
   §2.3; the `echoed()` helper fixes it but needs a before-snapshot.
5. **`src/util/starling.ts` uses the removed `--port` flag** (§3).
6. **`npm run test:e2e` has no `--test-timeout`** (§3).
7. **The "native WebDriver missing" diagnostic in `src/driver.ts`** fires on any
   early tauri-driver exit, including port-in-use, and sends you to the wrong
   place. It should surface the driver log line.
8. **Starling never advertises a server Fancy version, and that alone hides
   every gated feature in the client.** This is the highest-leverage open item:
   one missing reply is responsible for all 11 screen-share/WebRTC failures and
   probably several of the "plugin gating" cancellations.

   Starling's Fancy `Hello` handler (`session-lifecycle/src/handshake.rs:686`)
   calls `connections.touch()` and returns `Actions::new()` — no reply at all.
   `fancy_version` exists in Starling **only** as the client's announced
   version; the server never states its own. The client sets
   `serverFancyVersion` from `info.fancy_version`
   (`ui/src/core/store/index.ts:2457`), so it stays `null` forever.

   Everything version-gated therefore never renders. Confirmed for screen share:
   the toggle exists in the standard UI
   (`ui/src/ui/standard/components/chat/ChatHeader.tsx:347`) and is in the
   test-id registry — it is **not** the forums-style drift — but
   `ChatView.tsx:1126` only passes `onToggleScreenShare` when
   `serverFancyVersion != null && serverFancyVersion >= SCREEN_SHARE_MIN_VERSION`
   — which is **0.2.12**, not "2.12.0" as an earlier revision of this document
   said. The encoding is `major<<48 | minor<<32 | patch<<16`
   (`ui/src/core/utils/version.ts:11`), so `2*2^32 + 12*2^16` reads as
   0.2.12. `vendor/server` advertises 0.4.2 and clears every gate; Starling
   advertised nothing and failed all of them. So all five screen-share/camera
   files fail on
   `[data-testid="screen-share-toggle"]` at 15–20 s **without ever reaching
   signalling or media**. The same pattern gates onboarding
   (`ONBOARDING_MIN_FANCY_VERSION`) and account settings
   (`ACCOUNT_MIN_FANCY_VERSION`), which is the likely cause of the
   `meetings`/`scheduled-messages`/`calendar-*` cancellations.

   Answering `Hello` with a version would convert a lot of silent files into
   real signal for very little code. **But pick the number honestly** — it is a
   claim about what Starling implements, and inflating it moves these tests from
   "never ran" to "ran and failed further in", which is worse to debug. Media
   relay stays absent regardless: GAP-ANALYSIS S2 is still accurate, there is no
   `str0m` dependency and `screenshare` is signalling-only, so
   `screenshare.performance` and `.gpu` cannot pass even past the gate.

## 5a. Fancy protocol epochs (done 2026-07-29, all three repos)

The versioning layer §5.8 asked for, implemented. **The range migration itself
is NOT done** — see "remaining" below.

`Version.fancy_protocol` (field **7**, `uint32`) added identically to all three
`Mumble.proto` files. It names the *wire numbering*, which `fancy_version`
structurally cannot: that is a product version, so a client reading it sends
features on whatever numbering it assumes, and against a renumbered server they
vanish silently. Epoch `0` = the interleaved 100–999 layout (every shipped
build); `1` = §3's scheme, one outer type ≥ 1000 per service.

* **Starling** — `FANCY_PROTOCOL = 1` in `handshake.rs`, announced in
  `server_version()`. It deliberately still announces **no `fancy_version`**:
  claiming one would be worse than silence, because a client would take it as
  licence to send epoch-0 natives that Starling routes nowhere. Pinned by
  `the_wire_epoch_is_announced_and_the_product_version_is_not`.
* **`vendor/server`** — `FANCY_PROTOCOL_EPOCH 0` in `CMakeLists.txt`, through
  `src/CMakeLists.txt` as a compile definition, set in `Server.cpp:1678`. Stated
  explicitly rather than left to default so "old Fancy server" is
  distinguishable from "server that has not been taught about epochs".
  **Not compiled — needs a Docker build to verify.**
* **`vendor/client`** — `FANCY_PROTOCOL_EPOCH` + `speaks_epoch()` in
  `fancy_codec.rs`; `select_codec` now takes the epoch and checks it **before**
  the version, so an unknown epoch drops to `LegacyCodec` however new the server
  claims to be. `server_fancy_protocol` is sticky in `state.rs` for the same
  reason `fancy_version` is. The client announces its own epoch too, so the
  judgement is symmetric. 239 crate tests pass, including three new ones.

Verified: starling `session-lifecycle` 65, starling e2e 22, workspace clippy
clean, client `mumble-protocol` 239. The e2e typing test stayed green with
Starling announcing the new field to a client binary that predates it — the
backward-compatibility case.

**Remaining, and it is the bulk of it:** moving the client from epoch 0 to
epoch 1 — giving each of the ~60 Fancy messages in
`mumble-protocol/src/fancy_message_support.rs` a home in a service envelope per
§3, and teaching `vendor/server` to speak epoch 1 as well if it is to stay
compatible. Until then the client can only *encode* epoch 0, so against Starling
it uses the `PluginData` path: `PluginData`-fallback features work, `ServerOnly`
ones are off. That split is now visible rather than silent, which is the point.

## 6. Changes to *this* repo (uncommitted)

- `src/selectors.ts` — import path `ui/src/testids` → `ui/src/core/testids`. The
  module moved in the client UI rework; the old path is a module-resolution
  failure at import time that took the **entire suite** down before a single
  test ran. No test files were touched.
- `vendor/client/target/release/.e2e-built-commit` stamped to `66a9241`.

## 7. State of the machine

Your `starling:local` docker stack was stopped for the final run and **has not
been brought back up**. The murmur shim compose was torn down. Ports 64738 and
64838 should be free.

*(Superseded on 2026-07-30 — see §9.)*

## 8. Avatars set on the website (2026-07-30)

The profile picture is set in **mumble-user-manager**, not in the Mumble client:
the backend owns accounts and profiles and pushes the picture to Starling over
the operator API. `src/tests/user-manager-avatar.multiclient.test.ts` drives that
whole path — sign up, confirm by email, claim the Mumble account, upload — and
then asserts two live clients see the picture. `src/pages/settings.page.ts` was
deleted with it: it drove a path nobody uses.

### 8.1 The account's profile never reached any client — Starling

Textures were stored on the account and broadcast to nobody. Fixed in
`session-lifecycle`:

- `Session` (`sessionview.proto`) gained `comment_hash` / `texture_hash`, and
  `PendingConnection` carries them from the login answer, which already
  contained them.
- All three `UserState`s that describe a user now include them: the peer's own,
  every roster entry, and the join broadcast. Hashes only — the body still comes
  from `RequestBlob`.
- `identify()` returns an `Identity` struct instead of a tuple, so the two
  `Vec<u8>` cannot be swapped silently.

### 8.2 `RequestBlob` looked accounts up by session id — `userdata`

`on_request_blob` passed the **session** id to `accounts.by_id`, which takes an
**account** id. Unrelated namespaces, so the answer was whichever account
happened to share the integer: usually none, occasionally somebody else's
avatar. It now resolves session → account through `session-view`, and answers
`session_comment` as well, which was not implemented at all.

### 8.3 An impersonation attempt was refused with the wrong code

`Outcome::NameTaken` mapped to `UsernameInUse`. That is murmur's `id == -1`
("Wrong certificate or password for existing user", `Messages.cpp:381`), which
is `WrongUserPW`. `UsernameInUse` says somebody is *online* under the name — a
client told that reconnects under a suffixed name, and it answers "is this
person connected right now" to anyone who asks. A genuine live duplicate never
reaches this arm; `duplicate_of` refuses that before authentication.

### 8.4 `started` on the live channel fired too early — `operator-api`

Only the session bridge set `live`, so the greeting went out while the *channel*
bridge was still attaching, and a channel created in that window produced no
event at all. The hub now counts attached bridges and is live at `BRIDGES` (4).
This was the flaky `a_channel_change_reaches_a_live_subscriber…` test — 2 in 3
failing before, 4 in 4 passing after.

### 8.5 Harness, not tests

- `sidebar.registerUser()` clicked the context-menu "Register" and stopped at
  the `ConfirmDialog` the client opens (`UserContextMenu.tsx:406`) — so **none**
  of the eleven files calling it registered anybody, and the dialog stayed up to
  swallow the next click. It now confirms. No test file's behaviour was weakened;
  they finally do what they say.
- `setSuperUserPassword()` / `isServerRunning()` (`src/util/server.ts`) try
  Starling's operator API first and fall back to `docker exec` on the murmur
  container. That is what unblocked the ~21 files that need SuperUser; §3's
  "bring murmur up purely to satisfy the shell-out" workaround is obsolete.
- `fixtures/avatar-sample.png` was a 92-byte hand-assembled PNG with a **bad
  IDAT CRC**. ImageSharp in the backend rejects it — after the upload returns
  200, because the Mumble sync is best-effort. Replaced with a real 64×64 PNG.

### 8.6 The user-manager stack itself

Three defects kept it from starting at all: the Starling healthcheck used
`wget` and the API healthcheck `curl`, neither of which exists in those images
(so both containers sat `unhealthy` while serving fine, and everything behind
`depends_on` refused to start); `/app/data` was root-owned under a non-root user;
and on a fresh volume EF tried to re-create tables `02-schema.sql` had just
made. Fixed in `docker-compose.yml`, `src/Dockerfile`, and a new
`database/init/05-ef-baseline.sql`.

## 9. State of the machine (2026-07-30)

- The **mumble-user-manager stack is up** (`mumble-server`, `mumble-auth-api`,
  `mumble-auth-db`, `mumble-auth-mailpit`), and its Starling owns 64738. Its
  SuperUser password has been set to `testpassword` over the operator API.
- `starling:local` was rebuilt from the current source.
- The old murmur fixture `fancy-e2e-mumble` **exited with 139** and was not
  restarted; nothing needs it any more (§8.5).
- **F: had filled to 0 bytes.** `target/debug/incremental` was deleted in both
  `vendor/starling` and `vendor/client` (≈62 GB). A full disk shows up as
  `link.exe` failures, "paging file is too small", and — worst — *stale test
  binaries silently running old code*.

### Green as of this run

`cargo clippy --workspace --all-targets -D warnings` and `cargo test --workspace`
both clean. E2E: user-manager-avatar (5), registration (5),
registered-name-impersonation (1), hidden-channels (8),
root-channel-visibility (1), smoke (2), messaging (2) — 24 passing.

## 10. Full suite sweep (2026-07-31)

All 41 files, one node process each with a 420 s timeout, against the
user-manager stack's Starling. **46 passing, 54 failing; 12 files fully green,
23 failing, 6 that executed no test at all.**

One process per file on purpose: `npm run test:e2e` sets no `--test-timeout`,
and `--test-timeout` bounds a *file* rather than a test — which is what
cascaded ~92 cancellations in §3. A process per file also lets the runner reap
`tauri-driver`/`msedgedriver` between files, so a timed-out file does not take
the next one down with a port it never released.

| Green (12) | Failing (23) | No tests run (6) |
|---|---|---|
| audio.resample 2/2 | forums 0/10 | fileserver |
| channels 2/2 | audit-log 1/9 | friend-chat-file-upload |
| hidden-channels 8/8 | camera-share 0/4 | scheduled-messages |
| messaging 3/3 | friend-chats 1/4 | screenshare.gpu |
| qt6ui-disconnect-ghost 1/1 | admin-create-role 2/4 | screenshare.performance |
| registered-name-impersonation 1/1 | signal-pchat 3/4 | starling-voice |
| registration 5/5 | channelviewer 0/3 | |
| root-channel-visibility 1/1 | screenshare 0/3 | |
| smoke.connect 2/2 | server-compatibility 1/3 | |
| user-manager-avatar 5/5 | calendar ×4 0/6 | |
| voice-state 2/2 | pchat 0/1, pchat-control-plane 0/2 | |
| voice-state-sync 5/5 | meetings 0/2, reactions 0/1 | |
| | link-preview 0/1, admin-channel-delete 0/1 | |
| | friend-chat ×2 0/2, fancy-control-plane 1/2 | |

**The failure count overstates the server's part.** Three groups:

1. **The client UI does not exist — 18 failures, and not a server gap at all.**
   `forums` (0/10) waits for `chat-header-kebab`, which appears **nowhere** in
   the client; it exists only in `ABSENT_FROM_CLIENT` in `src/selectors.ts`, the
   28-id shim for things this suite references and the client never had.
   `meetings` (0/2) and the four `calendar` files (0/6) fail identically. These
   are plugin-delivered features, missing at both ends — see
   `vendor/starling/docs/FANCY-PARITY.md` §1.
2. **Environmental.** `channelviewer` needs its own container (start it with the
   `channelviewer` compose profile), `camera-share` needs a camera, the
   screen-share files need the Tk capture helper and `E2E_PYTHON=py`.
3. **Real Starling defects — the useful residue.** Audit ingest fan-out (the
   test says so itself: `server_audit has no rows - ingest fan-out not wired`),
   pchat message delivery, reactions, link previews, admin channel delete, and
   role creation. Enumerated with citations in `FANCY-PARITY.md` §3.

The six "no tests run" files split three ways, and only three are skips:

- `fileserver`, `friend-chat-file-upload` — `describe(..., { skip })`, blocked
  on the client never receiving `fancy-file-server-config` plugin-data.
- `starling-voice` — module-level skip: no Starling binary at
  `vendor/starling/target/debug/starling.exe`.
- `scheduled-messages` — **not a skip**: its `before` hook died on
  `chat-header-kebab`, so it is group 1 above wearing a different hat.
- `screenshare.gpu`, `screenshare.performance` — `before` died waiting for
  `screen-share-toggle`. That id *is* rendered (`ChatHeader.tsx:347`), so this
  is a precondition that was not met, not missing UI. Worth a look; it is the
  one entry here whose cause is not yet established.

Reproduce with one process per file and reap the drivers between them; the
raw logs from this sweep are not kept in the repo.
