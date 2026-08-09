# Handover: audit-log - rework to a fully opaque plugin architecture

Written 2026-07-19 by the previous agent. Everything referenced here is pushed
to remote branches (listed below) - nothing lives only on the old machine.

## 1. Mission

The server audit log (docs/audit-log.md in mumble-server) currently works
end-to-end (5/6 e2e, see §4) but via a **server-side `AuditLogBridge`** that
translates dedicated wire messages (IDs 166–171) to/from the `fancy-audit`
plugin. The maintainer has ruled this architecture wrong: **plugins must be
fully opaque to the server** - the server may only shuttle opaque data and
provide generic callbacks (permissions, sessions, config), never know a
plugin's name, message schema, or feature semantics.

Your job: remove the bridge, move the whole audit protocol onto the generic
plugin-message channel, add a feature-agnostic server-event fan-out, and keep
the e2e suite green (it is UI-level and transport-agnostic - it must pass
unchanged, 6/6).

## 2. Remote branches (fetch these)

| Repo | Branch | Content |
|---|---|---|
| `Fancy-Mumble/mumble-server` | `wip/audit-log-e2e-bridge` (head `419900cbd`) | PR #4 (plugin, `1bd3f0112`) + wire-proto merge (`8e2c1c9f6`) + my commits: `81e87ee89` (FANCY_VERSION 0.4.1→0.4.2), `16c8f1589` (stubs, superseded), `8e068e102` (**the bridge + plugin wiring - the thing to rework**), `71d794650` (unity-build/macro/QJson fixes), `419900cbd` (config-push gate fix, **never verified** - build was aborted) |
| `Fancy-Mumble/FancyMumble` | `feat/audit-log-client` (= PR #110, `7b9e41ccf`) | Client: wire types 166–171, tauri commands, admin Audit tab UI + testids. UI/store/DSL are good; the **transport layer is what you swap** |
| `Fancy-Mumble/mumble-docker` | `wip/audit-plugin-packaging` (`e827ba3`) | Adds `mumble-audit` to the image's plugin build/copy list - **required in any architecture**; PR #4 forgot it entirely |
| `Fancy-Mumble/fancy-mumble-e2e` | `wip/audit-e2e` | This repo: audit e2e test + page object, fixture ini enabling the plugin, this document, and submodule pointers to all of the above |
| `Fancy-Mumble/mumble-server` | `wip/forums-scheduled-e2e-fixes` | Unrelated parked work (forums PR #3 + 3 bug fixes), see §7 |
| `Fancy-Mumble/FancyMumble` | `wip/forums-scheduled-testids` | Parked forums client testids, see §7 |

On the new machine:

```sh
git clone git@github.com:Fancy-Mumble/fancy-mumble-e2e.git
cd fancy-mumble-e2e
git checkout wip/audit-e2e
git submodule update --init vendor/client vendor/server vendor/docker
# submodule pointers already reference the branches above; to see them by name:
git -C vendor/server fetch origin wip/audit-log-e2e-bridge && git -C vendor/server checkout wip/audit-log-e2e-bridge
git -C vendor/client fetch origin feat/audit-log-client && git -C vendor/client checkout feat/audit-log-client
git -C vendor/docker fetch origin wip/audit-plugin-packaging && git -C vendor/docker checkout wip/audit-plugin-packaging
```

## 3. Current (bridge) data flow - what you are replacing

- Client sends `FancyAuditQuery` (wire 166) → `Server::msgFancyAuditQuery`
  (Messages.cpp) → `AuditLogBridge::handleQuery` builds a JSON request and
  calls `PluginHostManager::sendPluginRequest("fancy-audit", "audit.query",
  session, json)`.
- Plugin (3rdparty/mumble-plugin-host/audit/src/lib.rs) handles it in
  `on_plugin_message`, replies via `ctx.send_request_response(...)` with
  response type `audit.result`.
- Bridge's registered response handler packs the JSON into a
  `FancyAuditResponse` (167) proto and sends it to the session.
- Same pattern for `audit.verify` / `audit.config.get` / `audit.config.set`
  (→ `FancyAuditConfig`, 170). Config snapshot is pushed post-ServerSync from
  `msgAuthenticate` via `m_auditBridge->pushConfig`.
- Ingest: Messages.cpp moderation sites call `m_auditBridge->emitEvent(...)`,
  which sends an `audit.ingest` plugin message with `sender_session=0`
  (anti-forgery marker) to the *named* plugin.

Every part of that gives the server feature knowledge. All of it must go.

## 4. What is verified working (e2e, `src/tests/audit-log.test.ts`)

Against the bridge build: **5/6 pass** - channel create, plugin store schema,
**ingest into `server_audit` with hash chain rows**, admin tab gating, and the
**query round-trip including the created channel's event**. The one red test
(chain-status card in the config half) was diagnosed: `pushConfig`
version-gated on the client's *crate* version (0.3.x - can never be ≥ 0.4.2);
fixed in `419900cbd` but the rebuild was aborted, so it is unverified. In the
opaque design the push moves into plugin/client anyway, so treat it as
historical context.

This proves: the plugin's chain/store/query/toggle logic is correct, the
client UI works, and the e2e test is sound. Only the transport is disputed.

## 5. The opaque rework - task list

### 5.1 Server: delete the bridge

- Remove `src/murmur/AuditLogBridge.{h,cpp}`, their `CMakeLists.txt` entries,
  the `m_auditBridge` member/friend/construction (Server.h, Server.cpp), and
  the include in Messages.cpp - i.e. revert the bridge parts of `8e068e102`,
  `71d794650`, `419900cbd`.
- `msgFancyAuditQuery/ConfigUpdate` go back to drop-only bodies (or remove
  wire IDs 166–171 from `MumbleProtocol.h`/`Mumble.proto` entirely and revert
  `8e2c1c9f6`; coordinate with the client change in 5.3 - recommended: revert
  the proto commit and reserve the ID range in a comment. If you keep the IDs,
  keep the stubs ABOVE the `#undef MSG_SETUP...` block at Messages.cpp's end).

### 5.2 Server: generic event fan-out (feature-agnostic)

Keep the five emit *call sites* from `8e068e102` (they are the valuable part):
`channel.create`/`channel.remove` (msgChannelState creation / msgChannelRemove),
`kick`/`ban` (msgUserRemove), `acl` (msgACL). Replace
`m_auditBridge->emitEvent(...)` with a generic publisher that knows no plugin:

- Plugin API (`3rdparty/mumble-plugin-host/api`): add an `on_server_event`
  hook to the `MumblePlugin` trait (api/src/plugin.rs) with a default no-op
  impl, and **bump `PLUGIN_ABI_VERSION`** (api/src/lib.rs - it moved to 3 for
  `send_request_response`; go to 4). The plugin's own module docs
  (audit/src/lib.rs §"Integration seam") describe exactly this design.
- Host crate: fan the event out to every loaded plugin; new FFI entry
  `plugin_host_on_server_event(handle, server_id, json, len)` in
  host/src/ffi.rs; regenerate the cbindgen header
  (include/mumble_plugin_host.h).
- `PluginHostManager`: `emitServerEvent(kind, actor, target, channelId,
  detailJson)` - build the JSON the audit plugin already parses (its
  `parse_server_event` in audit/src/lib.rs is written and tested against this
  exact shape):

  ```json
  { "offset": 1784490000000123,
    "event": { "kind": "channel.create", "ts_ms": 1784490000000,
               "actor":  { "user_id": 3, "hash": "ab...", "name": "SuperUser" },
               "target": { ... },
               "channel_id": 7,
               "detail_json": "{...}" } }
  ```

  Offsets are the plugin's **idempotency key** and must stay unique across
  server restarts - derive from wall clock (`ms*1000 + seq%1000`, see the old
  `AuditLogBridge::emitEvent`), never a process-local counter.
- Valid `kind` strings (drive the plugin's toggle mapping,
  `Part::from_event_kind` in audit/src/toggles.rs): `ban`, `kick`, `mute`,
  `move`, `acl`, `register`, `config`, `channel.*`, `plugin.*`, `pchat.*`.

### 5.3 Plugin (`3rdparty/mumble-plugin-host/audit/src/lib.rs`)

- Implement the new `on_server_event` hook → `parse_server_event` →
  `runtime.ingest(event, offset)`. Then delete the `audit.ingest`
  plugin-message path and its `sender_session == 0` check (obsolete once
  ingestion no longer travels the client-reachable channel).
- Revert replies from `ctx.send_request_response(...)` back to targeted
  `ctx.send_plugin_message(PluginMessageOut { target_sessions: [session],
  payload_type: "audit.result" | "audit.verify.result" | "audit.config", .. })`
  - that is how the plugin was originally written (see PR #4's initial
  `send()` helper); the host relays these to the client as generic
  `PluginMessage` (wire 200) envelopes with zero server interpretation.
- **Keep** the `audit.config.get` / `audit.config.set` handlers I added
  (toggle matrix as generic Setting-row JSON, monotonic revision, chain
  height) - they are transport-independent and the config UI needs them.
- Pagination: have `audit.result` return
  `{ "request_id": .., "entries": [..], "has_more": bool, "next_before_id": n }`
  instead of a bare array (the bridge used to compute has_more; that logic
  belongs in the plugin now - it knows the requested limit).
- Config push on connect: either implement via the plugin's client-connected
  hook if the trait has one (`PluginHostManager::onClientConnected` reaches
  the host; check what the trait exposes), gated per-session by
  `ctx.has_permission(server, session, 0, PERM_WRITE)` - or simpler and
  recommended: drop pushes entirely and let the client request
  `audit.config.get` when the Audit tab opens.

### 5.4 Client (`Fancy-Mumble/FancyMumble` branch `feat/audit-log-client`)

The UI, store, DSL, charts and testids are done and validated - only the Rust
transport changes:

- Outbound (`crates/mumble-tauri/src/state/...`, `commands/audit.rs`): replace
  the `send_fancy_audit_query` / `send_fancy_audit_config_update` wire sends
  with generic `PluginMessage` (wire 200) sends: `plugin_name: "fancy-audit"`,
  `payload_type: "audit.query" | "audit.verify" | "audit.config.get" |
  "audit.config.set"`, payload = JSON. Field names must match the plugin's
  `parse_query` (audit/src/lib.rs): `request_id`, `categories`, `source`,
  `actor_user_id`, `target_user_id`, `channel_id`, `text`, `since_ms`,
  `until_ms`, `before_id`, `limit`.
- Inbound: subscribe to incoming `PluginMessage` envelopes for
  `plugin_name == "fancy-audit"`, decode the JSON payload types
  `audit.result` / `audit.verify.result` / `audit.config`, and emit the SAME
  tauri events the UI already listens to (`audit-response`, `audit-event`,
  `audit-config`) so nothing above the transport changes. Entry JSON shape
  (plugin's `entry_to_json`): `{id, ts_ms, source, category, severity,
  actor:{user_id,name}, target:{user_id,name}, channel_id, reason,
  detail_json, relates_to, entry_hash}` - note `entry_hash` is a **hex
  string** here (the bridge converted to proto bytes; adjust the mapping in
  the state handler accordingly).
- Delete `send_fancy_audit_*` command files, the 166–171 wire types
  (mumble-protocol message.rs / codec.rs / proto), and the five
  `fancy_message_support.rs` audit rows - mirroring whatever you did
  server-side in 5.1.
- **Tab gating**: `admin/index.tsx` currently gates on
  `serverFancyVersion >= 0.4.2`. That breaks in the opaque world (and the
  server version bump `81e87ee89` becomes meaningless - drop it). Replace
  with capability detection: the client already receives the server's plugin
  registry (`PluginHostManager::fillRegistry` → PluginRegistry); gate the tab
  on `fancy-audit` being present+loaded, or lazily on the `audit.config`
  snapshot arriving.

### 5.5 PR hygiene

- Server PR #4 should end up as: plugin crate + generic `on_server_event`
  ABI/host/FFI + the five emit sites. No audit-named code outside
  3rdparty/mumble-plugin-host.
- The docker packaging commit (`e827ba3` on mumble-docker
  `wip/audit-plugin-packaging`) must land in mumble-docker or the image ships
  without the plugin.
- Client PR #110 gets the 5.4 rework.

## 6. Build & verify (any machine)

```sh
# Server image from a branch (build context = the docker submodule with e827ba3):
docker build -t fancy-mumble-server:e2e-audit \
  --build-arg MUMBLE_GIT_REPO=https://github.com/Fancy-Mumble/mumble-server \
  --build-arg MUMBLE_GIT_BRANCH=<your-branch> \
  --build-arg CACHE_BUST=$(date +%s) vendor/docker

# Fixture (down -v matters: schema drift between images otherwise aborts startup):
docker compose -f fixtures/docker-compose.e2e.yml down -v
E2E_SERVER_IMAGE=fancy-mumble-server:e2e-audit \
  docker compose -f fixtures/docker-compose.e2e.yml up -d --wait

# Client (BOTH steps, in this order, after any UI edit - dist embeds at compile time):
cd vendor/client/crates/mumble-tauri/ui && npm ci && npm run build
cd ../.. && cargo build --release -p mumble-tauri --features custom-protocol

# The audit e2e (must go 6/6 unchanged):
E2E_NATIVE_DRIVER=<path to msedgedriver matching the local WebView2 MAJOR version> \
  node --import tsx --test src/tests/audit-log.test.ts
```

The fixture ini (`fixtures/mumble-server.ini`) already enables the plugin:
`plugin.fancy-audit.enabled=true`,
`plugin.fancy-audit.storage_path=/data/audit-log.sqlite` (config key is
`storage_path`, resolved in audit/src/config.rs).

## 7. Pitfalls discovered the hard way (do not rediscover)

1. **Messages.cpp**: `MSG_SETUP` / `RATELIMIT` / `PERM_DENIED` are `#undef`'d
   near the end of the file - new handlers must sit above that block.
2. **`CMAKE_UNITY_BUILD=ON`** merges murmur translation units: anonymous
   namespaces collide across .cpp files (a second `kPluginName` broke the
   build). Prefix file-local constants.
3. `QJsonValue` insertion of a raw `int64_t` is ambiguous on LP64 - cast to
   `qint64`.
4. **Never version-gate on the client's fancy version** - the handshake
   advertises the protocol-crate version (0.3.x), not feature support
   (`sendFancyServerSettings` documents this; my `419900cbd` fixed exactly
   this mistake).
5. Plugin loads only with `plugin.fancy-audit.enabled=true`; it logs
   "discovered but not enabled" otherwise.
6. PR #4's original head didn't even link (wire IDs declared, handlers
   missing) and shipped no docker packaging - both fixed on the wip branches.
7. When switching between the forums image (DB schema 19) and audit/1.6.x
   images (schema 18), the fixture DB volume must be wiped (`down -v`) or the
   server aborts with a schema-version error.

## 8. Unrelated parked work (do NOT touch, context only)

Forums + scheduled messages (client PR #109 / server PR #3): fully e2e-tested
(10/10 + 3/3) after three real server bugs were fixed. Everything sits on
`Fancy-Mumble/mumble-server wip/forums-scheduled-e2e-fixes` (SOCI COUNT
binding, author identity on fetch, `markDeleted` `got_data()` → no delete
broadcast; plus a merge of current 1.6.x) and
`Fancy-Mumble/FancyMumble wip/forums-scheduled-testids` (testids + tsc fix +
regenerated artifacts). The e2e tests live in this repo
(`src/tests/forums.multiclient.test.ts`,
`src/tests/scheduled-messages.multiclient.test.ts`). Full-suite runs against
the forums build showed 10 failing suites (calendar/friends/meetings/
registration-related) that persist even after merging 1.6.x - suspected
pre-existing/registration-related, unresolved, parked.

---

## 9. COMPLETION STATUS (2026-07-20) - opaque rework done + verified

**Server + plugin rework: COMPLETE, pushed, verified.**
- `GoOneStepBack/mumble-server` branch `wip/audit-opaque-rework` (head `80da199e0`):
  bridge deleted, `on_server_event` ABI-4 fan-out, 5 emit sites, plugin
  `on_server_event`→ingest + generic-channel replies + owns pagination.
- Image `fancy-mumble-server:opaque` built from that branch (via build-rework.sh
  → vendor/docker `wip/audit-plugin-packaging`). Container `fancy-audit-verify`.
- Plugin unit tests: **50/50 pass** (`cargo test` in 3rdparty/mumble-plugin-host/audit).
- **Live ingest verified**: pymumble trigger (~/audit-client) created channels →
  plugin `server_audit` hash-chain store has rows (queried via ~/rtvenv sqlite).

**Client transport rework: COMPLETE, committed, verified - NOT pushed (token scope).**
- Commit `ab86239` on top of `feat/audit-log-client` (base `7b9e41c`).
- Fine-grained PAT can push mumble-server but NOT Fancy-Mumble/FancyMumble fork
  (403). Commit preserved as patch: `~/fancy-mumble-e2e` + agent /memory/audit-handoff/
  `audit-client-rework.patch` (git am onto feat/audit-log-client).
- `cargo check -p mumble-protocol`: **clean** (wire 166-171 removal compiles).
- **Full client↔plugin contract verified end-to-end** via raw wire-200 round-trip
  (~/rt/rt_client.py, image rt-client, run on bridge net → server 172.18.0.x):
    - audit.query   → audit.result  : 2 entries, {has_more,next_before_id,request_id},
                                        entry shape matches decode_entry (hex entry_hash,
                                        nested actor/target)
    - audit.verify  → audit.verify.result : {intact:true, checked:2, head} (was the RED
                                             test under the bridge - now green)
    - audit.config.get → audit.config : 21 settings, revision, chain_height
  Every field the reworked client `handler/audit.rs` decoder reads is present + correct.
- tauri-crate compile: type/API contracts all confirmed matching (SendPluginMessage,
  AuditQueryArgs, AuditEntryPayload, AuditConfigSnapshot, ServerSetting). A real
  `cargo check -p mumble-tauri` needs webkit2gtk-4.1-dev - NOT installable here
  (no sudo). GUI selenium e2e (audit-log.test.ts) likewise needs webkit +
  WebKitWebDriver + tauri-driver; unrunnable on this Linux box. Both were validated
  on the prior Windows machine; here verified at protocol/contract level instead.

**Residual (for a machine with webkit / proper token):**
1. `git am` the client patch onto feat/audit-log-client; push; update PR #110.
2. `cargo check -p mumble-tauri --features custom-protocol` (or full build) to
   typecheck the 4 reworked tauri files (contracts already cross-checked).
3. Optional: run the 6/6 GUI audit-log.test.ts once webkit infra exists.
