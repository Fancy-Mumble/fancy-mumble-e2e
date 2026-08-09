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

**What is still red, and it is now the server:** the cross-client half -
decrypt-on-the-other-member, reconnect-resume, late-joiner post-join, read
watermark. With relay proven and "reached nobody" absent from a debug-level
log, the remaining suspect is the SKDM leg: `PluginDataTransmission` (type 26)
through the plugins service, which drops empty-receiver messages. Handed to
the session that owns it.

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

`multi-client: scheduled messages` is **not** in that set and will still be
red: the client has no scheduled-messages UI on the pinned commit - the ids the
page object drives are declared in `ABSENT_FROM_CLIENT` in `src/selectors.ts`,
same as forums. Starling now stores, times and delivers them (adopted from the
fork's `wip/forums-scheduled-e2e-fixes`), so this suite is waiting on the
client's `wip/forums-scheduled-testids` branch, not on the server.

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
- see `docs/HANDOFF-e2e-remaining.md` for what the plain build leaves out.

## 5. The rule

**Zero unexplained reds.** Every red is either an open bug with an owner, or a
gate with a reason. The moment one is neither, it is the top priority - that
discipline is what keeps this file worth reading.
