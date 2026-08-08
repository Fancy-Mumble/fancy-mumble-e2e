# The suite against Starling, measured

Baseline of **2026-08-08**, and the first one taken with a working instrument.

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

### 3.1 Blocked by one gap: Starling drops `pchat_protocol` (6 suites, 9 tests)

`signal pchat` x3, `persistent chat control messages`, `persistent chat: history
replay`, `meetings: server-provisioned E2E rooms`.

`pchat_protocol` exists **only** in Starling's `.proto` files. No Rust file
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

**Highest-yield fix on the board.** Nothing else in this cluster is worth
debugging until it lands, because none of it can currently be exercised.

### 3.2 Media path (6 suites, 13 tests)

`screen sharing` x3 (pixel fidelity, GPU fps, performance), `screen share:
delivery health`, `camera share` x1 suite / 4 tests.

The SFU is wired (`crates/sfu`); these measure frames actually arriving, decoded
and on time. Largest single effort on the list - schedule it last of the server
work. Note the fps floors are real assertions that a software-rendered display
fails on merit, which is what `E2E_SKIP` exists for on a machine without a GPU.

### 3.3 Audit (1 suite, 8 tests)

`audit log: ingest + admin viewer` - the hash-chain store, ingest, the admin tab
gate, the query and the chain-status card. Starling has an audit service, so
this is wiring rather than absence. Biggest single-suite win after 3.1.

### 3.4 Channel lifecycle (2 suites, 6 tests)

`channels: hidden, expiring + meeting rooms` (5 of 8 tests fail; **expiry and
sliding-expiry reaping now pass** - they went green the moment the harness bugs
were fixed, which is the whole argument for re-measuring before debugging), and
`admin: deleting a detached channel`. What remains is the meeting-room and
invitee flow.

### 3.5 Control plane and social (3 suites, 6 tests)

`Fancy control-plane fan-out` (polls, typing indicators), `reactions:
cross-client`, `multi-client: scheduled messages`.

### 3.6 Known flake (1 test)

`admin: creating a role via the Roles wizard` - "the wizard's top Back button
returns to the Roles tab". Times out under full-sweep load, passes in isolation
in ~750 ms, twice. Counted in the 34 the runner reports; not counted in the 33
above.

## 4. How to run it

```sh
npm run e2e                      # every shared-server file (~32 min)
npm run e2e -- --private         # the two files that bring their own server
scripts/red-set.sh               # only the red files (~21 min)
scripts/red-set.sh pchat         # one cluster
E2E_WAIT_MS=8000 scripts/red-set.sh   # a faster local loop
```

Build the client with `scripts/build-client.sh`, not a bare `cargo tauri build`
- see `docs/HANDOFF-e2e-remaining.md` for what the plain build leaves out.

## 5. The rule

**Zero unexplained reds.** Every red is either an open bug with an owner, or a
gate with a reason. The moment one is neither, it is the top priority - that
discipline is what keeps this file worth reading.
