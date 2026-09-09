# Lazy-loaded message history in both directions, a server-managed channel type, and thumbnails

Plan, 2026-09-09. Facts below were verified against the working trees of `vendor/starling`
and `vendor/client`; line numbers are as of this date.

## 0. TL;DR

Opening a persistent channel today fetches the newest 50 messages, and that is the only page
the client will ever ask for unless the reader hits a sentinel hidden in a dismissible banner.
Nothing is ever unloaded. The host keeps up to 500 messages per thread, hands the **entire**
array to the UI over IPC on every event, and the UI mounts a tail-anchored slice that only
ever grows toward the top. A channel with a few thousand image messages is therefore a slow
open, a large resident set, and a scroll that gets worse the further back you read.

This plan makes seven decisions:

1. **History pages in both directions.** The server implements `Cursor.after_id`, which has
   been on the wire since epoch 1 and was never read. Pages are always chronological, so the
   client concatenates them at an edge and never sorts.
2. **The host becomes a bounded cache in front of a source, not a mirror of the archive.**
   Each thread holds one *contiguous* range of ~300 messages plus `more_before` / `more_after`,
   and evicts from the edge the reader is moving away from, because the source can serve it
   again.
3. **The UI pages from the host** through `get_messages_page`, instead of receiving the whole
   thread on every event. `get_messages` and the `refreshMessages`-after-everything pattern
   leave the chat path.
4. **The DOM window becomes two-sided**, with sentinels above *and* below, one shared
   implementation for Standard and Nebula instead of today's two divergent copies.
5. **A non-end-to-end channel type: `SERVER_MANAGED` (`pchat_protocol = 3`)**, declared in
   every proto since epoch 1 and implemented nowhere. The client sends the message envelope in
   the clear under TLS; the server seals it at rest with a server-held data key and unseals it
   on fetch. No key ladder, no re-keying, and a late joiner reads the whole archive.
6. **A channel-modes cache in the runtime**, so `pchat` can refuse a message whose declared
   protocol disagrees with the channel, and `text` can stop archiving and serving the plaintext
   half of end-to-end channels. That second half closes an existing disclosure.
7. **Thumbnails everywhere, for every channel type.** The sender always inlines a ≤320 px
   thumbnail and uploads the full image as a file object; the full bytes are fetched only when
   the lightbox opens. For objects the server can already read it also derives a thumbnail
   itself, so clients that send none still get one.

Six phases, each shippable alone. Phase 1 is server-only and improves the current client with
no client change. The riskiest single item is decision 2: the host's contiguous-range
invariant has to survive edits, pins, the dual-path legacy copy, and optimistic sends.

## 0.1 Status (2026-09-09)

Nothing is built. This document is the design; every line number below is a citation of what
exists today, not of new code.

Numbers to fill in from Phase 6 once they can be measured:

| Measurement | Today | Target |
|---|---|---|
| Private working set, 2000-message image channel | | |
| Bytes on the wire to open that channel | | |
| DOM rows mounted after scrolling to the top and back | | |
| Time to first painted message | | |

## 1. The problem

Four separate ceilings, each of which alone is enough to make a large channel unpleasant.

**The server only pages backwards.** `Cursor` carries `before_id`, `after_id` and `limit`
(`vendor/starling/crates/proto/fancy/proto/fancy/wire.proto:24-38`), and the comment above it
says keyset paging exists precisely so positions stay stable. `after_id` is never read by
Starling. `PchatService::fetch` has two SQL branches, both `ORDER BY id DESC`, one with
`id < ?` and one without (`crates/services/pchat/src/lib.rs:340-348`). There is no way to ask
for what comes *after* a message, so a client that dropped the middle of a thread can only get
it back by paging from the newest message all the way down.

**Every page costs a full count.** `total_stored` is a real `COUNT(*)` over the channel on
every single fetch (`pchat/src/lib.rs:390-395`, `count()` at `:403-418`), including the
hundredth page of a scroll-back.

**The client never unloads anything.** The host caps a thread at 500 with `push_capped`
(`vendor/client/crates/mumble-tauri/src/state/mod.rs:265-281`) — but the fetch merge path
prepends and re-sorts without going through the cap at all
(`src/state/pchat/inbound.rs:394-436`), so a paged thread grows past it. The UI holds one flat
array for the selected channel (`ui/src/core/store/index.ts:381`) which is replaced wholesale
by `get_messages` on essentially every event (`:1635`, and the tail of nearly every handler).
The DOM window is explicitly tail-anchored and one-way: it grows toward the top in 100-message
chunks and only ever shrinks back from the bottom
(`ui/src/core/features/chat/chatWindowing.ts:24-96`).

**Images are carried at full size.** An inline image rides as a `data:` URL in the message body
up to `image_message_length`, default 128 KiB
(`vendor/starling/crates/runtime/src/settings.rs:77`); Standard's composer fits to that budget
(`ui/src/ui/standard/components/chat/useChatSend.ts:132-180`). A file attachment is a marker
comment plus a separate object, but the preview fetches the *whole* object when it is small
enough to inline (`ui/src/core/features/fileserver/starlingFiles.ts:103-215`) and the lightbox
only ever shows what is already there
(`ui/src/core/features/chat/imagePopout.ts:27-38`). There is no thumbnail anywhere in the chat
path. The mitigation that does exist is offloading: a body over 4096 bytes containing
`src="data:image/` or `src="data:video/` is moved to an encrypted temp file and replaced with a
placeholder (`src/state/offload_ops.rs:142-155`, `src/state/offload.rs`), which bounds resident
memory but does nothing about what crossed the network.

And one adjacent defect this plan fixes because it is in the way: **the plaintext half of an
end-to-end channel is archived and served without a permission check.** The client always sends
a legacy `TextMessage` beside the pchat message; with the default preference that body is the
literal `[Encrypted message]`, but a user who turns dual path on sends the real text
(`src/state/messaging/mod.rs:134-145`, default at `ui/src/core/preferencesStorage.ts:42`). The
text service stores every `TextMessage` unconditionally, never consulting the channel's
`pchat_protocol` (`crates/services/text/src/lib.rs:586-629`, `record` at `:163-185`), and
`on_history` serves that table with **no** `Permit` call at all (`:881-937`) — unlike pchat's
fetch, which was given a `Perm::ENTER` check by the S1 fix (`pchat/src/lib.rs:802-808`, and
`docs/SECURITY-AUDIT-pchat.md:389`).

## 2. What the code does today

### 2.1 Server

| Thing | Where |
|---|---|
| pchat `Fetch` → `FetchResponse`, newest-first, `before_id` only | `crates/services/pchat/src/lib.rs:328-396`; handler `:793-819` |
| Cursor resolution: wire id (`client_id`) → storage id (`id`) | `pchat/src/lib.rs:320-325`, `stored_id` above it |
| Rows: `pchat_message`, PK `(server_id, channel_id, id)`, `id` a UUIDv7 blob | `pchat/src/lib.rs:47-168` (six migrations) |
| Wire id ≠ storage id: `client_id` is sender-minted and unique per channel | migrations `0004`/`0006`, `wire_id()` `:438-449` |
| A page is the stored frames replayed verbatim | `docs/PROTOCOL-REDESIGN.md:194-197` |
| `archivable()` trusts the *message's* declared protocol, not the channel's | `pchat/src/lib.rs:170-186` |
| Rate limit `Op::Fetch` = 0.5/s, burst 10; a refused fetch is **silently dropped** | `pchat/src/limits.rs:40-47`; `pchat/src/lib.rs:793-796` |
| text history: same shape, ordered by UUIDv7, **no permission check** | `crates/services/text/src/lib.rs:188-224`, `:881-937` |
| text archives every message regardless of channel mode | `text/src/lib.rs:586-629` |
| The tree-subscription pattern to copy for channel modes | `crates/services/permissions/src/lib.rs:215-275` (`follow_tree`), `apply_tree_event` `:277+` |
| `Channel.pchat_protocol` on the mesh, populated from `ChannelState` | `crates/proto/fancy/proto/metadata.proto:79-86`; `services/metadata/src/serialize.rs:141-143` |
| Nothing validates `pchat_protocol` on update | `services/metadata/src/tree_actor.rs:581` |
| At-rest encryption model to reuse (XChaCha20-Poly1305) | `crates/services/files/src/crypto.rs` |
| Key-file-on-first-boot precedent | `crates/services/files/src/sign.rs:57-77` |
| Image resizer, `shrink(bytes, edge, max_pixels)`, only dep is `image` | `crates/services/link-preview/src/thumbnail.rs:27-66` |
| File objects and signed URLs | `crates/services/files/src/lib.rs:168-232`, `:290-301`; upload `http.rs:843-885` |
| Refusal shape, already used by files | `fancy/wire.proto:60-81`; `fancy/files.proto:177-180` |

`SERVER_MANAGED = 3` is declared in `fancy/pchat.proto:84-93`, mirrored in
`classic/proto/Mumble.proto:250-262` and `fancy/domain.proto:72-74`, and has **zero**
implementation in either tree.

### 2.2 Client

| Thing | Where |
|---|---|
| Host store, per channel and per DM | `src/state/mod.rs:283-291`; cap `:265-281` |
| Fetch merge: prepend, then re-sort the whole vector by timestamp, uncapped | `src/state/pchat/inbound.rs:394-436` |
| Dedup and the legacy-copy overwrite rule | `src/state/pchat/inbound.rs:192-223` |
| All four fetch triggers, all `before_id: None, limit: 50` | `handler/server_sync.rs:809-870`, `handler/user_state.rs:631-667`, `handler/channel_state.rs:314-347`, `pchat/key_exchange.rs:491` |
| The one paging entry point | `state/messaging/mod.rs:91-104`; command `commands/offload.rs:54-67`; wire `pchat/outbound.rs:84-104` |
| `PchatFetch` already has `after_id` on the client's own wire | `crates/mumble-protocol/src/proto/mumble_proto.rs:1290-1314` |
| Protocol enum folds `ServerManaged` into `None` | `crates/mumble-protocol/src/state.rs:21-91` |
| Encrypt/decrypt dispatch, no protocol-3 arm | `crates/mumble-protocol/src/persistent/keys/crypto.rs:14-93` |
| Dual-path send | `src/state/messaging/mod.rs:105-181` |
| Signal local cache: AES-GCM, timestamp-ordered, unbounded, loaded whole | `src/state/local_cache.rs:106-138`; load `handler/server_sync.rs:501-513` |
| UI thread array + wholesale refresh | `ui/src/core/store/index.ts:381`, `:1635` |
| Window sizing policy (shared) | `ui/src/core/features/chat/chatWindowing.ts` |
| Scroll state machine (Standard) | `ui/src/core/features/chat/useChatScroll.ts` |
| The same logic re-implemented (Nebula) | `ui/src/ui/nebula/components/chat/MessageList.tsx:226-307`, `:426-443` |
| Built but unused prepend-payback helper | `ui/src/core/features/chat/useScrollAnchor.ts` |
| Load-more sentinel, inside a dismissible banner | `ui/src/ui/standard/components/security/PersistenceBanner.tsx:60-82` |
| "New messages" pill — Standard only | `ui/src/ui/standard/components/chat/ChatView.tsx:1576-1580` |
| Offload: threshold, placeholder, three sweeps | `src/state/offload_ops.rs:142-231`; UI `core/messageOffload.ts`, `useMessageOffload.ts` |
| Attachment marker | `ui/src/core/features/chat/fileAttachments.ts:12-27` (`key` is the object key, not a crypto key) |
| Lightbox | `ui/src/core/features/chat/imagePopout.ts:27-38` |

`MessageEnvelope.attachments` exists (`crates/mumble-protocol/src/persistent/wire.rs:49-71`) but
is always sent empty (`state/pchat/outbound.rs:48`) and rendered nowhere.

## 3. Decisions

**D1. Pages are chronological, in both directions, and the client never sorts.** The server
keeps returning newest-first for a `before_id` walk (that is what the shipping client parses)
but the *contract* the client relies on is "a page is a contiguous range in server order, and
the caller knows which edge it belongs to". Because pages attach at an edge, the client needs
no server-side id and no sort key: concatenation preserves global order for free. Live
arrivals append at the tail. Timestamps become display-only.

*Why this matters:* the current merge re-sorts by the **sender's** clock
(`inbound.rs:429`), which is not the archive's order, is attacker-controlled, and puts a
message with a skewed clock in the wrong place permanently.

**D2. `SERVER_MANAGED` rides pchat with `protocol = 3`.** The client puts the serialized
`MessageEnvelope` in `Message.ciphertext` unencrypted, with `epoch`, `epoch_fingerprint` and
`chain_index` zero. The server seals the row at rest and unseals it on fetch.

*Why pchat and not text,* which the design review argued for: the shipping client speaks pchat
`Fetch`/`Ack`/`Pin`/`Delete`/edit end to end and has **no** implementation of the text service's
`HistoryRequest` (the epoch-1 client codec rewrite, M2, is still open — see
`docs/PROTOCOL-REDESIGN.md` and the epoch-1 notes). Routing server-managed channels through
text would mean writing a second client history path from scratch and giving up pins, acks,
edits and the attachment model. The cost is that pchat's "the ciphertext is opaque"
contract (`fancy/pchat.proto:5-8`) gains one documented exception, gated on the channel's
configured mode rather than on the client's word.

**D3. A `ChannelModes` cache in `starling-runtime`.** A `Metadata.Watch` subscription folded
into a `HashMap<u32, u32>` beside `Roster`, copied structurally from
`permissions::follow_tree` (`crates/services/permissions/src/lib.rs:215-275`) — snapshot first,
deltas after, short retry, no request on the hot path. Two consumers:

- **pchat** refuses a `Message` whose `protocol` disagrees with the channel's configured
  `pchat_protocol`. This closes the gap the code already documents at `pchat/src/lib.rs:179-183`
  ("a client that mislabels its own message still gets it archived") and is what makes
  protocol 3 trustworthy: without it, any client could ask the server to store plaintext in an
  end-to-end channel.
- **text** stops archiving and stops serving history for any channel whose `pchat_protocol` is
  not 0. That removes the duplicate row per dual-path message and closes the disclosure in §1.

*Note:* `metadata` accepts any `pchat_protocol` value on update without validation
(`tree_actor.rs:581`); Phase 1 adds a range check there too.

**D4. One server data key, versioned, on disk.** `<data_dir>/pchat-at-rest.key`, 32 bytes,
mode 0600, generated on first boot, overridable by `STARLING_PCHAT_AT_REST_KEY` (base64) for
hosts with a secret manager. Modelled directly on `files::sign::secret`
(`files/src/sign.rs:57-77`), including its reasoning about stability across restarts.

Row format: `key_id (1 byte) ‖ nonce (24 bytes) ‖ XChaCha20-Poly1305 ciphertext`, with
`AAD = server_id ‖ channel_id ‖ id ‖ client_id`. The AAD binds a row to its position, so a row
copied between channels or re-keyed to a different id fails to open rather than decrypting into
the wrong conversation — the same discipline the client already applies to its own envelopes
(`persistent/keys/crypto.rs:14-64`). `key_id` exists so rotation is a background re-seal rather
than a flag day.

**This key is the archive.** Losing it loses every server-managed message, exactly as losing a
password loses a sealed file object (`fancy/files.proto:115-119`). Say so in
`docs/CONFIGURATION.md` and in the operator UI's channel editor.

**D5. The host is a bounded cache; the UI pages from the host.** Per thread:

```
Thread {
    rows: VecDeque<ChatMessage>,   // one contiguous range, in source order
    source: Server | LocalCache | Volatile,
    more_before: bool,
    more_after: bool,              // false ⇒ `rows` reaches the live tail
}
```

Cap ~300 rows. Eviction drops from the edge **farther from the reader's window**, and only when
`source` can serve it again: `Server` for pchat archives, `LocalCache` for Signal,
`Volatile` (no persistence, today's head-only eviction) for `pchat_protocol = 0`. Evicting the
tail sets `more_after = true`, which is the state that makes "scroll down and the far edge is
dropped" possible at all.

The alternative — a second eviction tier in the UI on top of a host that mirrors everything —
was considered and dropped: the host already has a cap, the UI already has a DOM window, and a
third window between them would be three things to keep consistent instead of two.

**D6. One two-sided window implementation.** A new `useThreadWindow` hook owns: sentinels at
both ends (reusing the 800 px pre-fetch margin from `useMessageOffload.ts:35`), growth toward
the reader, settle-shrink of the far edge, prepend and unload-above payback through the
existing-but-unused `useScrollAnchor.ts`, detached-from-tail state, and the "N new messages ↓"
pill lifted out of Standard's `ChatView`. Standard's `useChatScroll` and Nebula's `MessageList`
both consume it. Aurora is out of scope; it has no windowing and no test ids
(`src/ui-flavour.ts:5-12`).

**D7. Thumbnails are a sender obligation, with a server fallback.** Sender side, for every
channel type including non-persistent ones: an image over ~32 KB is resized to ≤320 px on the
long edge, ≤24 KB, inlined in the body, and the full image is uploaded as a file object whose
marker carries `width`, `height` and `thumb: true`. Server side, additionally: on upload of an
`image/*` object that is not password-sealed, derive a sibling object `"{key}.thumb"` and report
it as `thumb_key`, so clients that inline no thumbnail still render a small image.

*The E2E caveat, stated plainly:* file attachments are **not** end-to-end encrypted today. The
`key` in the attachment marker is the storage key
(`ui/src/core/features/chat/fileAttachments.ts:12-20`) and the only sealing that exists is
server-side and password-derived, applied during upload (`files/src/http.rs:843-885`). So a
server-derived thumbnail discloses nothing the server cannot already see. Real client-sealed
attachments are a follow-up; when they land, server thumbnails simply do not apply to them and
the sender-side thumbnail is what remains.

*Memory arithmetic:* 24 KB × 300 cached rows ≈ 7 MB worst case per open thread, against
128 KB × 2000 ≈ 256 MB for a large channel today. The offload threshold rises from 4096 bytes
to 64 KiB (`offload_ops.rs:142`, mirrored at `core/messageOffload.ts:106`) so thumbnails are
never offloaded — offloading a 20 KB body costs a round trip to save nothing.

**D8. Signal channels page from the local cache.** `local_cache.rs` gains a paged read and
stops being loaded whole into `by_channel` on `ServerSync` (`handler/server_sync.rs:501-513`).
This is what lets every persistent channel type behave identically in the UI. Capping the cache
file itself stays a follow-up.

**D9. Out of scope, recorded so it is not rediscovered.** Retention (`expires_at_ms` is never
written, so the 300 s sweeper at `pchat/src/lib.rs:926-934` is a no-op, and
`pchat_max_history` / `pchat_retention_days` are read nowhere). The pchat-as-plugin migration
(`vendor/starling/docs/STORAGE.md:477-487`). True end-to-end attachments. Aurora. SQLite
freelist reclamation after deletes (`docs/RELIABILITY.md` defect 16).

## 4. Protocol changes

All additive. `fancy/pchat.proto`, `fancy/wire.proto` and `fancy/social.proto` are frozen, but
the hygiene check only fails on **removed or moved** tags, so new fields are accepted with
`scripts/check-proto-hygiene.py --update-frozen`. `fancy/feature.proto` and `fancy/files.proto`
are not frozen yet, so their tags can still be renumbered — those changes should land while
that window is open.

```proto
// fancy/wire.proto — PageInfo
message PageInfo {
  bool   more           = 1;
  string next_before_id = 2;
  // Pass as Cursor.after_id to walk forward. Empty when this page reaches the
  // newest message, which is what tells a reader it is at the live tail.
  string next_after_id  = 3;
}
```

```proto
// fancy/pchat.proto — a fetch can now be refused out loud
message PchatEnvelope {
  oneof body {
    // ... 1-12 unchanged ...
    FetchRefused fetch_refused = 13;
  }
}

// Why a fetch and not a message: a Message is answered by Ack, which already
// carries RATE_LIMITED. A Fetch had no answer at all, so a throttled scroll
// looked to the client exactly like the end of the archive.
message FetchRefused {
  uint32 channel = 1;
  starling.fancy.wire.v1.Refusal refusal = 2;
}
```

```proto
// fancy/files.proto — Grant, Share and ManagedFile each gain the same field,
// at the next free tag in each (Grant 8, Share 11, ManagedFile 15):
  // The sibling object holding a small preview of this one, or empty where the
  // server derived none (a sealed object, a non-image, a decode failure).
  string thumb_key = 8;
```

No new field is needed to express server-managed messages: `Protocol.SERVER_MANAGED = 3`
already exists (`fancy/pchat.proto:91`) and `Message.ciphertext` carries the plaintext
envelope. No field is needed for client ordering either, per D1.

Optional, deferred to a follow-up: `Cursor.around_id = 4`, to land a window centred on a
message that is not loaded (jump-to-quote into deep history). Today Nebula does this in two
passes with a nonce (`MessageList.tsx:396-421`); with `around_id` it is one round trip.

## 5. Server design

### 5.1 Bidirectional fetch

`PchatService::fetch` gains a third SQL branch. The existing two stay exactly as they are so a
shipping client sees no change:

| Cursor | SQL | Page order returned |
|---|---|---|
| neither | `ORDER BY id DESC LIMIT n+1` | newest-first (unchanged) |
| `before_id` | `id < ? ORDER BY id DESC LIMIT n+1` | newest-first (unchanged) |
| `after_id` | `id > ? ORDER BY id ASC LIMIT n+1` | oldest-first (new) |

Both directions are one index range scan on the primary key — that is the point of the
`(server_id, channel_id, id)` PK, as `docs/STORAGE.md:273-275` puts it. `PageInfo` is filled
from whichever end the walk stopped at: a backward page sets `next_before_id`, a forward page
sets `next_after_id` and leaves it **empty** when the page did not fill, which is how the client
learns it has reached the live tail and can re-attach to it.

`after_id` with both cursors set is refused as `Refusal::INVALID` rather than guessed at.

`total_stored` is computed only when `before_id` and `after_id` are both empty, i.e. on the
first page of a thread. Every other page returns 0, which the client already treats as "no new
information" because it keeps the value from the first response
(`ui/src/core/store/slices/persistentChat.events.ts:139-166`).

The same `after_id` branch and the same `PageInfo` handling go into
`TextService::history` (`text/src/lib.rs:188-224`), which is already ordered by the same UUIDv7
id, plus the missing `Permit::allows(ENTER)` in `on_history` — copied from
`pchat::on_fetch:802-808`.

Rate limits: `Op::Fetch` goes from 0.5/s burst 10 to 2/s burst 20 (`pchat/src/limits.rs:40-47`),
because a two-sided window legitimately asks for a page at each edge, and a fast scroll through
history is a normal thing to do rather than an attack. A refusal now emits `FetchRefused` with
`retry_after_ms` from the bucket, replacing the silent `return Actions::new()` at
`pchat/src/lib.rs:794-796`; the client backs off on it instead of concluding the archive ended.

### 5.2 Channel modes

New `crates/runtime/src/channel_modes.rs`, sitting beside `roster.rs`:

```
ChannelModes {
    modes: Mutex<HashMap<u32, u32>>,   // channel id -> pchat_protocol
}
```

fed by a `Metadata.Watch` stream (`TreeRequest`) that delivers a `Tree` snapshot then `Channel`
upserts — the shape `permissions::follow_tree` already uses
(`crates/services/permissions/src/lib.rs:215-275`). It fails **open for reads and closed for
writes**: an unknown channel does not block a fetch (the `Permit` check already covers
authorisation) but does refuse a protocol-3 store, because storing plaintext against a stale
mode is the one mistake that cannot be undone.

Consumers:

- `pchat::on_message` — refuse with `Ack{REFUSED}` when `message.protocol` is not the channel's
  configured protocol. `archivable()` (`pchat/src/lib.rs:184-186`) keeps its per-message read as
  the second line of defence for rows already on disk, exactly as the comment at `:335-339`
  describes for signal rows.
- `text::on_text_message` — do not `record` when the channel's protocol is non-zero.
- `text::on_history` — return an empty page for such channels.
- `metadata::tree_actor` — reject out-of-range `pchat_protocol` on update (`:581`).

### 5.3 At rest

New `crates/runtime/src/data_key.rs` (loader, generate-on-first-boot, env override) and
`crates/services/pchat/src/at_rest.rs` (seal / open, key id, AAD assembly), reusing the
XChaCha20-Poly1305 primitives already vendored for `files/src/crypto.rs`.

Migration `0007_pchat_at_rest`: `ALTER TABLE pchat_message ADD COLUMN at_rest_key_id INTEGER
NULL`. NULL means the `ciphertext` column is what it has always been — an opaque end-to-end
payload. Non-NULL means it is sealed by this server under that key id. The column, not the
`protocol` value, is what `fetch` branches on, so a future re-seal or a protocol change cannot
strand rows.

Write path (`store_message`): when `ChannelModes` says the channel is server-managed and the
message declares protocol 3, seal `message.ciphertext` and set `at_rest_key_id`. Read path
(`fetch`): open rows whose `at_rest_key_id` is set, and **drop** rows that fail to open, logging
once per fetch rather than per row — a failure there means the key changed, and a page of
undecryptable blobs is worse than a short page.

## 6. Client design

### 6.1 Host

`MessageStore` moves from `HashMap<u32, Vec<ChatMessage>>` to `HashMap<u32, Thread>` (D5).
`push_capped` is replaced by `Thread::append_live`, which appends at the tail only when
`more_after` is false — a message arriving for a thread the reader has scrolled away from
updates the unread count and is otherwise dropped, because it will come back from the source
when the reader returns.

The merge in `pchat/inbound.rs:394-436` splits into `extend_before` / `extend_after`, both of
which dedup by wire `message_id` against the existing range and concatenate at the edge. The
`sort_by_key` at `:429` goes away (D1). Three existing behaviours have to survive that, and each
is checked in Phase 3:

- **Edits** replace in place by `replaces_id` (`inbound.rs:170-185`), so the slot keeps its
  position — unaffected by ordering.
- **The legacy dual-path copy** arrives through `text_message.rs` with a synthesized id and is
  overwritten by the decrypted row when it lands (`inbound.rs:192-223`). That dedup must key on
  the wire `message_id` *before* a row is placed, not on position. With D3's text change, this
  copy stops arriving for pchat channels at all, which is the real fix.
- **Optimistic sends** have no server position until the `Ack`. They stay in the existing
  pending list, rendered after the tail, and are reconciled by `message_id`.

New IPC, replacing `get_messages` on the chat path:

```
get_messages_page(scope, scope_id, anchor, limit)
  anchor: Tail | Before(message_id) | After(message_id)
  -> { rows, more_before, more_after, at_tail }
```

When the host's range is short at the requested edge and `source` has more, it issues the fetch,
returns what it has, and emits `thread-page-ready { scope, scope_id, direction }` when the page
lands — the same fire-and-forget-plus-event shape `fetch_older_messages` already uses
(`commands/offload.rs:54-67`). `fetch_older_messages` stays as a thin wrapper so nothing breaks
mid-phase.

`local_cache.rs` gains `page(channel, anchor, limit)` over its already-timestamp-ordered vectors
(`:114-123`) and stops being loaded wholesale at `handler/server_sync.rs:501-513`.

### 6.2 UI

`store.messages` becomes a window object rather than a thread mirror:
`{ rows, moreBefore, moreAfter, atTail }`. The `refreshMessages`-at-the-end-of-every-handler
pattern is replaced by targeted updates: an arriving message appends when `atTail`, and bumps a
counter otherwise.

`useThreadWindow` (new, in `core/features/chat/`) owns the state machine:

| Reader state | Above | Below |
|---|---|---|
| At tail | grow on sentinel; settle-shrink after `SETTLE_SHRINK_MS` | pinned, appends follow |
| Scrolled up | page in, payback via `useScrollAnchor` | unload beyond the window, mark `moreAfter` |
| Detached, new arrivals | unchanged | "N new messages ↓" pill; click re-anchors to tail |

`chatWindowing.ts` keeps its constants and gains the head-side counterparts of
`grownTailCount` / `settledTailCount`. Standard's `useChatScroll.ts` and Nebula's
`MessageList.tsx` both delegate; the sentinel moves out of `PersistenceBanner.tsx` (a
dismissible banner is the wrong owner for the load-more trigger) into the window hook, which is
also what fixes Nebula having no automatic trigger at all.

### 6.3 Server-managed channels on the client

`PchatProtocol::ServerManaged` stops folding into `None` (`mumble-protocol/src/state.rs:21-91`),
with `is_encrypted() == false`. `crypto.rs` gains an identity arm for protocol 3: encode the
envelope, do not seal it, and never enter the key ladder. Strings (`serde_helpers.rs:7-19`,
`core/types/pchat.ts:5`, `core/types/chat.ts:5`), both channel editors
(`ChannelEditorDialog.tsx:395-401`, `ChannelEditorSurface.tsx`), and the persistence banner copy
plus locales gain the fourth mode. The banner must say what this mode *is*: history is kept and
readable by the server, which is the entire point and also the thing a user must not have to
infer.

## 7. Thumbnails

**Sender**, in `useFileUpload.ts` and `useChatSend.ts`, reusing `resizeImage`
(`core/features/settings/imageUtils.ts:34+`) which already does progressive-quality canvas
resizing: an image over ~32 KB produces a ≤320 px, ≤24 KB thumbnail inlined in the body, plus a
full-size object upload. The marker gains `width`, `height` and `thumb`, so layout is reserved
before anything loads and the list does not jump. Below that threshold the image is small enough
to be its own thumbnail.

**Server**, in the files service: after `drain_body` (`files/src/http.rs:843-885`), for
`image/*` objects with no seal, call `shrink(bytes, 320, max_pixels)` and write a sibling row
under `"{key}.thumb"`. `shrink` moves from `crates/services/link-preview/src/thumbnail.rs` to a
small shared crate (`crates/imaging`) — `starling-files` must not depend on
`starling-link-preview`, which drags in `starling-outbound` and its SSRF-hardened client. No
change to signing or download: a thumb is an ordinary object with an ordinary signed URL, so
`Grant`/`Share`/`ManagedFile` only need to *name* it.

**Reader**: `starlingFiles.ts` prefers `thumb_key` for previews; `imagePopout.ts` fetches the
full object on click, including for session- and password-mode keys, which today it cannot show
at all (`:27-38` returns the inline `src` or a public URL only).

**Offload**: `HEAVY_THRESHOLD` 4096 → 64 KiB in both `offload_ops.rs:142` and
`core/messageOffload.ts:106`, so thumbnails stay resident and only genuinely large legacy inline
bodies are offloaded.

## 8. Phases

Each phase is independently shippable and independently useful.

1. **Server paging and hygiene.** `after_id` + `next_after_id` + conditional `total_stored` +
   `FetchRefused`; looser fetch bucket; `ChannelModes`; text gets `Permit`, `after_id`, and
   stops archiving/serving pchat channels; `metadata` validates the enum. *Improves the current
   client with no client change* (fewer counts, no silent throttle) and closes the §1
   disclosure.
2. **Server-managed at rest.** Data key loader, `at_rest.rs`, migration `0007`, write and read
   branches, configuration docs.
3. **Client host.** `ServerManaged` through the protocol enum and crypto dispatch; `Thread` with
   the contiguous-range invariant; `extend_before` / `extend_after`; `get_messages_page`;
   `local_cache` paging; the three ordering hazards above covered by tests.
4. **Client UI.** `useThreadWindow`; two-sided sentinels; shared pill; store window; both packs
   migrated; sentinel out of the banner.
5. **Thumbnails.** `crates/imaging`; upload-time thumb rows; `thumb_key` on the wire;
   sender-side thumbnails; lightbox fetch; offload threshold.
6. **e2e.** Page-object scroll and count helpers; the suites in §10.

## 9. Files

| File | Change |
|---|---|
| `starling/crates/services/pchat/src/lib.rs` | forward branch in `fetch`, conditional `count`, `FetchRefused`, protocol check via `ChannelModes`, seal/open on store and fetch |
| `starling/crates/services/pchat/src/{limits,at_rest}.rs` | fetch budget; new at-rest seal/open |
| `starling/crates/services/text/src/lib.rs` | `Permit::ENTER` on history, `after_id`, skip archive and history for pchat channels |
| `starling/crates/runtime/src/{channel_modes,data_key}.rs` | new: metadata-watch mode cache; server data key loader |
| `starling/crates/services/metadata/src/tree_actor.rs` | validate `pchat_protocol` on update (`:581`) |
| `starling/crates/proto/fancy/proto/fancy/{wire,pchat,files}.proto` | `next_after_id`; `FetchRefused` arm; `thumb_key` |
| `starling/crates/imaging/` | new: `shrink` moved out of `link-preview` |
| `starling/crates/services/files/src/{http,lib}.rs` | derive and store sibling thumb, report `thumb_key` |
| `starling/docs/{CONFIGURATION,SERVICES,STORAGE}.md` | the data key, the mode cache, the new column |
| `client/crates/mumble-protocol/src/state.rs`, `persistent/keys/crypto.rs` | `ServerManaged`; identity arm for protocol 3 |
| `client/crates/mumble-tauri/src/state/mod.rs` | `Thread`, cap, eviction |
| `client/crates/mumble-tauri/src/state/pchat/{inbound,outbound}.rs` | edge merge without sorting; `after_id` |
| `client/crates/mumble-tauri/src/state/{local_cache,messaging/mod}.rs`, `handler/server_sync.rs` | paged local cache; no wholesale load; protocol-3 send path |
| `client/crates/mumble-tauri/src/commands/{offload,messaging,registry}.rs` | `get_messages_page`, `thread-page-ready` |
| `client/.../ui/src/core/features/chat/{useThreadWindow,chatWindowing,useChatScroll,useScrollAnchor,useMessageOffload}.ts` | new hook; head-side helpers; delegation; anchor reuse; threshold |
| `client/.../ui/src/core/store/{index,slices/persistentChat*}.ts` | window instead of array; targeted updates |
| `client/.../ui/src/ui/{standard,nebula}/**` | both packs onto the shared hook; sentinel out of `PersistenceBanner`; pill shared |
| `client/.../ui/src/core/features/chat/{fileAttachments,imagePopout,useFileUpload}.ts`, `fileserver/starlingFiles.ts`, `messageOffload.ts` | thumbnails, lazy full fetch |
| `e2e src/pages/{chat,sidebar}.page.ts` | scroll and rendered-count helpers; `server_managed` |
| `e2e src/tests/history-*.multiclient.test.ts`, `thumbnails.test.ts` | new suites |
| `e2e docs/SERVER-COVERAGE.md` | fetch windows and empty history rows |

## 10. Verification

**Server unit.** Beside `a_page_is_addressed_by_the_same_id_its_messages_carry`
(`pchat/src/lib.rs:1345`): a forward walk returns the complement of the backward walk over the
same archive with no gap and no repeat; an exhausted forward page leaves `next_after_id` empty;
`total_stored` is present on the first page and zero after; both cursors set is refused;
a protocol-3 message into a `FANCY_V1_FULL_ARCHIVE` channel is refused; a sealed row's stored
bytes do not contain the plaintext; a restart with the key present reads it back; a wrong key
drops the row instead of serving garbage. For text: history without `ENTER` is refused, and a
`TextMessage` on a pchat channel is neither stored nor served.

**Server e2e** (`crates/starling/tests/e2e.rs`): page forward and backward across a
200-message archive through the real gateway; a late joiner on a server-managed channel reads
messages sent before they arrived; a throttled fetch produces `FetchRefused` with a
`retry_after_ms` rather than silence.

**Client unit** (`ui/src/core/features/__tests__/`): window grows and shrinks at both edges;
a page landing above the reader does not move the viewport; unloading below sets `moreAfter`;
the pill appears only when detached; ordering survives an edit, a pin, an optimistic send and a
duplicate delivery.

**e2e suites**, both UI flavours:

- `history-paging.multiclient.test.ts` — 200 messages in a full-archive channel: opening mounts
  a bounded number of rows, scrolling up loads older pages, scrolling back down unloads above
  and re-attaches to the tail, and the DOM row count never exceeds the window ceiling.
- the same shape for `server_managed`, plus a late joiner reading the whole archive and a
  server restart preserving it.
- `signal` paging from the local cache.
- `thumbnails.test.ts` — a posted image renders a small inline `<img>`, the full object is not
  fetched until the lightbox opens.
- a negative test that a `TextMessage` sent into an end-to-end channel is not returned by text
  history.

Promote the measurements in `src/tests/zzz-probe-media-scroll.test.ts` (which already wraps
`__TAURI_INTERNALS__.invoke` and records frame gaps and every media round trip) into an
assertion once the targets in §0.1 have real numbers.

**Gates.** Server: `cargo test`, `cargo clippy --workspace --all-targets -D warnings`,
`cargo fmt --all`, `scripts/check-proto-hygiene.py`, and `gh run list` after pushing — a green
local clippy on Windows proves nothing about Linux-only `cfg` code or `cargo-deny`. Client:
`npm test` in `ui/`, `scripts/check-proto-drift.sh`, and rebuild `ui/dist` before cargo, which
does not do it for you. e2e: `scripts/e2e.mts`; an isolated re-run is what distinguishes a real
failure from the known rotating flake.

## 11. Risks

- **The data key is the archive.** No key, no server-managed history. It needs to be in the
  operator's backup story before the feature is announced, and the channel editor has to say
  what the mode means for confidentiality.
- **Server-managed is not end-to-end, and users must not have to infer that.** The banner, the
  channel editor and the channel list all need to distinguish it from the encrypted modes.
- **The contiguous-range invariant is the load-bearing assumption of D5.** Anything that inserts
  a row out of band breaks it silently and the symptom is a duplicated or missing message far
  from the cause. Edits, pins, the legacy copy and optimistic sends are the four known paths;
  each gets a test in Phase 3 before the UI depends on it.
- **Two packs, one hook.** Standard and Nebula have diverged; unifying them will move scroll
  behaviour in at least one of them. Phase 4 lands behind the existing scroll and offload unit
  tests, and the probe test is the before/after.
- **Rate limits versus fast scrolling.** 2/s burst 20 is a guess. `FetchRefused` exists so the
  client can back off visibly rather than appear to hit the end of history; the bucket can be
  tuned from real behaviour afterwards.
- **Deleting rows does not shrink the file.** SQLite runs without `VACUUM` here
  (`docs/RELIABILITY.md` defect 16), so a server-managed archive that is later purged leaves the
  pages behind. Out of scope, but it lands on the same table.
- **The proto freeze.** Every change in §4 is additive and passes the hygiene check, but
  `feature.proto` and `files.proto` are still renumberable and that window will close. Their
  changes should not be the last phase to land.
- **Thumbnails do not help end-to-end attachments,** which are a follow-up. Until then a
  server-derived thumbnail is only possible where the server already sees the bytes, which is
  everywhere today and is itself worth saying out loud.

## Sources

Verified against the working trees on 2026-09-09: `vendor/starling` (`crates/services/{pchat,
text,files,metadata,permissions,link-preview}`, `crates/runtime`, `crates/proto/fancy`) and
`vendor/client` (`crates/mumble-protocol`, `crates/mumble-tauri` and its `ui/`). Design context
from `vendor/starling/docs/{PROTOCOL-REDESIGN,STORAGE,RELIABILITY,SERVICES}.md`, and from this
repository's `docs/{SECURITY-AUDIT-pchat,SERVER-COVERAGE}.md`.
