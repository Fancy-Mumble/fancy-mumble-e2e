# Security audit: identity and authorisation (Starling)

Scope: how Starling decides **who someone is** and **what that entitles them
to** - `crates/proto-fancy/src/identity.rs` (127 lines),
`crates/services/userdata/src/{accounts,secret}.rs`,
`crates/services/permissions/src/{evaluate,group,lib}.rs` (2 064 lines of the
first two), the identity plumbing in
`crates/services/session-lifecycle/src/{handshake,state}.rs`,
`crates/services/session-view/src/{lib,cold}.rs`,
`crates/crypto/src/peer_cert.rs`, and the `crates/operator-api` authorisation
boundary. Audited **2026-08-01** against `vendor/starling` at `c55ca8e`.

**Status: I1, I2 and I3 are fixed, with 8 regression tests. I4 is documented
and open by decision; I5 is upstream parity and left alone.** None was a
privilege escalation.

**Why this audit exists.** I1 was found *by accident*, while chasing an
unrelated flaky e2e login. That is the uncomfortable part: the same class of
mistake - **an identity resolved from the wrong signal** - has now been recorded
four times in `docs/GAP-ANALYSIS.md`, and the fourth was found by a test failing
for another reason entirely. Nobody had read this path looking for it.

**Method and its limits.** Every finding is read from the source and cited by
line. **None has been demonstrated by exploit** - there is no proof-of-concept
here, and severities are argued from the code path rather than measured. I1's
mechanism was observed indirectly, in server logs, as repeated `WrongUserPw`
refusals for a password that was demonstrably correct. Anything I could not
close by reading is marked *inferred*.

The threat model: an **unauthenticated peer who can reach the control port**,
which on a server allowing anonymous connections - the default, and what the
e2e fixture uses - is anyone who can route to it. Where a finding needs more
than that, it says so.

---

## Findings

| # | Finding | Direction | Severity |
|---|---|---|---|
| I1 | A certificate authenticated an account the peer never claimed | could fail **open** | high - **fixed** |
| I2 | The registered-name guard is bypassed by changing case | fails **open** | medium - **fixed** |
| I3 | `session-view`'s cold-query subject drops tokens, channel and `strong_cert` | mostly closed, `out` inverts | medium-low - **fixed** |
| I4 | `@strong` matches nobody, ever | fails **closed** | low - documented, open |
| I5 | A session may be displaced from a shared address | fails **open**, parity with murmur | low - informational |

---

### I1 - A certificate authenticated an account the peer never claimed · **fixed**

`accounts.rs:186` selected the account **by certificate alone**:

```rust
match (by_cert, by_name) {
    (Some(record), _) => self.finish(record, request, Proof::Certificate),
```

The `_` discards the name the peer asked for. A client whose certificate had
been bound to an account by an earlier registration, connecting as `SuperUser`,
was resolved to the *certificate's* account - and `finish` then checked the
typed administrator password against **that account's** secret.

It surfaced as `WrongUserPw`, which is the safe direction of a wrong answer.
**The unsafe direction is the same line.** A client registration stores no
password - `docs/GAP-ANALYSIS.md` §4 is explicit that "the account is claimed by
its certificate from then on" - so for the overwhelmingly common case
`record.password` is `None`, no password is demanded, and the peer is
**admitted as an identity they never claimed**.

Whether that is reachable as an escalation depends on obtaining a certificate
bound to a more privileged account, which is not free. It does not need to be an
escalation to matter: silent identity substitution is a broken audit trail, and
every action the peer takes is attributed to somebody else.

**Fixed** at `accounts.rs:186`: a certificate now authenticates **the account it
belongs to and no other**. A name mismatch sets the certificate aside and
resolution falls to the name, which carries its own proof. Four tests pin it,
including the two properties that must not regress - a certificate still
authenticates its own passwordless account, and cannot take another account's
name.

### I2 - The registered-name guard is bypassed by changing case · **fixed**

`accounts.rs:301` compares names with `==`:

```rust
.find(|((s, _), record)| *s == scope && record.account.name == name)
```

`duplicate_of` - the *live session* check - uses `eq_ignore_ascii_case`
(`state.rs:351`), matching murmur, which lowercases both sides
(`Messages.cpp:487`). The registered-account lookup does not. Three consequences
follow from that single asymmetry:

**(a) The impersonation guard is bypassed while the owner is offline.**
`authenticate`'s `NameTaken` branch is reached only through `record_by_name`.
Registered `Alice` is offline; an attacker connects as `alice`; the lookup
returns `None`; the peer is admitted as a **guest named `alice`**. The guard
`accounts.rs:170` describes - *"a registered name belongs to the certificate
that registered it, so a stranger presenting it is refused"* - never fires.
While Alice is connected, `duplicate_of` catches it case-insensitively and the
peer gets `UsernameInUse`, so the guard holds **only for as long as she stays
online**, which is the opposite of what a registration is for.

**(b) The SuperUser login is not case-insensitive**, contradicting
`identity.rs:44`, which states `SUPERUSER_NAME` is *"matched case-insensitively
by the account lookup, because every Mumble client offers it as the
administrator login."* It is not. Connecting as `superuser` finds no account and
yields a guest of that name. That fails closed for authentication - no
escalation - but it hands an attacker the administrator's name in the roster
whenever the real one is absent.

**(c) Two accounts may be registered differing only in case.** `register`
(`accounts.rs:350`) gates on the same case-sensitive lookup, so `Alice` and
`alice` are two accounts.

**Not an escalation.** No permission keys on a name: ACL entries carry account
ids, and group membership `add`/`remove` are `u64`. The impostor holds guest
rights. The harm is identity confusion and the social engineering it enables -
which is precisely what murmur's guard exists to prevent.

**Fixed** at `accounts.rs:297`, which now folds case - and, because a database
written earlier may already hold `Alice` and `alice` as two accounts, prefers an
**exact match** and returns it immediately. Both legacy logins keep working;
only a third spelling resolves by fold, and then to the lowest account id rather
than to whatever order the `HashMap` yielded, because an authentication that
depends on hash seeding is not one anybody can reason about. New collisions
cannot be created: `register` and `rename` gate on this same lookup. Four tests,
including the two-legacy-accounts case.

### I3 - `session-view`'s cold-query subject drops three fields · **fixed**

`session-view/src/lib.rs:84` builds the `Subject` for a cold ACL query with
`..Subject::default()`, which zeroes `tokens`, `channel` and `strong_cert`.
Compare `handshake.rs:739`, which fills all three and says why:

> The tokens and the channel the client is standing in are both *inputs* to the
> answer: a `#password` entry and every `in`/`out`/`sub` rule read them.

So on the cold-query path: `#token` groups **never match** - channel passwords
do not open anything - and `in`, `out` and `sub` evaluate as though every user
were standing in the root.

This is a **surviving instance of G2**, which `docs/GAP-ANALYSIS.md` recorded as
"`Subject.tokens` is written as `Vec::new()` at every call site". The
`permissions::resolve` path was fixed; this second construction was not.

Direction: mostly closed - a group that would have granted fails to match. One
case inverts. `Kind::Out => subject.channel != channel` (`group.rs:229`) with
`channel` forced to `0` reads a user *standing in* channel 5, evaluated against
channel 5, as **`out`** - so an entry granting to `out` grants to someone the
operator meant to exclude. *Inferred:* I did not establish which cold queries
reach an ACL naming `out`, so I cannot say the open case is reachable in
practice, only that the evaluation is wrong.

**Fixed** at `session-view/src/lib.rs:84`, which now fills all three from the
stored `Session` and spells every field out with **no `..Subject::default()`** -
so a field added to `Subject` fails to compile here and makes somebody choose,
which is the same reason `session_record` in the handshake is written that way.
One test, asserting the `out` inversion specifically.

### I4 - `@strong` matches nobody, ever

`peer_cert.rs:74` documents `strong` as *"set only when a chain verified against
a configured CA … the only thing an operator should key a privilege off."*
`peer_cert.rs:90` is the **only write** in the tree, and it writes `false`. No
client CA is configurable for the control plane - the sole `client_ca` setting
(`config/operator.rs:93`) belongs to the operator API's mTLS.

So `Kind::Strong => subject.strong_cert` (`group.rs:227`) is constantly false.
An ACL granting to `@strong` grants to nobody; one restricting to it excludes
everybody. The file's own test says as much
(`a_chain_is_never_reported_as_strong_by_reading_it_alone`).

Fails closed, so this is a **correctness and honesty** defect rather than a
security hole - the §5 class: a feature an operator can write, which is accepted
and does nothing. Negation is worth noting: `!strong` matches *everyone*, so an
entry denying to `!strong` denies universally - still closed.

**Documented, not closed.** `docs/GAP-ANALYSIS.md` §6 now records that `@strong`
matches nobody and says not to key a privilege off it. Closing it means CA
verification against a configured trust anchor, which is a decision about *whose*
certificates a deployment trusts rather than a missing line - so it is left for
that decision rather than guessed at.

### I5 - A session may be displaced from a shared address · informational

`handshake.rs:1178` admits a takeover on IP address alone:

```rust
if address_of(&arriving.address) == address_of(&ghost.address) { return true; }
```

An unregistered user's name can therefore be taken, and their session closed
(`kick_ghost`, "You connected to the server from another device"), by anyone
sharing their apparent address - behind CGNAT, a corporate NAT or a VPN exit,
that is a large set of strangers. Registered users are unaffected: an attacker
claiming their name is refused by `NameTaken` before this point.

**This is faithful to upstream.** murmur's rule is `Messages.cpp:492` - refuse
unless the address matches or the certificate does, and only when the arriving
peer is unregistered. Starling transcribes it exactly. Recorded because an
inherited weakness is still a weakness, and because the rule was written when a
shared public address implied a shared household rather than a shared carrier.
Diverging would break the legitimate case the rule exists for - a dropped client
reconnecting before the server notices - so I would not change it without a
deliberate decision.

---

## What was checked and found sound

* **The identity primitives.** `identity.rs` is the only place `(account,
  registered)` is interpreted, and every caller goes through it. `evaluate.rs:354`
  uses `is_superuser`; `matches` (`evaluate.rs:431`) uses `identity::account`,
  closing G4. I found no surviving direct comparison against the SuperUser id.
* **`cert_hash` is not client-assertable.** It is SHA-1 of the leaf the peer
  presented, computed server-side by the TLS layer (`listener.rs:402`), and
  rustls verifies the handshake signature against the presented key - so a peer
  must hold the private key rather than copy somebody's public certificate.
* **Password comparison is constant-time.** `Secret::verify` (`secret.rs:59`)
  ends in `ct_eq`, over PBKDF2 with a stored salt and iteration count.
* **Access tokens do not leak.** Every read reaches `permissions` for
  evaluation; none is composed into anything a client or an operator reads back.
  The `Move`/`Enter` split (`session-lifecycle/src/lib.rs:778`) correctly scopes
  a typed channel password to the entry half.
* **Authorisation fails closed.** `Permit` denies on every failure including an
  unreachable `permissions`; `check_session` refuses an unresolvable session
  rather than answering as a guest (`permissions/src/lib.rs:527`).
* **The operator boundary.** `admit` (`routes.rs:115`) identifies, checks the
  scope, and **records the action before performing it** - a failure to record
  refuses the request.
* **Every caller-built `Subject`.** Three exist outside `permissions`; all build
  from server-held connection state, none from client input. I3 is a
  completeness defect in one of them, not an injection.

## What was done

**I1, I2 and I3 are fixed**, with 8 regression tests between them. **I4** is
recorded in `docs/GAP-ANALYSIS.md` §6 and left open deliberately: it fails
closed, and closing it properly is a trust-anchor decision. **I5** is left
alone - diverging from upstream would break the reconnect case the rule exists
for, and that trade is not mine to make silently.

A regression test naming the *class* - that an identity is never derived from a
single unverified signal - would be worth more than any individual fix here.
