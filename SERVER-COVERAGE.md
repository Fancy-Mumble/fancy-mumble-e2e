# Source-driven server rewrite coverage

This document is derived from `vendor/server/src/murmur/Messages.cpp`,
`Server.cpp`, `Mumble.proto`, the Rust plugin host, and the Tauri command
registry. It is the compatibility contract for a Rust replacement. A test is
listed as covered only when it drives the real client/server transport and
asserts an externally visible result; client unit tests are not counted.

## Handler inventory

| Source handler family | Current E2E status | Required evidence |
|---|---|---|
| Authenticate, Version, Ping, ServerSync, Reject, PermissionDenied | Partial | connect/bootstrap tests cover successful authentication; raw TCP/UDP tests still needed for every reject and malformed frame |
| UserState/UserRemove, ChannelState/ChannelRemove, TextMessage | Covered/partial | presence, voice, channel, messaging, hidden-channel and delete tests cover normal fan-out; limits and denied mutations remain |
| BanList, ACL, QueryUsers, UserList, UserStats, RequestBlob | Partial | admin/registration tests cover ACL and user list; direct query, stats, texture/comment/blob and ban-list round trips are still needed |
| CryptSetup, UDPTunnel, CodecVersion, VoiceTarget, PluginDataTransmission | Partial | voice/audio tests cover normal UDP; raw protocol and multi-target/plugin-data tests are missing |
| PermissionQuery, ContextAction/Modify, ServerConfig/SuggestConfig | Partial | ACL/admin tests cover selected permissions; denied action, runtime config and suggestion boundaries are missing |
| Push register/update/subscribe and custom-reaction config | Missing | add subscription persistence, update/unsubscribe, duplicate and permission/error tests |
| Pchat message/fetch/ack/offline drain | Covered/partial | pchat replay, reconnect and message-loss tests cover the happy path; fetch windows, empty history, ack statuses and offline queue drain are missing |
| Pchat key announce/exchange/request, epoch countersig, holder report/query/challenge | Partial | Signal pchat covers key distribution/consent; holder replacement, stale epochs, challenge failure and duplicate keys are missing |
| Pchat reactions and sender-key distribution | Covered/partial | reactions cover add/deliver; remove, duplicate, unauthorized sender and key distribution failure are missing |
| Pchat pin/deliver/fetch and delete messages | Missing | add pin/unpin, pinned-history replay, authorized deletion, unauthorized deletion, empty selection and multi-ID deletion |
| WebRtcSignal, read receipts, typing indicators | Partial | WebRTC tests cover signaling/relay; receipt and typing transport tests are still missing |
| Link preview request/response | Covered/partial | link-preview covers normal and SSRF-safe fetch; timeout, invalid URL and concurrent request correlation are missing |
| Watch sync (start/state/join/leave/request/end/host transfer) | Missing | add a two-client lifecycle test including host transfer, late join and wrong-channel isolation |
| Drawing stroke | Missing | add authenticated fan-out, sender exclusion, channel isolation, clear stroke and malformed point tests |
| Onboarding config/update/response/query/deliver | Missing | add admin-write broadcast, user response persistence/query, TLS identity and permission-denied tests |
| Server settings/update | Missing | add root-write visibility, update persistence, secret redaction and non-admin denial tests |
| Account settings/ack (password, rename, email, unregister, TOTP) | Missing | add each action plus invalid password, TOTP required/invalid, duplicate name and unregister disconnect behavior |
| Plugin registry/message and plugin admin list/enable/install/uninstall | Missing/partial | trust prompt and plugin-dependent tests exist; registry lifecycle and denied admin operations are missing |
| Poll/poll vote | Missing | add creation, single/multiple vote, duplicate vote, channel isolation and late delivery tests |
| Audit query/config/event/response | Covered/partial | audit chain/query/config tests cover normal admin flow; denied query and restart persistence need explicit tests |

## Non-handler server behavior

The source also requires tests for channel-name/user-name validation, channel
nesting/count/listener limits, users-per-channel, registration and
impersonation, temporary channels/groups, channel expiry, channel links,
listening volume, texture/comment persistence, welcome text, server password,
certificate-required mode, HTML/text/image/message rate limits, bandwidth
limits, UDP packet loss/reordering, and graceful TCP disconnect cleanup.
Existing tests cover only the normal cases for several of these. Boundary and
denial cases must be added before a rewrite can be called compatible.

## Required fixture layers

The UI-driven suite is the primary compatibility suite. It cannot cover
malformed framing, UDP sequence behavior, server-only outbound messages, or
database migration behavior. The complete acceptance job therefore needs:

1. UI E2E tests using the shipped FancyMumble client.
2. A small raw Mumble TCP/UDP harness generated from `Mumble.proto` for frame,
   enum, length, reject, blob, stats, ACL, voice-target and UDP edge cases.
3. A server fixture matrix for SQLite, PostgreSQL and MySQL, including restart,
   migration and preserved-data checks.
4. Fault-injection fixtures for file-server, live-doc, link-preview and SFU
   dependencies, plus packet loss and mid-frame TCP closure.

Skipped file-server tests are not coverage: they remain blocked until the
client receives `fancy-file-server-config` in the E2E fixture. Likewise,
camera tests that skip without a device do not prove camera behavior.

## Acceptance rule

The Rust server must pass the same tests with the same client binary and
fixture matrix. Any intentional protocol difference needs a versioned schema
decision and a test documenting the new contract; weakening an assertion is
not an acceptable compatibility fix.
