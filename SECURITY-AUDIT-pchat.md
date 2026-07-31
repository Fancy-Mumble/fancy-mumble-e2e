# Security audit: persistent chat (pchat)

Scope: `vendor/server/src/murmur/pchat/` (3 007 lines) and the 24 wire messages
`PchatMessage` (100) through `PchatPinFetchResponse` (130). Audited 2026-07-31
against `vendor/server` at `6fe0f06e5`. Part 2 covers the Rust port,
`vendor/starling/crates/services/pchat/`.

**Status: findings 1, 2, 4, 5, 6, 7 and 8 are fixed** (see "What was fixed"),
with 9 regression tests in `TestPersistentChatManager` and 2 in
`starling-pchat`. **Finding 3 is mitigated, not closed** — closing it needs a
protocol change, and that is argued below rather than assumed.

**Method and its limits.** Every finding below is read from the source and cited
by line. **None has been demonstrated by exploit** — there is no proof-of-concept
here, and severities are argued from the code path, not measured. Anything marked
*inferred* is reasoning I could not close by reading alone.

The threat model this assumes: an **authenticated Mumble client**, because
pchat handlers run after `MSG_SETUP(ServerUser::Authenticated)`. On a server that
allows anonymous connections — the default, and what the e2e fixture uses — that
is anyone who can reach the port.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `PchatKeyHolderReport` has no authorization check of any kind | **High** | fixed |
| 2 | `cert_hash` in that report is attacker-chosen and never bound to the session | **High** | fixed |
| 3 | The key-possession challenge is first-prover-wins | **High** | mitigated |
| 4 | Challenge poisoning locks legitimate key holders out | **Medium** (DoS) | fixed |
| 5 | Auto-verify delivers stored sender keys with no permission check | **Medium** | fixed |
| 6 | Rate limiting misses the key-management messages, and resets on reconnect | **Low** | fixed |
| 7 | The rate limiter's eviction method has no callers | **Low** | fixed |
| 8 | Verified sessions are never cleared for certificate-less clients, and session ids are recycled | **Medium** | fixed |

Starling (part 2):

| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | `Fetch` served any channel's archive to any client, unchecked | **High** | fixed |
| S2 | Messages are stored into whatever channel id the client names | **High** | fixed |
| S3 | Every relay reaches all authenticated sessions, not the channel | **High** | reported |
| S4 | No rate limiting, though the module doc claims the service owns it | **Medium** | reported |

The three High findings **chain**: 1 and 2 give an attacker a seat at the
challenge, and 3 lets them win it. Finding 8 is independent — it reaches the
same `verifiedSessions` set by a different route, and survives fixes to 1–3.

What is *not* broken is worth stating, because it bounds every finding: the
message path validates identity, and the read path checks channel permission.
See "Controls that hold" below.

---

## 1. `handlePchatKeyHolderReport` performs no authorization — High

`PersistentChatManager.cpp:944`. The entire gate is:

```cpp
if (!m_config.enabled) return;
if (!msg.has_channel_id() || !msg.has_cert_hash()) return;
...
m_holdersTable.recordHolder(holder);          // :979
```

There is **no** check that the sender may enter the channel, **no** check that
the channel is one they are in, **no** permission check, and **no** rate limit.

Any authenticated client may therefore record a key-holder row for **any channel
id on the server**, including channels they cannot see or enter. Contrast
`handlePchatFetch:282`, which does check `hasEnterPermission`, and
`handlePchatDeleteMessages:1225`, which checks `hasDeleteMessagePermission`.

Consequences: the holder table — which the client UI renders as "who can read
this channel" — is attacker-writable, and reaching this handler is the entry
condition for findings 3 and 5.

## 2. The reported `cert_hash` is never bound to the session — High

`PersistentChatManager.cpp:953`:

```cpp
const std::string &certHash = msg.cert_hash();   // straight from the wire
```

It is never compared against `m_bridge.getCertHash(senderSession)`.

**The same file gets this right elsewhere**, which is what makes it a defect
rather than a design choice — `handlePchatMessage:132`:

```cpp
if (msg.sender_hash() != senderHash) {
    sendAck(..., "sender_hash_mismatch");
    return;
}
```

So an attacker can record *another user's* certificate hash as a key holder for
a channel, or a hash belonging to nobody. Combined with finding 1, the holder
list for any channel can be fabricated wholesale — a spoofing and
misattribution primitive, and one that survives in the database
(`m_holdersTable.recordHolder`).

## 3. The key-possession challenge is first-prover-wins — High

`PersistentChatManager.cpp:1117`:

```cpp
if (state.referenceHmac.empty()) {
    // First prover sets the reference.
    state.referenceHmac = proofBytes;             // attacker-supplied
    state.verifiedSessions.insert(senderSession);
    result.set_passed(true);
}
```

The reference HMAC is **whatever the first responder sends**. No key is
verified; the server has none to verify against. `m_challengeState` is in-memory
only, so `referenceHmac` is empty after **every server restart**, and again
after any `m_challengeState.erase(channelId)` (`:1157`, and at `:657` and `:913`).

An attacker who reaches the challenge — which findings 1 and 2 let them do
unconditionally — can answer with arbitrary bytes and be inserted into
`verifiedSessions`.

That set is the key-possession gate for the whole subsystem:

* `handlePchatFetch:275` — read stored history
* `handlePchatReaction:1302` — react
* `handlePchatSenderKeyDistribution:1520` — publish a sender key
* `handlePchatPin` — pin

**Severity is bounded by two things.** `handlePchatFetch` *also* checks
`hasEnterPermission`, so the archive is not readable by someone who cannot enter
the channel. And the stored payloads are E2E ciphertext the server never holds
keys for, so what leaks is ciphertext, not plaintext.

What is defeated is the distinction the challenge exists to enforce: **"in the
channel" versus "holds the key"**. A member without the key — an ex-member whose
access was revoked at the key layer, or a user who can enter a channel they were
never given the key to — becomes verified and receives the full ciphertext
archive and all live traffic, for offline attack or later disclosure.

## 4. Challenge poisoning locks out legitimate holders — Medium

Once a bogus `referenceHmac` is set, every genuine key holder's proof mismatches
and they fall to `:1130`. They are denied fetch, sending, reactions and pins:
the channel stops working for exactly the people entitled to it.

The recovery path at `:1153` makes this worse rather than better. If the
mismatching session is the **sole recorded holder**, the server erases the
challenge state and re-challenges — so whoever answers first wins again. Since
finding 1 lets an attacker write holder rows freely, they can arrange to be the
sole recorded holder and win the reset race repeatedly.

The comment there documents the trade-off honestly (a sole holder whose key
legitimately changed would otherwise be locked out forever), so this is a known
compromise made unsafe by findings 1 and 2, not an oversight on its own.

## 5. Auto-verify delivers stored sender keys unchecked — Medium

`PersistentChatManager.cpp:988`, for protocols where
`handler->autoVerifiesOnReport()` (Signal-style per-sender keys):

```cpp
state.verifiedSessions.insert(senderSession);
...
sendStoredSenderKeyDistributions(senderSession, channelId, certHash);   // :1004
```

Reporting yourself as a holder is **sufficient to be verified** — no challenge at
all — and immediately triggers delivery of every stored sender-key distribution
message for the channel. `sendStoredSenderKeyDistributions:1472` iterates the
map and relays, with **no permission check of its own**, and its caller has none
either (finding 1).

So on a Signal-protocol channel, a client that cannot even enter the channel can
obtain every stored SKDM for it.

*Inferred, not verified:* SKDMs should be encrypted to a specific recipient, so
the contents are probably not readable by the attacker. I did not confirm this —
it depends on client-side crypto I did not audit. Even if they are opaque, this
is unauthorized delivery of key material plus verified status for a channel the
attacker has no access to.

## 6. Rate limiting misses key management, and resets on reconnect — Low

Limits are defined for `msg`, `fetch`, `reaction`, `pin`, `key_announce` and
`key_exchange`. **Not** limited: `key_holder_report`, `key_challenge_response`,
`key_holders_query`, `delete_messages`, `sender_key_distribution`,
`epoch_countersig`, `ack`.

The unlimited set is exactly the set implicated above, so findings 1–5 can be
attempted at line speed.

Separately, `TokenBucketRateLimiter::allow` is keyed on the **session id**
(`std::to_string(senderSession)`), which changes on reconnect — so any limit is
reset by disconnecting. Keying on certificate hash would survive it.

## 7. The rate limiter's eviction method has no callers — Low

`TokenBucketRateLimiter::reset(key)` (`TokenBucketRateLimiter.cpp:48`) exists and
is correct — it erases every bucket whose key has the `key + ":"` prefix. It is
**called from nowhere**: a search across `src/murmur/` finds no call site.

So `m_buckets` grows one entry per (session, operation)
(`TokenBucketRateLimiter.cpp:31`) and nothing ever
removes them. A long-lived server accumulates a bucket for every session that has
ever connected, reachable by reconnecting in a loop. Slow unbounded growth, not a
crash — but the fix is a one-line call, because the implementation is already
written and waiting.

The natural call site is `onUserDisconnected` (`PersistentChatManager.cpp:616`),
which already performs the analogous cleanup for challenge state. Note that
adding it there inherits finding 8's guard problem.

## 8. Verified sessions outlive certificate-less clients, and session ids are recycled — Medium

`onUserDisconnected` (`PersistentChatManager.cpp:616`) exists precisely to prevent
this, and says so:

```cpp
// Remove the disconnected session from all channel verified-sessions sets
// so the session ID cannot be reused by a different user to bypass the challenge.
for (auto &[chId, state] : m_challengeState) {
    state.verifiedSessions.erase(sessionId);
    state.pendingChallenges.erase(sessionId);
}
```

But **it is not called for clients without a certificate**. The call site guards
on the hash being non-empty (`Server.cpp:1856`):

```cpp
if (m_pchatManager && !u->qsHash.isEmpty()) {
    m_pchatManager->onUserDisconnected(u->uiSession, u->qsHash.toStdString());
}
```

`qsHash` is set only from a presented peer certificate (`Server.cpp:1692`), so it
is empty for every anonymous client — the population this audit's threat model is
about, and what the e2e fixture uses. The handler repeats the same guard
internally (`certHash.empty()` → return), so both layers exclude the same users.

Thirty-one lines later the session id goes back in the pool (`Server.cpp:1887`):

```cpp
if (u->uiSession > 0 && u->uiSession < iMaxUsers * 2)
    qqIds.enqueue(u->uiSession); // Reinsert session id into pool
```

`verifiedSessions` is keyed on the session id alone
(`isSessionVerified` → `verifiedSessions.contains(sessionId)`), with no binding
to identity. A later client that draws the recycled id is therefore verified for
that channel having proven nothing.

**What bounds this.** `qqIds` is a FIFO `QQueue` initialised with
`1 .. iMaxUsers * 2 - 1` (`Server.cpp:245`), and a freed id is enqueued at the
*back*. Redrawing a specific id requires cycling the whole pool — roughly 200
connections at the default `iMaxUsers` of 100 — which is noisy and not
instantaneous. A `maxusers` reload rebuilds the pool entirely (`Server.cpp:665`),
which reshuffles it.

So this is not a snap-your-fingers attack, but it needs no permission, no
challenge and no key; the stale entry persists for the process lifetime; and on a
busy server the pool wraps on its own, making accidental inheritance possible
without an attacker at all.

*Inferred, not verified:* I did not run this. The claim that a recycled id yields
verified status follows from the three cited lines, but the pool-wrap timing is
argued, not measured.

---

## Controls that hold

Stated because they bound every severity above, and because a list of holes is
not a description of the system.

* **Message identity is validated.** `handlePchatMessage:132` rejects a
  `sender_hash` that does not match the session's certificate.
* **Reads are permission-checked.** `handlePchatFetch:282` requires
  `hasEnterPermission` *in addition to* verification, so finding 3 does not open
  channels the attacker cannot enter.
* **Reactions are triply gated** (`:1281`, `:1292`, `:1302`): rate limit, enter
  permission, and key verification.
* **Deletion is permission-checked** — `hasDeleteMessagePermission:1225`.
* **The server holds no plaintext.** Payloads are opaque envelopes with a size
  bound (`m_config.maxPayloadSize`), and the server never decrypts.
* **Challenge nonces use a CSPRNG** — `CryptographicRandom::fillBuffer`, 32
  bytes, shared per channel so proofs are comparable.

---

## What was fixed

All in `vendor/server`, verified by a build that compiles and runs
`ctest -R TestPersistentChatManager` as a build step (so a failing test fails
the image), plus an e2e run showing no regression.

**Findings 1 and 2 — `handlePchatKeyHolderReport`.** The handler now takes the
certificate hash from the session rather than the wire and refuses a report
whose `cert_hash` names anyone else, the way `handlePchatMessage` always has. A
session with no certificate is refused outright: every identity in this
subsystem *is* a certificate hash. It then requires `hasEnterPermission`,
checked after the takeover dispatch because takeover carries its own, stronger,
KeyOwner check.

**Finding 4 — the sole-holder reset.** `!otherHolderExists` was not the same
question as "is the sole holder": on a channel with *no* recorded holders — the
state right after a takeover or a wipe — it handed the reset to whoever asked
first. It now requires `selfIsHolder && !otherHolderExists`.

**Finding 5 — stored sender keys.** `sendStoredSenderKeyDistributions` carries
its own `hasEnterPermission` check rather than trusting its caller, because its
caller reaches it from the auto-verify path where "verified" is granted on the
strength of a self-report.

**Findings 6 and 7 — rate limiting.** Six previously unlimited operations
(`key_holder_report`, `key_challenge_response`, `key_holders_query`,
`sender_key_distribution`, `epoch_countersig`, `delete_messages`) now have
budgets. All buckets are keyed on the certificate hash instead of the session
id, so a limit is no longer cleared by reconnecting; certificate-less clients
fall back to the session id, because keying them all on one shared empty string
would let any one of them drain the bucket for every other.
`IRateLimiter::reset` — implemented, documented "e.g. on disconnect", and never
called — is now called on disconnect.

**Finding 8 — verified sessions outliving their session.** The guard at
`Server.cpp:1856` and its twin inside `onUserDisconnected` are gone; only the
pending-key-request cleanup, which genuinely needs a hash, is still conditional
on one. The cleanup that already existed now runs for every disconnect.

**Audit logging.** Holder writes, rejected reports, challenge resets and
takeovers now emit `pchat.key_holder_report`, `pchat.key_holder_rejected`,
`pchat.challenge_reset` and `pchat.key_takeover` through a new
`IServerBridge::emitAuditEvent`. They previously reached nothing but
`qWarning`, which is not a record anyone can query. The interface takes a flat
key/value list so `pchat` stays free of any JSON type.

### Finding 3 is mitigated, not closed

The three High findings chained; fixing 1 and 2 breaks the chain, because
reaching the challenge now requires Enter permission on the channel and a
certificate that is your own. That reduces the attack from *any authenticated
client* to *a member of the channel*.

It does **not** restore the distinction the challenge exists to enforce — "in
the channel" versus "holds the key" — because the server still has no ground
truth to check a proof against. The first prover still defines the reference.
Closing it needs a value the server can recompute: a channel key commitment
stored with the channel, so no client defines the truth. Options, roughly
increasing cost:

* derive the reference from a stored key commitment (needs a client change, and
  pchat is entirely a Fancy extension so the wire is ours to change);
* persist `referenceHmac` alongside the channel so a restart does not reopen the
  window, and require an existing holder to countersign a reset (needs a schema
  migration);
* treat the first prover as unverified until a second, independent holder agrees
  — quorum rather than first-come.

I did not pick one. Each changes the client contract, and that is a design
decision rather than a defect fix.

---

# Part 2: Starling (`vendor/starling/crates/services/pchat/`)

328 lines against murmur's 3 007. The key-holder and challenge subsystem does
not exist yet, so findings 1–8 have no counterpart. What is there had gaps of
its own, and they are not "not implemented yet" gaps: Starling already has the
facilities — `Permit`, which asks the `permissions` service, and `Perm` — and
`text` uses them on exactly this path. `pchat` simply did not.

**What Starling gets right, and murmur gets right only by a check:** the sender
is taken from the connection (`message.sender = inbound.session`), overwriting
whatever the client claimed. That is finding 2 made structurally impossible
rather than validated.

## S1. `Fetch` served any channel's archive, unchecked — High (fixed)

`self.fetch(inbound.scope, &request)` ran on a channel id straight off the wire,
with no permission check of any kind. Any authenticated client could page
through the stored ciphertext of any channel on the server, including ones it
cannot see. Now gated on `Perm::ENTER`, matching murmur's `handlePchatFetch`.

## S2. Messages stored into any channel the client names — High (fixed)

Same root cause on the write side. Now gated on `Perm::TEXT_MESSAGE`, checked
*before* the store rather than before the relay — refusing only the relay still
leaves the row in someone else's archive.

Both use `Permit`, which denies when `permissions` is unreachable, so a broken
dependency closes the archive rather than opening it.

## S3. Every relay reaches all authenticated sessions — High (reported)

`broadcast_except(inbound.session, ...)` builds a `Send` with no `conns` and no
`sessions`, and the gateway's `deliver` falls back to
`registry.authenticated()` — every connection whose session is non-zero
(`crates/gateway/src/connection.rs:254`). So a stored pchat message, and every
verbatim-relayed key-distribution frame, goes to every client on the server
rather than to the channel.

The ciphertext stays opaque. What leaks is who sent a message, when, in which
channel — and the ciphertext itself, which is what an offline attack wants.

**Not fixed, deliberately.** `text` relays the same way
(`crates/services/text/src/lib.rs`), so this is a property of the plane, not of
this one service; `voice` is the one that addresses `sessions` explicitly, using
the roster from `session-view`. Fixing it in `pchat` alone would leave the same
hole one service over and add a `session-view` dependency to settle a question
that belongs at the plane. Both relay sites are now commented with what they do
and why it is a finding.

## S4. No rate limiting — Medium (reported)

The module doc claims the service owns "storage, fan-out, offline queues,
key-holder bookkeeping and rate limiting". There is no limiter in it. The only
rate limiting in Starling is at the gateway (`crates/gateway/src/listener.rs`),
which is per connection rather than per operation, so a client can store
messages and issue fetches as fast as its socket allows. Not fixed: it needs a
limiter abstraction the service tier does not yet have, and inventing one for a
single service is the wrong place to start.

## What this audit did not cover

* **Client-side cryptography** — key derivation, the Signal implementation, SKDM
  encryption. Finding 5's residual severity depends on it.
* **The database layer** — `PChat*` tables, SQL construction, and whether
  `deleteBySender` and friends are parameterised.
* **`handlePchatEpochCountersig`** (`:451`) and `handleKeyOwnerTakeover`
  (`:889`), both of which look security-relevant and neither of which I read in
  full.
* **Exploitability.** No finding was demonstrated by exploit. The fixes are
  covered by unit tests that assert the *refusal* — which proves the gate is
  there, not that it was reachable before. Finding 3 remains the one worth
  measuring rather than arguing, and finding 8's pool-wrap timing was argued
  from three cited lines, never run.
* **Starling's key-holder subsystem**, because it does not exist yet. When it is
  ported, findings 1–8 are the checklist: the C++ fixes are in
  `PersistentChatManager.cpp` and the tests naming them are in
  `TestPersistentChatManager.cpp`.

## Verification

* `vendor/server`: builds, and `ctest -R TestPersistentChatManager` runs as a
  build step with `--no-tests=error` and no `|| true`, so the image cannot be
  produced if a test fails. 9 new regression tests.
* e2e after the change: `audit-log` 7/2, `pchat-control-plane` 1/1,
  `pchat` 1/0, `signal-pchat` 2/0 — unchanged from before it, i.e. no
  regression. (`signal-pchat` timed out once on the known connect-wizard flake
  and passed on re-run.) The pre-existing `pchat-control-plane` and `audit-log`
  failures are unrelated to this audit and tracked in
  `HANDOFF-e2e-remaining.md`.
* The e2e logs also settled the one assumption the fixes rest on: clients do
  present certificates (`hash=46f2feef...` in the server log), so requiring one
  for a holder report locks nobody out.
* `vendor/starling`: `cargo test -p starling-pchat` 4/4, clippy and fmt clean
  for that crate. Other crates have pre-existing fmt/clippy failures that this
  change neither caused nor fixed.
