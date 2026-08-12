# The suite against Starling, measured

Sweep of **2026-08-09**, after the runtime work (§4) and the keymap fix (§3.4):

```
48 suites   17 gated
86 tests    67 pass    8 fail    6 cancelled    5 skipped    14 min 57 s
harness df3c234+dirty  client 2dca6f5+dirty  starling 69bdaf2+dirty  waits 15000ms
```

Every remaining red has a named owner: the pchat cross-client cluster (SKDM
relay, §3.1), the media path (§3.2), and scheduled messages (client branch,
§3.5).

Baseline of **2026-08-08**, the first one taken with a working instrument:

```
47 suites   15 gated   14 green   18 red
81 tests    40 pass    34 fail    7 cancelled       31 min 33 s
harness 6545238  client 8f5599f  starling 063432b   waits 15000ms
```

Every run now prints that last line, because a sweep is evidence about a
*state*, and two sweeps that disagree are only interesting once you know
whether the code differed.

## What changed since 2026-08-06, and why the numbers are not comparable

The previous sweep read `50 pass / 40 fail / 16 cancelled` out of 106 tests.
That number was measured through three faults that have since been fixed, so it
was never a statement about Starling:

* **The client aborted on every message notification.** `tauri-plugin-notification`
  runs notify-rust's blocking D-Bus call on the async runtime; with zbus in
  tokio mode that panics, and `panic = "abort"` killed the process. Only
  *receivers* died, which is why multi-client suites failed in ways that looked
  like delivery bugs. Fixed in the client; proven by a control experiment.
* **Dropdowns stopped working.** The WebKitWebDriver that ships with 26.04
  refuses to click `<option>`, so every channel created through the editor
  silently lost its pchat protocol, expiry mode and room settings.
* **Confirmed joins reported failure.** `waitForMembership` used WebDriver's
  `getText()`, which returns only *rendered* text, on a sidebar row the CSS
  clips to an avatar initial. The user had moved; the check could not see it.

And the artifact was incomplete: `cargo tauri build` alone ships no
`libsignal_bridge.so`, no DeepFilterNet and no qt6ui. `scripts/build-client.sh`
now produces a complete one and checks it. DeepFilterNet went green on that
alone.

**Tests are also no longer counted the same way.** 15 suites now gate
themselves and drop out of the totals entirely, rather than failing on a
15-second timeout per assertion. 81 registered tests instead of 106 is that
change, not lost coverage.

## 1. Green (14 suites)

Two and three real client windows against a real server.

| Suite | What it proves |
|---|---|
| `multi-client: presence + messaging` | the thing a chat server is for |
| `registration` | sign up, confirm, use the account |
| `security: registered-name impersonation is rejected` | name is identity |
| `channels: SuperUser create + cross-client visibility` | the tree, live, to a second client |
| `root channel: occupants stay visible in the tree` | the root-channel regression guard |
| `voice fidelity` | real speech through the round trip |
| `voice-state sync`, `multi-client: voice UI state` | mute/deafen across clients and reconnects |
| `audio resampling 44.1k / 192k` | the capture path at both rates |
| `DeepFilterNet noise suppression` | the denoiser, once built with its feature |
| `link preview` | server-generated embeds |
| `server compatibility: control-path boundaries` | the frame limits |
| `smoke: connect + chat` | the whole rig |

## 2. Gated (15 suites) - not a statement about Starling

These skip in under a millisecond with a reason that names the fix. They are
not failures and are not counted as any.

| Why | Suites | To run them |
|---|---|---|
| Starling has no `fancy-calendar` plugin | calendar x4 | `E2E_SERVER_PLUGINS=fancy-calendar` once it ships |
| Starling has no `fancy-friends` plugin | friend-chat x3 | `E2E_SERVER_PLUGINS=fancy-friends` once it ships |
| Local service down | admin UI dashboard, channel viewer (Ice), user manager | bring up the compose profile / user-manager stack |
| murmur-only by design | `murmur: temporary group membership` | `E2E_SERVER_IMPL=murmur` with the Ice fixture |
| Artifact not built | `qt6ui: disconnect leaves no ghost session` | `scripts/build-client.sh` |
| Client feature not merged | forums, file-server upload, friend-chat upload | (unchanged; static skips) |

`friends.open` / `friends.room` / `__dm:` provisioning and the calendar surface
appear nowhere in Starling's source. Those suites measure roadmap features, and
belong on a roadmap rather than in a failure count.

## 3. Red (18 suites, 33 real failures)

### 3.1 The encrypted cluster: two server gaps, both now closed (6 suites, 9 tests)

**Update 2026-08-09.** Both server-side gaps below are fixed and verified. The
cluster is still red, but the remaining fault is client-side rendering, not
delivery. Read this section as history plus one live handover.

The second gap was **not** a delivery bug: the client never sent an encrypted
message at all. Starling announced `fancy_protocol = 1` but deliberately no
`fancy_version`, and the client keys far more off that field than the decision
anticipated - `send_message` sets `message_id` only when `fancy_version` is
present, and the encrypted path is keyed on that id, so it built no ciphertext
and shipped nothing. The channel was correctly `signal_v1` at both ends, the
Signal banner rendered, and nothing crossed it. The only trace was the plaintext
half of the client's dual path: one `TextMessage` of `length=19`, which is
exactly `[Encrypted message]` - the placeholder the client sends *because* it
knows the channel is encrypted.

Fixed in Starling: `fancy_announcement` (`session-lifecycle/src/handshake.rs`)
sends a second `Version` carrying `fancy_version = 0.4.2`, but only to a peer
that announced epoch 1, so an epoch-0 client still gets the silence that keeps
it on `PluginDataTransmission`. Verified end to end - the server now logs
`stored an encrypted message ... bytes=173 protocol=4` for every send, where
before it logged no pchat frame at all. Relay to other members is proven
separately by `an_encrypted_message_reaches_the_other_member_of_its_channel`
(`crates/starling/src/e2e.rs`), two clients over real TCP+TLS.

Two things fell out of it. The same number gates the audit tab (0.4.2), so §3.3
may have lost a blocker; and the client picks its UDP voice cipher from it, so
both ends now agree on XChaCha20 where Starling had already chosen it and the
client was still on OCB2.

**Resolved (later that night): the "render gap" was the harness, and the
client was never broken.** The probe above was run and the backend bucket
contained `probeßtokenß…` - the compositor keymap types "-" as "ß" in the
composer, focus-dependently, so every hyphenated token was *sent mangled* and
`waitForText` could never match. Encryption round-tripped the whole time. With
the composer switched to DOM-injected input (see `util/astral.ts`), `bridge
smoke` and pin/unpin are GREEN.

**Update 2026-08-09, later (Agent A handoff, session ending on credits - not
finished, do not re-derive, continue from here):**

The cert-isolation hypothesis below (grep for `certificate=`) is **dead**.
Two independent probes (one launching 3 clients concurrently exactly as the
suite does) got 3-of-3 distinct hashes. Do not re-run that probe.

Three real, verified bugs found and fixed this session, all in `vendor/client`
(uncommitted - see file list at the end of this entry):

1. **SKDM sender_hash was always empty.** `PchatSenderKeyDistribution` has no
   canon form, so it rides Starling's opaque `PluginDataTransmission` relay,
   which never parses it - the client's comment "server fills this on relay"
   was never true. Every receiver filed the sender's key under no identity;
   single-client echo passed because it needs no key exchange. **Fix:** sender
   now self-identifies (`own_cert_hash`) in
   `command/send_pchat_sender_key_distribution.rs` +
   `state/pchat/signal_bridge.rs::send_signal_distribution`. Safe against
   impersonation - a server that does parse the field overwrites it with the
   authenticated sender, per `a_sender_key_distribution_reaches_the_member_it_names`.
   Verified directly in a client log: `pchat msg-deliver: decrypted OK`.

2. **Forward-secrecy leak, exposed (not caused) by Agent B's unrelated
   `PchatFetchResponse` canon fix.** `signal_v1` is documented to keep no
   server-side history, but the client requests channel history unconditionally
   on join/key-exchange/mode-change with no protocol guard, and Starling stores
   signal_v1 ciphertext too (for redelivery to a briefly-offline member) and
   serves it to any fetch, joiner or not. Before B's fix the client silently
   dropped the unparsed response, which accidentally provided the forward-secrecy
   guarantee as a side effect of a different bug. **Fix:** guarded all four
   fetch call sites against `PchatProtocol::SignalV1` -
   `state/handler/server_sync.rs::fetch_channel_history`,
   `state/handler/user_state.rs::pchat_init_task`,
   `state/pchat/key_exchange.rs::retry_decrypt_pending_messages`,
   `state/handler/channel_state.rs::pchat_key_gen_and_fetch`. Verified none of
   these skip anything else load-bearing (archive-key derivation is already a
   FancyV1FullArchive-only no-op inside `derive_and_store_archive_key`; SignalV1
   live-message decrypt-retry runs entirely through
   `signal_bridge.rs::retry_stashed_signal_envelopes`, independent of fetch).
   **Server-side enforcement landed by Agent B** in `crates/services/pchat`:
   signal_v1 rows are no longer archived or served at all (belt-and-braces -
   a client-side skip is an agreement, not a guarantee).
   Confirmed by test: `forward secrecy for late joiners` passed clean.

3. **Found by Agent B, not verified end-to-end by me:** a Fancy sender emits
   both dual-path halves (plaintext `TextMessage` placeholder + encrypted
   `PchatMessage`) under the *same* `message_id`. Starling's text relay always
   preserved that id; its pchat relay used to mint its own uuid7, so the two
   never collided - until B's own fix made the pchat relay preserve it too.
   `state/pchat/inbound.rs::insert_or_replace_message` was a plain first-wins
   dedup on that id, so whichever half a receiver got first stuck, and since the
   plaintext placeholder is smaller and sent first, a real decrypted message was
   routinely **silently dropped**, rendering `[Encrypted message]` forever - a
   rendering failure indistinguishable from a decrypt failure from the outside.
   B landed the fix (asymmetric: a real message always replaces a same-id
   placeholder, a placeholder never overwrites a real message; pin state carried
   over) directly in that function - I read and confirmed the logic, did not
   write it. **Still open:** no client build with this fix has been verified
   against `signal-pchat.multiclient.test.ts` yet - my last two full runs both
   predate it in the built artifact.

Also identified, not yet fixed (nobody's fix landed as of this handoff, low
priority - doesn't block the 3 owned tests, causes duplicate/legacy-badged
bubbles, not silent drops): **no client code ever sets `FeaturePchatE2ee` on an
outgoing `UserState`** (`state/types/ui.rs::has_pchat_e2ee` only ever reads it -
grep confirms zero production setters). `text_message.rs::handle_channel_message`
therefore treats every pchat message as coming from a "legacy" sender and always
inserts the plaintext placeholder bubble alongside the real one. With bug 3's
fix this stops being a silent-drop risk and becomes purely cosmetic (a redundant
"legacy"-badged ghost bubble next to the real message).

**Rig-wide outage, fixed:** mid-session, `src/util/starling.ts` briefly generated
`[[instances]]` instead of `[[virtual_servers]]` in the Starling TOML - a
Starling-side rename landing out of sync with the harness - which made
`StarlingServer.start()` fail for every agent with "unknown field `instances`".
Reverted, then re-landed correctly once the Starling side caught up; confirmed
working as of 13:48. **It cannot recur:** `instancesTable()` now reads the binary
it is about to spawn and writes the table name that binary knows, so harness and
server can no longer disagree about the vocabulary.

**Verification status:** NOT complete. Two full runs of
`signal-pchat.multiclient.test.ts`:
- Run 1 (client built ~13:12, before bug 2's fix): 1/4 pass (bridge smoke only).
- Run 2 (client built ~13:41, after bug 2's fix, before bug 3's fix landed):
  3/4 pass (forward secrecy, reconnect-resume, bridge smoke all green); the
  3-way concurrent-decrypt test timed out waiting for a DOM update, not a
  decrypt/assertion failure.
- Run 3 (immediate re-run of just the failing test, same binary, zero code
  changes): all three previously-green tests timed out identically - most
  likely rig contention (several agents' builds running concurrently), but see
  bug 3 above for a second, code-verified candidate explanation for exactly
  this failure shape (message silently dropped, `waitForText` times out because
  the real token is never in the DOM).

**Next step for whoever picks this up:** rebuild `vendor/client` (bug 3's fix is
already on disk, uncommitted; `CROS_LIBVA_H_PATH=/tmp/libva-2.22/usr/include
E2E_BUILD_NO_CLI=1 scripts/build-client.sh`), then run
`signal-pchat.multiclient.test.ts` twice clean under the rig lock (mkdir
`.tmp/rig.lock`, write `owner`, confirmed single-writer per the coordinator's
corrected protocol). If still red on the 3-way test specifically, check rig
contention first (are other agents' cargo builds running?) before assuming a
new code bug - re-measure before debugging.

**Files changed, all in `vendor/client`, all uncommitted as of this handoff:**
`crates/mumble-protocol/src/command/send_pchat_sender_key_distribution.rs`,
`crates/mumble-tauri/src/state/pchat/signal_bridge.rs`,
`crates/mumble-tauri/src/state/handler/server_sync.rs`,
`crates/mumble-tauri/src/state/handler/user_state.rs`,
`crates/mumble-tauri/src/state/pchat/key_exchange.rs`,
`crates/mumble-tauri/src/state/handler/channel_state.rs` (mine, bugs 1-2), plus
`crates/mumble-tauri/src/state/pchat/inbound.rs` (Agent B, bug 3) and
`crates/services/pchat/*` in `vendor/starling` (Agent B, server-side forward-
secrecy enforcement). None committed - do not lose this working tree.

Untracked scratch probes left in `src/` (`probe-a-decide.test.ts`,
`probe-a-verify.test.ts`, `probe-a-filelog.test.ts`, `probe-certs.test.ts`,
`probe-skdm.test.ts`, `probe-xdecrypt.test.ts`): diagnostic only, safe to
delete once the suite is verified green, not needed for the fix itself.

---

The SKDM leg was the named suspect and it has been **cleared**.
`a_sender_key_distribution_reaches_the_member_it_names`
(`crates/starling/src/e2e.rs`) sends a `fancy-native:121` payload through
`PluginDataTransmission` from one real client to another over TCP+TLS: the key
material crosses untouched, the `data_id` survives, and the server stamps the
true sender over the forged one. The empty-receiver drop never fires, because
the client fills that list. Every server-side leg of cross-client decryption is
now proven by a test: the message relay, the key relay, and the certificate
hash, which `UserState` carries for both the joiner and everyone already there.

So the remaining fault is in front of the server. The cheapest next check, and
it would explain the entire remaining red set at once: **grep the server log for
`certificate=` during a three-client run and confirm three distinct hashes.**
The Signal ladder is keyed on the certificate hash end to end (`peer_keys`,
channel originators, `Message.sender_cert`), so if the per-instance
`FANCY_E2E_DATA_DIR` isolation ever hands two instances the same certificate,
every peer looks like one identity: sender keys collide, cross-client decrypt
fails, and single-client tests keep passing because a local echo needs no
ladder. That is the shape of what is left.

The late-joiner path needs no server work, contrary to what the suite's comments
about murmur's `sendStoredSenderKeyDistributions` suggest: the client
re-distributes sender keys itself whenever a remote user enters a `signal_v1`
channel (`state/handler/user_state.rs`, `handle_remote_channel_move`).

### 3.1a The original gap: Starling drops `pchat_protocol` (fixed 2026-08-09)

*Kept in the past tense it was written in, because it is the first half of the
story above and the two failures looked identical from the outside.*

`signal pchat` x3, `persistent chat control messages`, `persistent chat: history
replay`, `meetings: server-provisioned E2E rooms`.

`pchat_protocol` existed **only** in Starling's `.proto` files. No Rust file
reads, stores or echoes it, and the `channel` table has no such column:

```
server_id, id, parent_id, name, description, position, max_users, flags,
expiry_mode, expiry_duration_s, created_at_ms
```

So the client sends `SetChannelState { pchat_protocol: SignalV1 }`, Starling
keeps every other field and silently discards that one. No channel can ever
*be* encrypted, the persistence banner never renders, and every E2E suite fails
on its first assertion. Verified end to end: a channel created as `signal_v1`
comes back from the operator API with no persistence field at all.

The pchat message store already exists and is wired (`pchat_message` even has a
`protocol` column), so this is plumbing rather than a new subsystem: add the
column and serialize it in `crates/services/metadata` the way `expiry_mode` and
`expiry_duration_s` already are, then echo it in ChannelState.

**It was the highest-yield fix on the board, and it moved no counter**, which is
the lesson worth keeping: it unblocked channel state, and the cluster then
failed one layer deeper, on the announcement gap in §3.1. A fix that changes
nothing on the scoreboard is not the same as a fix that changed nothing.

### 3.2 Media path (6 suites, 13 tests)

`screen sharing` x3 (pixel fidelity, GPU fps, performance), `screen share:
delivery health`, `camera share` x1 suite / 4 tests.

The SFU is wired (`crates/sfu`); these measure frames actually arriving, decoded
and on time. Largest single effort on the list - schedule it last of the server
work. Note the fps floors are real assertions that a software-rendered display
fails on merit, which is what `E2E_SKIP` exists for on a machine without a GPU.

**Server side landed 2026-08-09.** Starling now advertises
`webrtc_sfu_available` in the handshake's `ServerConfig` whenever the
screenshare block has a literal-IP `public_url` - the same predicate
(`ServiceConfig::media_ip`) its SFU boots on, so the advertisement and the
media plane cannot disagree. The harness config (`util/starling.ts`) now sets
that block, and a wire probe against the release binary confirmed the flag and
the SFU's UDP bind. The client's "no WebRTC relay configured" warning is gone;
what remains for this cluster is measurement - display/GPU conditions, not
server work.

**And the measurement was broken in four places, none of them the SFU
(2026-08-09).** Every media red died *before* a frame was ever asked for. The
transport was never reached, so nothing here was evidence about `crates/sfu`:

* **The desktop is Wayland, so the client could enumerate nothing.** xcap's
  `wayland_detect()` keys off `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`; on a
  Wayland session `Window::all()` returns empty and the picker falls back to
  two synthetic "(system picker)" cards whose ids are advisory. A suite asking
  for a window *by title* can never match one - "picker never offered a window
  source titled like ...". The media suites now launch their clients with an
  X11 identity (`util/capture-env.ts`): xcap takes its xcb path on XWayland,
  and a dead `DBUS_SESSION_BUS_ADDRESS` makes the portal fail inside its 5 s
  pre-dialog timeout instead of waiting forever on a compositor dialog
  WebDriver cannot answer.
* **The checkerboard was invisible to every enumerator anyway.** The helper
  asked for "borderless" with `overrideredirect(True)`, which bypasses the
  window manager - and a window the WM does not manage never enters
  `_NET_CLIENT_LIST_STACKING`, the property xcap reads. Measured across five
  window types (normal, override-redirect, splash, dock, utility): override is
  the only one missing from the list. It is a splash-type window now -
  undecorated, topmost and at the exact geometry, but *managed*.
* **On Linux the viewer is a `<canvas>`, and every wait named `<video>`.**
  WebKitGTK has no WebRTC, so the client decodes in Rust and paints into
  `stream-native-view`; `stream-viewer-video` never mounts. That is precisely
  the GPU suite's "own preview never appeared in 30 s" against a stream that
  was arriving. `stream.page.ts` now selects either surface, sizes through
  `videoWidth || width`, and counts decoded frames on the canvas by tallying
  the paint path's `drawImage` calls - the stand-in for
  `getVideoPlaybackQuality`, which a canvas does not have.
* **The camera suite failed on a leaked modal.** With no cameras on the
  machine, step 1 skipped *while the picker was still open*, so step 2's
  toggle click hit the modal backdrop (`ElementClickInterceptedError`, 4 ms
  in, nothing to do with cameras). `closePickerIfOpen()` now runs in
  `afterEach`.

**Entire-screen sharing is gated, not red.** `XGetImage` on XWayland's root
window fails with `BadMatch` - the root is a bounding box no compositor paints
into - so a whole-screen capture yields nothing on a Wayland session however
the client is configured, and the portal alternative needs a human to answer
its dialog. `entireScreenCaptureUnavailable()` skips that suite with the fix
named (run it from an X11 session). Window shares are unaffected, which is why
fidelity, delivery health and the performance floors stay measurable here.

### 3.3 Audit (1 suite, 8 tests)

`audit log: ingest + admin viewer` - the hash-chain store, ingest, the admin tab
gate, the query and the chain-status card. Starling has an audit service, so
this is wiring rather than absence. Biggest single-suite win after 3.1.

### 3.4 Channel lifecycle - CLOSED 2026-08-09

`channels: hidden, expiring + meeting rooms` is **8/8 green**. The entire
meeting-room and invitee flow was one harness bug: the channel editor's
invitee picker was the last input still typed with `sendKeys`, and the
compositor keymap turned the hyphens in `e2e-bob-<sfx>` into "ß", so the
picker's filter could never match a registered invitee (verified live -
the input held `e2eßpickßbobß71938`). One line, DOM-injected like every
other input (see `util/astral.ts`), and the suite went green - which also
end-to-end-confirms Starling's `invitee_user_ids` → private-room ACL path
against a real client.

`admin: deleting a detached channel` is gated, not red: the `__dm:` channel it
deletes is minted through the Friends surface, which Starling does not have -
the same class as the friend-chat gates in §2.

### 3.5 Control plane and social (3 suites, 6 tests)

`Fancy control-plane fan-out` (polls, typing indicators), `reactions:
cross-client`, `multi-client: scheduled messages`.

**Measured 2026-08-09 against a rebuilt client and a release Starling:
`Fancy control-plane fan-out` is 2/2 green** (was 0/2) - typing indicators and
the poll, vote and tally. Four faults, all in `social`, and each of them made
the feature do nothing rather than do it wrongly:

* Fan-out was a `Send` naming nobody, which reaches the whole server. It now
  addresses the channel through the same `session-view` roster `text` uses.
* The actor was whatever the peer wrote, and the client writes 0 because it
  does not know its own session id at that layer. Every shipped client drops a
  typing indicator or a poll whose actor is 0. The server stamps them now, as
  murmur does.
* A poll and a vote were answered with `PollState`, a tally message no client
  decodes. The poll and the vote are relayed instead, which is what the client
  reads and what murmur sends.
* A reaction was relayed to everyone *except* the sender, and the client has no
  optimistic update - so the reactor never saw their own pill.

Two of those needed a field the canon did not have (`PollVote.channel`,
`Reaction.actor_cert`); both are additive and both trees moved together. **The
client had to be rebuilt for the vote to count**: the server can stamp a
channel onto a vote, and until the client's `canon.rs` reads it, the client
still drops the vote it cannot route.

`reactions: cross-client` is **still red, and now fails one layer later**. Two
faults were in front of it and both are fixed: `reactToMessage` clicked the
action-bar copy of the emoji button, which the context menu's own overlay
intercepts (`ElementClickInterceptedError`, several frames from anything to do
with reactions), and the server excluded the reactor from its own relay. The
click now lands and the pill never renders on either client. The server half is
proven over a real TLS socket by `a_reaction_reaches_the_channel_including_the_
person_who_sent_it` in Starling's own e2e, so what is left is between the relay
and the pill. `E2E_STARLING_LOG="info,starling_social=debug"` now logs a reason
for every refused reaction, which is the next thing to read.

**Update 2026-08-09, later the same day: `multi-client: scheduled messages`
is green, 3/3 twice.** `wip/forums-scheduled-testids` predated the dual-UI
restructure and the epoch-1 canon by enough that it was a port, not a merge:
new `FancyForumPost`/`FancyScheduledMessage*` wire types (157-165) into
`message.rs`/`transport/codec.rs`/`fancy_message_support.rs`, and - since the
branch predates epoch 1 entirely - a canon form the branch never had, routing
scheduled messages through the `TEXT` (1005) service so the server doesn't
silently drop them to the `PluginData` relay. The UI landed as a proper
`AppState` slice (`core/store/slices/scheduled.ts`, cleared on disconnect via
`INITIAL`, same pattern as `downloads`/`presence`) rather than the branch's
standalone zustand store, and the ids moved out of `ABSENT_FROM_CLIENT` in
`src/selectors.ts` along with `chatHeaderKebab`/`kebabMenuItem` (the kebab
menu itself had no `data-testid`s at all before this).

**The rebuild itself found a real bug**, which is the point of rebuilding
before declaring victory: `ScheduledMessagesPanel`'s own header button sat
under `ResizableSplitPanel`'s shared close (×) overlay
(`position: absolute; top/right: 8px; z-index: 25` in `PanelCloseButton.
module.css`) and ate its click (`ElementClickInterceptedError`) - the same
class of bug as the reactions fix two paragraphs up. Fixed with the
`padding: 44px` right-inset convention `DownloadsPanel` already used for
exactly this. `forums` is untouched and still gated - no UI for it landed,
so `ABSENT_FROM_CLIENT` still carries its ids.

A full sweep against the rebuilt client (85 tests, 69 pass, 2 fail, 10
cancelled) found no regression from it: the one new-looking red
(`channels: hidden, expiring + meeting rooms`) was a load flake, 8/8 green
re-run standalone; the other (`persistent chat control messages`'s read
watermark) and the cancelled screen-share cluster (`Failed to initialize GTK
backend!` under `capture-env.ts`'s forced X11 env, reproducible standalone)
both predate this change and sit outside the files it touched. Detail on both:
`vendor/starling/FLEET-PLAN.md`.

### 3.6 Flaky under load - the number has a noise floor of about +/-4 tests

Two suites flip between runs and pass reliably in isolation, so **any change
smaller than roughly four tests is invisible in a full sweep**. Read a
sweep-to-sweep difference as noise until a per-file re-run says otherwise.

| Suite | Tests | Evidence |
|---|---|---|
| `admin: creating a role via the Roles wizard` | 1 | times out under load; passes in ~750 ms in isolation, twice |
| `server compatibility: control-path boundaries` | 3 | green in one sweep, all three red in the next, 3/3 in isolation |

Both are timing races in multiclient message assertions - the same class as the
fixed sleeps removed from `signal-pchat`. Worth fixing before chasing further
green, because until then the scoreboard cannot show small progress.

A second sweep taken after the `pchat_protocol` and handshake fixes read
`38 pass / 40 fail / 88 tests`. Every part of that delta is accounted for:
`server compatibility` flaked red (-3), the role wizard flaked green (+1), and
`discord-rich-presence` arrived as 7 new tests for a feature still in progress.
The server fixes moved no counter, which is expected - they unblocked channel
state, and the pchat suites now fail one layer deeper, on message delivery.

## 4. How to run it

```sh
npm run e2e                      # every shared-server file (~17 min)
npm run e2e -- --private         # the two files that bring their own server
scripts/red-set.sh               # only the red files
scripts/red-set.sh pchat         # one cluster
E2E_WAIT_MS=8000 scripts/red-set.sh   # a faster local loop
```

### Why ~17 min and not ~32 (2026-08-09)

Measured A/B on one machine, same pinned binaries, three full sweeps:
32:47 (before) → 25:47 (parallel per-suite setup) → 17:12 (all three changes).

* **Suites launch and connect their clients concurrently** (`TauriApp.launchAll`
  + `Promise.all` connects, the pattern `server-compatibility` already used).
  Password typing is serialized behind a gate in `connect.page.ts` - it is the
  one wizard step using real key events, which contend for focus on a shared
  display. Worth knowing: a client launch itself costs ~1.6 s, not the ~16 s
  older comments claim - the expensive part was everything after it.
* **`waitLoaded` no longer burns 12 s per client probing for modals.** The
  welcome-modal and plugin-trust probes were serial 4 s + 8 s waits that always
  timed out against the e2e Starling (no welcome text, no plugins). One
  combined ~2.5 s watcher answers whichever modal appears, extending its watch
  when one does. The redundant explicit `allowServerPlugins` calls after
  `waitLoaded` (which already probes) are gone.
* **Step-chains** (`src/util/steps.ts`): in suites whose tests are strictly
  sequential steps of one flow (screenshare fidelity, camera share, meetings,
  hidden-channels' meeting-room block), a failed step makes the rest skip with
  the failed step named, instead of each waiting out its own 15-20 s element
  timeouts against state the flow never created. One red per cause; every
  skip says why. Independent capabilities keep plain `it`.

What still costs time is honest: red suites failing once per cause, and real
product waits (scheduled delivery, expiry reaping, voice sampling windows).

Build the client with `scripts/build-client.sh`, not a bare `cargo tauri build`
- see `vendor/starling/FLEET-PLAN.md` §10 for what the plain build leaves out,
and the libva / patchelf / inotify traps that come with it.

## 5. The rule

**Zero unexplained reds.** Every red is either an open bug with an owner, or a
gate with a reason. The moment one is neither, it is the top priority - that
discipline is what keeps this file worth reading.
