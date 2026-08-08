# The suite against Starling, measured

The first full run of the e2e suite against **Starling** rather than the C++
fork, on **2026-08-06**. `vendor/server` is obsolete, so this is now the number
that matters.

Both sides were release builds of that day's code: the client carrying the
epoch-1 canon codec, Starling carrying the whole protocol port. Run with
`npm run e2e`, which starts one Starling on 64738 for the whole sweep.

```
47 suites   23 ok (5 of them skips)   24 not ok
106 tests   50 pass   40 fail   16 cancelled        37m 39s
```

A cancelled test is one whose `before` hook failed, so the count of failures
understates nothing: a hook that cannot reach a server cancels every test under
it, and those sixteen are the same story as the failure above them.

---

## 1. What passes

Not a smoke test. These drive two real client windows against a real server.

| Suite | What it proves |
|---|---|
| `signal pchat: full E2E decryption across members` | the key ladder works end to end |
| `signal pchat: forward secrecy for late joiners` | a joiner cannot read history |
| `multi-client: presence + messaging` | the thing a chat server is for |
| `voice fidelity` | real speech, correlation 0.748 against a 0.55 floor, 0 ms dropout |
| `voice-state sync`, `multi-client: voice UI state` | mute/deafen across clients and reconnects |
| `channels: SuperUser create + cross-client visibility` | the tree, live, to a second client |
| `channels: hidden, expiring + meeting rooms` | the Fancy channel kinds |
| `registration` | sign up, confirm, use the account |
| `security: registered-name impersonation is rejected` | the guard that name is identity |
| `server compatibility: control-path boundaries` | the frame limits |
| `admin: creating a role via the Roles wizard` | ACL groups from the admin UI |
| `audio resampling 44.1k / 192k`, `DeepFilterNet` | the audio path |
| `root channel occupants`, `qt6ui ghost session`, `smoke` | |

## 2. What fails, and which of it is Starling's

**Read the categories, not the total.** Half of the failing suites are not
measuring the server at all.

### 2.1 Missing infrastructure - not Starling (5 suites)

| Suite | Needs |
|---|---|
| `admin UI health dashboard` | the admin UI on `127.0.0.1:5007` (`channelviewer` compose profile) |
| `channel viewer (Ice)` | murmur's Ice port 6502 |
| `murmur: temporary group membership` | Ice; it is a *parity* test against the fork by design |
| `user manager: sign up…` | the user-manager stack |
| `file-server upload`, `forums`, `friend chat file upload` | client UI that is not merged |

These skip or fail for want of a container. None of them is a statement about
the port.

### 2.2 Real gaps in Starling (18 suites)

The list `FANCY-PARITY.md` §3 predicted, now measured rather than remembered:

* **persistent chat delivery** - `persistent chat control messages`,
  `persistent chat: history replay`, `friend chat 1:1: no pchat message loss`,
  `friend chats: E2E persisted channels`, `signal pchat: bridge smoke`.
  The cryptography works (§1) and the *delivery* does not: the control plane
  answers and the message does not arrive.
* **reactions** - `reactions: cross-client`. A reaction never appears on the
  other client.
* **the Fancy control-plane fan-out** - `Fancy control-plane fan-out`.
* **calendar** - four suites: notifications, offline invite, constellations,
  plugin gating. The calendar is plugin territory (`FANCY-PARITY.md` §1), which
  is the structural gap, not a defect.
* **screen share** - four suites: delivery health, GPU pipeline fps, pixel
  fidelity, performance. The SFU is wired now (`crates/sfu`), but these measure
  frames arriving, which needs the media path end to end.
* **camera share**, **scheduled messages**, **meetings: server-provisioned E2E
  rooms**, **admin: deleting a detached channel**, **audit log ingest**.

### 2.3 Fixed since the run (1 suite)

* **`link preview`** - the client sent `FancyLinkPreviewRequest` as flat type
  132, which had no canon arm, so it took the `PluginData` relay; the service
  only ever decodes a `LinkPreviewEnvelope` under outer type 1016. The server
  fetched correctly and the request never arrived. Both ends now speak the
  canon, and `PreviewRequest` carries `repeated urls`, because a chat message
  has as many links as somebody typed.

---

## 3. How to run it

```sh
npm run e2e                      # every shared-server file
npm run e2e -- src/tests/x.ts    # one file
npm run e2e:private              # the two files that start their own server
```

Two things the harness cannot do for you:

* **`msedgedriver` must match the machine's WebView2 version**, and it is not
  in any repo. `scripts/install-msedgedriver.ps1`, then point
  `E2E_NATIVE_DRIVER` at it.
* **Build first.** The runner deliberately does not: it prints both binaries
  and their timestamps instead, because the trap that has cost this suite the
  most time is a stale release binary quietly passing tests against code from
  days ago.

`E2E_SERVER_IMPL=murmur` still selects the fork for a parity run. It is not the
default, deliberately - a default that fell back to the fork would make an
unported feature look ported.
