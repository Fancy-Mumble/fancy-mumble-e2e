# Handover - channel listeners in Starling

Written 2026-08-02. Everything described here is **committed**; nothing is left
in a working tree.

## What was asked

"The listen to a specific channel feature from mumble (`vendor/server`) is
currently missing in starling" - implemented to **full murmur parity**, which
was the scope explicitly chosen.

## Where the branches are

Every repo is committed. Three were in **detached HEAD** and now sit on real
branches - if you clone fresh, check these out, they are not merged anywhere.

| Repo | Branch | Head |
|---|---|---|
| `.` (e2e root) | `wip/audit-e2e` | root commit below |
| `vendor/starling` | **`feat/channel-listeners`** (new, was detached) | `f4f6545` |
| `vendor/channelviewer` | **`wip/starling-source-and-keycloak-auth`** (new, was detached) | `0ff870e` |
| `vendor/server` | `pr-4-audit` | `3e41938f0` |
| `vendor/client` | `new-ui-implementation` | `3091ed1` |
| `vendor/mumble-admin-frontend` | `master` | `421f85d` |
| `vendor/channelviewer-frontend` | `master` | `3e6f157` |
| `vendor/wren` | `main` | `b547661`, no changes |
| `vendor/docker` | detached, **no changes** | untouched |

### Submodules

All nine are now real submodules - `.gitmodules` entry, URL, branch key and local
`submodule.*` config. Three were not, and each failed in its own way:

* `vendor/mumble-admin-frontend`, `vendor/wren` and `vendor/channelviewer-frontend`
  were tracked as **bare gitlinks with no `.gitmodules` entry**. A clone resolves
  those to an empty directory it has no way to fill.
* `vendor/mumble-user-manager-backend` **was not tracked at all**, yet
  `src/util/user-manager.ts` and `src/tests/user-manager-avatar.multiclient.test.ts`
  reach into it by path. It was absent from this working tree entirely, so those
  tests could not run from a clean checkout. Pinned on
  `feat/starling-operator-api` - that branch carries
  `database/init/05-ef-baseline.sql` and the operator-API work
  `HANDOVER-starling-audit.md` §8.6 describes; `main` has neither.

The `branch` keys for `starling` and `channelviewer` also named branches that no
longer carried their pinned commits (`feat/gateway-services`,
`feat/starling-source`), so `git submodule update --remote` followed the wrong
ref. Both now point where the commits actually are.

Nothing in the harness references **wren** yet - no compose service, no fixture,
no test. It is tracked so it travels with the repo; wiring it in is still to do.

## What the feature does now

The gap was never the routing core. `RoutingSnapshot` could already fan out to a
listener and the tree could already hold one - but `UserState.listening_channel_add`
was read nowhere, so a client clicked "listen", the server parsed the message and
ignored it. That was `GAP-ANALYSIS` V5, now removed.

Implemented, service by service:

* **voice** (`crates/services/voice/src/routing.rs`) - `RoutingSnapshot::fan_out`
  returns a `Reception` per recipient carrying **context** and **gain**, folded
  the way murmur's `AudioReceiverBuffer.cpp:87` does: `min` on context, `max` on
  gain. So standing in a channel you also listen to is heard **once**, as normal
  speech, at unity - and a listener who turned a room down to 0.2 and then walked
  into it hears it at 1.0. `named_directly` and `context_for` are gone; the
  router just encodes what the snapshot decided.
* **metadata** (`tree_actor.rs`, `lib.rs`) - `Trees::listen` takes volume
  adjustments; `Trees::restore` puts a returning user's listeners back;
  `Trees::remove` cancels listeners on the channel *and its descendants* and
  reports them so clients can be told. **Fixed in passing:** entering a channel
  used to overwrite the membership wholesale, silently wiping every listener the
  session had.
* **session-lifecycle** (`lib.rs::on_listen`, `handshake.rs`) - the three wire
  fields are handled, `Perm::LISTEN` is checked per channel (continuing past a
  refused one, as murmur does), limits come back as `ChannelListenerLimit` /
  `UserListenerLimit` rather than as a missing permission, and a user's listeners
  are announced **after `ServerSync`** - upstream is explicit that a client may
  need its own session id first (`Messages.cpp:843`).
* **persistence** - new table `channel_listener`, keyed by **account** (guests get
  nothing, as upstream) and **disabled rather than deleted**, so a gain survives
  un-listening. Temporary channels are never written: the id is reused when the
  channel is collected.
* **config** - `broadcast_listener_volume_adjustments`, **off** by default as in
  murmur. Off means channels to everyone, gains to their owner alone; that takes
  two messages, because one message cannot have two audiences.
* **privacy** - a pre-1.4 client is warned it can be listened to without seeing
  it, gated on both ceilings being set, exactly as upstream gates it.

Cross-session listener changes are **refused**, including the volume adjustments.
Upstream leaves volume out of its own guard (`Messages.cpp:1285`), which lets a
moderator turn down a room inside someone else's client. That is a deliberate
deviation, commented at the call site.

## Tests

`cargo test --workspace` in `vendor/starling` is **green** (~1 200 tests).
`cargo fmt --all --check` clean; `cargo clippy --workspace --all-targets` clean in
every file this work touched.

New coverage: an end-to-end test driving the real wire path
(`a_channel_listener_hears_a_room_without_being_in_it` in `crates/starling/src/e2e.rs`)
plus unit tests for the context/gain fold, the two ceilings, the gain lifecycle
(set before listening, survives un-listening, unity forgets it) and the removal
cascade.

## Two things to know before you pick this up

**1. A start-up race in the e2e harness, now easier to hit.**

`a_client_holding_write_can_save_an_acl_table_and_read_it_back` (pre-existing, part
of the in-flight work - it does not exist at `HEAD`) fails intermittently. It is a
boot-timing race, and adding *any* migration to `metadata` widens the window.
Measured, on this machine:

| metadata schema | failures |
|---|---|
| no new migration | 0 / 20 |
| new migration, 2 statements | 11 / 40 |
| new migration, 1 statement | 4 / 40 |
| with `RUST_LOG` debug on (slower) | 0 / 10 |

The mechanism: `wait_until_serving` waits for metadata's **gRPC socket** to bind,
but its **client-plane attach to the gateway** lands ~50 ms later and nothing
waits for that. Under load the extra migration pushed metadata's boot out by
**1.39 s** - services each `fsync` their own SQLite file at once, with no WAL and
no `busy_timeout`.

Mitigated by cutting the migration to a single statement (the index on
`(server_id, account_id)` was redundant - the primary key is a left prefix of it,
so it was a second copy of an index the table already had, paid for on every
write). **Not fixed**, because the real fix is in the harness's readiness wait,
which belongs to the in-flight work rather than to this feature.

**2. Normal speech does not cross channel links.**

Noticed while reading the routing core, unrelated to listeners and **not fixed**.
murmur sends regular speech into linked channels when the speaker holds `Speak`
there (`Server.cpp:1380`). Starling's `Target::Normal` only ever gathers the
speaker's own channel - `links` is consulted for shouts and nowhere else. Two
linked channels therefore cannot hear each other at all, which is most of what an
operator links channels *for*. Worth its own gap entry.

## Still not done (unchanged from before)

`GAP-ANALYSIS` V6 (codec renegotiation), V7 (bandwidth in `ServerSync`), V8
(whisper permission invalidation), V9 (`VoiceTarget` naming an ACL group).
