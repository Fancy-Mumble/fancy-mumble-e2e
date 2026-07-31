# Security audit: persistent chat (pchat)

Scope: `vendor/server/src/murmur/pchat/` (3 007 lines) and the 24 wire messages
`PchatMessage` (100) through `PchatPinFetchResponse` (130). Audited 2026-07-31
against `vendor/server` at `6fe0f06e5`.

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

| # | Finding | Severity |
|---|---|---|
| 1 | `PchatKeyHolderReport` has no authorization check of any kind | **High** |
| 2 | `cert_hash` in that report is attacker-chosen and never bound to the session | **High** |
| 3 | The key-possession challenge is first-prover-wins | **High** |
| 4 | Challenge poisoning locks legitimate key holders out | **Medium** (DoS) |
| 5 | Auto-verify delivers stored sender keys with no permission check | **Medium** |
| 6 | Rate limiting misses the key-management messages, and resets on reconnect | **Low** |
| 7 | The rate limiter's eviction method has no callers | **Low** |
| 8 | Verified sessions are never cleared for certificate-less clients, and session ids are recycled | **Medium** |

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
* `handlePchatSenderKeyDistribution:727` — publish a sender key
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

## Recommendations, in dependency order

1. **Bind `cert_hash` to the session in `handlePchatKeyHolderReport`**, exactly
   as `handlePchatMessage` already does. One comparison, and it closes finding 2.
2. **Add `hasEnterPermission` to `handlePchatKeyHolderReport`** and to
   `sendStoredSenderKeyDistributions`. Closes finding 1 and most of 5.
3. **Make the challenge verify something.** First-prover-wins cannot be made safe
   by tightening who reaches it — it is trust-on-first-use with no pinning and a
   reference that resets on restart. Options, roughly increasing cost:
   * derive the reference from a value the *server* can recompute (a channel key
     commitment stored with the channel), so no client defines the truth;
   * persist `referenceHmac` alongside the channel so a restart does not reopen
     the window, and require an existing holder to countersign a reset;
   * treat the first prover as unverified until a second, independent holder
     agrees — quorum rather than first-come.
4. **Bind verified status to identity, not to the session id.** Key
   `verifiedSessions` on certificate hash, or on (session id, cert hash) — which
   makes finding 8 unreachable regardless of when cleanup runs. Failing that, the
   narrow fix is to drop the `!u->qsHash.isEmpty()` guard at `Server.cpp:1856`
   and the matching one inside `onUserDisconnected`, so the cleanup that already
   exists actually runs for anonymous clients. The pending-key-request cleanup in
   that handler genuinely does need a hash, so it should be the part that is
   guarded — not the whole call.
5. **Rate-limit the key-management messages**, and key the limiter on
   certificate hash rather than session id.
6. **Audit-log holder changes and challenge resets.** Both are security-relevant
   state transitions and currently reach only `qWarning`. `audit.pchat_moderation`
   already exists as a category.
7. **Call `TokenBucketRateLimiter::reset`** on disconnect. The method is already
   implemented; it has no callers.

## What this audit did not cover

* **Client-side cryptography** — key derivation, the Signal implementation, SKDM
  encryption. Finding 5's residual severity depends on it.
* **The database layer** — `PChat*` tables, SQL construction, and whether
  `deleteBySender` and friends are parameterised.
* **`handlePchatEpochCountersig`** (`:451`) and `handleKeyOwnerTakeover`
  (`:889`), both of which look security-relevant and neither of which I read in
  full.
* **Exploitability.** Nothing here was run. Before acting on severities, write
  the proof-of-concept for finding 3 — it is a few lines against a test server
  and it either confirms the chain or refutes it. Finding 8 is the other one
  worth measuring rather than arguing: connect and disconnect anonymously until
  the id pool wraps, and check whether the inherited session is verified.
