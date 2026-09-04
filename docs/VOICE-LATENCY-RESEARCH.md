# Why voice feels slower on a Fancy server, and where the milliseconds actually are

Research, 2026-09-03. It answers "where does the delay come from" and ends in a fix list.
Facts were verified against the working trees of `vendor/client` (378ea67),
`vendor/starling` (1448e7c, v0.2.13) and `vendor/server`, plus the `rodio 0.22.2` source
in the local cargo registry. Line numbers and code descriptions are as of that reading,
which is what makes the analysis checkable; **most of §4's fix list has since been
implemented**, so §1 describes the code as it was and §4 says what each item is now.
Numbers for the stock Mumble client and for Discord are from memory of their public
defaults and are marked as such.

> **The first implementation of §4 was lost.** It was written on 2026-09-03 on a branch
> called `wip/voice-latency` and never pushed, while this document — which says it was
> done — *was*. Pulling on another machine on 2026-09-04 produced a repository whose docs
> described an adaptive jitter buffer, a 10 ms output buffer and `TCP_NODELAY`, and whose
> code had none of them: `SpeakerBuffers` was still `HashMap<u32, VecDeque<f32>>`, the PLC
> helper was still `#[allow(dead_code, reason = "kept for future jitter-buffer
> integration")]`, and `set_nodelay` appeared nowhere in the workspace. No branch, no
> stash, no dangling commit, on any machine. **Push the branch before writing the document
> that says the branch exists.** §4 was reimplemented from this document on 2026-09-04
> (`bcb5ae4`), which is the one good thing to be said for having written it in this much
> detail.

## 0. TL;DR

1. **The latency is overwhelmingly in the client, not in the server.** The receive side of
   the Fancy client holds **100 ms of audio before it starts playing** and then hands it to
   an output stream that **rodio sizes to 50 ms per buffer by default** (rodio's own docs
   call this "100 ms latency"). That is 150-200 ms of buffering on the listener alone,
   before a single network millisecond. The stock Mumble client's equivalents are a 10 ms
   nominal adaptive jitter buffer and a user-tunable output delay. This is why the Fancy
   client is slower than Discord against *any* server.
2. **Starling's UDP forwarding path is structurally the same as murmur's.** One socket, one
   synchronous router, one non-blocking `try_send_to` per recipient, no gRPC hop, no
   batching, no timers. Reading the code, there is no forwarding-latency penalty on the
   UDP path. If Starling measures slower than a legacy server, the cause is almost
   certainly that the client is **on the TCP tunnel** against Starling and on UDP against
   the legacy server, or a deployment difference, not the relay itself. Section 3 lists
   the ways that happens and how to see it in the logs.
3. **The client has no jitter buffer.** Decoded samples go straight into a per-speaker ring
   with a fixed 100 ms prime and a 400 ms cap. Depth never shrinks except by underrun, and
   gap concealment inserts up to 400 ms of *silence* ahead of real audio when frame numbers
   jump. A proper adaptive buffer (start at one or two frames, grow on late arrivals,
   shrink when deep) is the single biggest win available.
4. **Three small client bugs make the tunnel more likely and slower than it needs to be:**
   the client never sets `TCP_NODELAY`; it tunnels a frame on any UDP `WouldBlock`, which
   makes the server drop that peer's UDP binding until the next authenticated datagram;
   and a listener who is not talking only re-proves its UDP path every 15 s.
5. Nothing in this analysis is a measurement. Section 5 gives a way to measure server
   forwarding delay directly against both servers on one machine, which would settle the
   Starling-versus-legacy question with a number.

## 1. The latency budget of the Fancy client

Mouth to ear, one Windows desktop client talking to another over a LAN. "Fixed" means a
constant the code chooses; "device" means what Windows adds.

| Stage | Cost | Where |
|---|---|---|
| WASAPI shared-mode capture, default period | ~10 ms (device) | rodio opens the mic with `BufferSize::Default`, `rodio_desktop.rs:167-186` |
| rodio `Microphone` ring poll | 0-5 ms | `Microphone::next` sleeps `poll_interval` = 5 ms when the ring is empty, rodio `microphone.rs:236,321` |
| Frame accumulation | 20 ms (fixed) | `frame_size_ms` default 20, `state/types/audio.rs:222-224`; 480-sample chunks cross a `sync_channel`, `rodio_desktop.rs:216` |
| Encode loop poll | 0-5 ms | `tokio::time::interval(5 ms)`, `state/audio_tasks.rs:100` |
| Filters and Opus encode | ~1-3 ms | RNNoise works in 480-sample sub-frames with no lookahead, `filter/denoiser/rnnoise.rs:36-61`; complexity 8, `audio/encoder.rs:124` |
| Three task hops to the socket | <1 ms unless the runtime is starved | encode task → `outbound_send_task` → event loop `send_one_audio_packet`, `audio_tasks.rs:80,240`, `client.rs:326-334` |
| Network | RTT/2 | |
| Server relay | ~0.1 ms on either server | section 2 |
| UDP reader → work queue → event loop → `SharedState` lock → decode | <1 ms nominal, **spikes of tens of ms** whenever a Tauri command holds the lock or the loop | `client.rs:1090-1210`, `event_handler.rs:183-268`, and the `processing took >50 ms` warning at `client.rs:499` |
| **Pre-buffer before playout starts** | **100 ms (fixed)** | `PRE_BUFFER_SAMPLES = 4800`, `rodio_desktop.rs:435`; same constant in the cpal and native backends, `desktop.rs:369`, `fancy-audio-device/playback.rs:96` |
| **rodio output buffer** | **50 ms per callback buffer (fixed by rodio)** | `DeviceSinkBuilder::from_device` replaces `BufferSize::Default` with `Fixed(sample_rate / 20)` = 2400 frames at 48 kHz, rodio `stream.rs:207-217`; the client never calls `with_buffer_size`, `rodio_desktop.rs:771-788` |
| WASAPI shared-mode render | ~10 ms (device) | |

Total on a LAN: roughly **200-250 ms**, of which about 150 ms is the last two fixed
buffers. For comparison, from memory of upstream defaults: the stock Mumble client uses
20 ms packets, a jitter buffer with a 10 ms nominal target that adapts to measured
lateness, and an "Output delay" the user sets (default in the tens of ms), landing around
80-120 ms on a LAN. Discord is commonly measured in the 100-150 ms range. The Fancy client
is not slower because of Opus, encryption or the protocol; it is slower because it buffers
more than twice as much on the receive side, and none of it is adaptive.

### 1.1 What the receive path does, in order

`udp_reader_loop` (`client.rs:1090`) decrypts a datagram and pushes it into the work queue.
The main event loop (`client.rs:326`) pops it, calls `on_udp_message`
(`event_handler.rs:183`), which locks the whole `SharedState`, decodes the Opus frame
inside `AudioMixer::feed` (`mixer.rs:157`) and appends the PCM to that speaker's
`VecDeque` (`mixer.rs:394`). The rodio output thread pulls 960 samples at a time through
`MumbleMixerSource::refill_chunk` (`rodio_desktop.rs:533`).

Three properties of that design set the latency:

* **Priming.** Playout does not start until some speaker has 4800 samples queued
  (`rodio_desktop.rs:541-548`). From then on the depth stays wherever it was when priming
  finished, because `batch_drain_speakers` takes exactly what the output asks for
  (`desktop.rs:298-333`). The only thing that lowers it is an underrun. The buffer is
  re-primed only after 300 consecutive empty 5 ms refills (`REPRIME_AFTER`, 1.5 s), so a
  conversational pause shorter than that resumes at whatever depth is left, and a longer
  one pays the full 100 ms again.
* **No adaptation.** `feed_lost` and the PLC path exist but are unused, and the comment
  says why: "kept for future jitter-buffer integration" (`mixer.rs:243-247`). There is no
  measurement of arrival lateness and no target depth.
* **Gap fill is a latency ratchet.** `detect_certain_gap` (`mixer.rs:337`) inserts up to
  400 ms of zeros when a speaker's frame number jumps by more than 80 ms
  (`MAX_SILENCE_FILL_UNITS`, `mixer.rs:350`). Those zeros are played before the real audio
  behind them, and the resulting depth persists until the next drain-to-empty. The Fancy
  encoder does not advance its counter while the gate is closed (`pipeline.rs:104-146`,
  `encoder.rs:230`), so Fancy-to-Fancy is safe, but a speaker whose counter runs during
  silence (worth checking with a stock client) would arrive up to 400 ms late after every
  pause whose terminator was lost.

The 100 ms prime is not arbitrary: it is the amount of jitter the rest of the client
generates. Inbound decode shares the event loop with every control message and the
`SharedState` mutex with every Tauri command, and the tokio-starvation incident (bursts of
"dropped 960 oldest samples" on UI navigation) is that jitter made visible. Shrinking the
prime without moving decode off that path would trade latency for crackle.

### 1.2 Bandwidth negotiation can change the frame size

`adjust_to_server_bandwidth` (`state/audio.rs:1119-1156`) fits the configured bitrate
under the server's `max_bandwidth`, first by lowering bitrate to 8 kbps and then by
growing the packet to 40 or 60 ms. Starling's default cap is 72 000 bps
(`services/server-config/src/snapshot.rs:727`), the e2e murmur fixture runs 320 000
(`fixtures/mumble-server.ini:9`). At 72 000 the client ends up at 56.8 kbps and keeps
20 ms frames, so the default costs quality, not latency. A lower cap set by an operator
would add 20-40 ms per frame and is logged as `outbound audio clamped to server bandwidth
limit` (`state/audio.rs:494`). Check that line when comparing servers.

## 2. Starling's relay path, read against murmur's

The voice service owns UDP 64738 itself (`docs/ARCHITECTURE.md` §3; `services/voice/src/
service.rs:893-905`). The receive loop is one task: `recv_from`, then
`router().accept_datagram` under a `std::sync::Mutex` (`service.rs:975-995`). Inside the
router (`router.rs:440-870`):

1. `attribute`: one trial decrypt against the peer already bound to that source address,
   falling back to the peers known at that host (`router.rs:646-664`).
2. `bind`: record the address after the packet authenticated (`router.rs:684-703`).
3. `route`: charge the bandwidth bucket, look up recipients in the routing snapshot, and for
   each one `seal` and `send_to` (`router.rs:760-830`).
4. `send_to` is `UdpSocket::try_send_to`; a full socket buffer drops the frame rather than
   queueing it, deliberately (`socket.rs:120-131`).

murmur does the same thing on a dedicated thread: `recvfrom`, `checkDecrypt`, `processMsg`,
`sendMessage` → `sendto` (`vendor/server/src/murmur/Server.cpp:933-1220,1225-1310`). Same
shape, same number of copies, same absence of queues. The cipher differs (XChaCha20-Poly1305
for Fancy clients at 0.4.0 or later, OCB2 otherwise; `crates/crypto/src/modern.rs`) and is
not a measurable cost at 50 packets per second.

Conclusion from reading: **on the UDP path Starling adds no latency murmur does not.** The
things below are what can make it *feel* slower.

## 3. Ways a Fancy server ends up slower in practice

### 3.1 The peer is on the TCP tunnel

This is the first thing to rule out. Tunnelled audio pays TLS framing, TCP head-of-line
blocking, and on Starling two more hops than murmur: gateway → gRPC → voice, then voice →
`Fanout` broadcast → gateway → the client's socket (`tunnel.rs:60-84`,
`gateway/src/listener.rs:872-930`). It is still per-frame and unbatched on the audio lane
(`listener.rs:915-922`), but it is not the 0.1 ms path.

How each side decides:

* **Starling** starts every peer tunnelled and binds a UDP address only when a datagram
  from it *authenticates*, ping or audio (`peer.rs:32-40`, `router.rs:463-480`). It
  unbinds the moment the peer sends a `UDPTunnel` frame over TCP (`router.rs:476-480`).
  murmur does the same unbind (`Server.cpp:1938`) but starts with `aiUdpFlag = 1`
  (`ServerUser.cpp:35`) and binds on the first decryptable datagram (`Server.cpp:1136`).
  In practice both bind on the first ping; the difference is only what happens if no
  datagram ever arrives.
* **The Fancy client** opens UDP as soon as `CryptSetup` arrives and immediately sends an
  encrypted ping (`client.rs:1064-1087`). It never abandons UDP on its own; only the
  `force_tcp_audio` setting tears it down (`client.rs:1000-1030`,
  `state/types/audio.rs:193`). It does, however, **tunnel any single frame whose UDP send
  returns `WouldBlock`** (`client.rs:862-880`). One such frame makes both servers drop the
  peer's UDP binding, and a listener who is not talking only re-proves it with the ping
  piggybacked on the 15 s TCP ping (`client.rs:93`, `client.rs:579-583`). Stock clients
  ping UDP every few seconds; Starling's never-bound report assumes five
  (`router.rs:705-711`).
* **Stock Mumble clients** read the server's `good` counter from the TCP `Ping` reply and
  switch to TCP for good after 20 s of zeros. Starling reported zero until `1ce630d`
  (`voice: report real crypt counters so stock clients keep their UDP path`), which is in
  v0.2.10 and later and in this checkout. It has not been validated against a real 1.5
  client. A deployment on an older tag puts every stock client on TCP.
* **Re-keying** puts a peer back on the tunnel until its next datagram: `attach` replaces
  the peer with a fresh one whose `udp` is `None` (`router.rs:283-303`), and an
  XChaCha20 peer can only re-key, never adopt a nonce (`service.rs:530-546`). The Fancy
  client does not request resyncs for that cipher (`client.rs:1112-1120`), so this is rare.
* **The client never sets `TCP_NODELAY`.** `TcpTransport::connect` is a plain
  `TcpStream::connect` (`transport/tcp.rs:66-72`). Starling and murmur both set it on
  their side (`gateway/src/listener.rs:332-343`). Tunnelled frames leaving the client can
  therefore sit behind Nagle until the server's ACK arrives.

**How to see which path you are on.** Client log: `UDP transport started with ...
encryption` and `audio transport changed udp_active=true` (`event_handler.rs:351`); the
Aurora server InfoPanel shows the same flag (`ui/aurora/components/server/InfoPanel.tsx`).
Starling at debug level: `peer proved its UDP address` per peer, and at info, 15 s after a
peer that never did, `peer never proved a UDP address; its audio is tunnelling over TCP`
(`router.rs:714-750`). If the Fancy server shows the info line and the legacy server does
not, the comparison is TCP versus UDP, not Starling versus murmur.

### 3.2 Deployment differences

The e2e stack runs Starling natively and murmur in Docker, so locally the legacy server is
the one paying for NAT. A real deployment can invert that. The compose file publishes UDP
64738 through Docker (`vendor/starling/docker-compose.yml:155-156,380-381`), which on Linux
is kernel DNAT and negligible, and on Docker Desktop is a userland relay that adds
milliseconds. The Helm chart puts TCP and UDP on one Service with a configurable
`externalTrafficPolicy` (`deploy/helm/starling/templates/all-in-one.yaml:161-174`);
`Cluster` adds a node hop and SNAT, `Local` does not. Whatever the legacy server sits
behind should be compared like for like.

### 3.3 Bandwidth cap

Section 1.2. Only matters if the Fancy server's `max_bandwidth` is below 72 000, or the
legacy server's is much higher and the user has raised the client bitrate.

## 4. What to change, in order of milliseconds saved

**Items 1, 2, 4, 5, 6 and 7 are implemented** on `wip/voice-latency` in `vendor/client`
(`bcb5ae4`, 2026-09-04 — see the note at the top about the first attempt); §4.1 records
what the jitter buffer does. Items 3 and 8 are open, and item 3 is now the binding
constraint.

Client, receive side, in this order:

1. ~~**Stop letting rodio pick the output buffer.**~~ **Done.** `RodioMixingPlayback::start`
   now asks for a 10 ms buffer and falls back to rodio's 50 ms default, with a log line,
   only if the device refuses it. rodio picked 50 ms because "the system default is
   sometimes set completely wrong"; 10 ms is the WASAPI shared-mode engine period and a
   normal ALSA period, so this asks for what the hardware is already doing.
2. ~~**Replace the fixed 100 ms prime with an adaptive jitter buffer.**~~ **Done**, as
   `SpeakerBuffer` in `mixer.rs`. See §4.1.
3. **Move inbound decode off the shared event loop and out of the `SharedState` lock.**
   Decode in the UDP reader task (or a dedicated task) straight into the speaker buffers,
   and have `on_udp_message` only bookkeep. **Open, and now the binding constraint**: the
   jitter buffer's floor cannot go below the arrival jitter the client generates for
   itself, and the tokio-starvation incident is the proof that opening Settings generates
   tens of milliseconds of it.
4. ~~**Fix the gap-fill ratchet.**~~ **Done.** A gap up to 60 ms is concealed with the
   decoder's own PLC, which keeps the timeline and sounds like the speaker. A longer one
   is treated as a discontinuity and inserts nothing: the up-to-400 ms of zeros this used
   to write were played *ahead* of the real audio and stayed in the buffer as latency
   until the speaker next fell silent.

Client, transport:

5. ~~`set_nodelay(true)` on the TCP stream in `TcpTransport::connect`.~~ **Done.**
6. ~~On UDP `WouldBlock`, drop the frame instead of tunnelling it.~~ **Done.** One
   tunnelled frame costs the UDP binding on both servers; a dropped frame costs 20 ms of
   audio.
7. ~~Send the UDP keepalive ping on its own 5 s timer instead of riding the 15 s TCP
   ping.~~ **Done**, so a listener who is not talking gets its binding back in seconds
   rather than in up to fifteen.

Client, send side (smaller, open):

8. Drive the encoder from the capture callback instead of the 5 ms poll, or shorten the
   poll; and offer 10 ms frames as an option, as Mumble does, at the cost of 50 % more
   packet overhead.

Server: nothing needed for UDP forwarding. Validating `1ce630d` against a real stock 1.5
client is still open and is the one server-side item that changes latency for anybody.

### 4.1 The jitter buffer

`SpeakerBuffers` changed from `HashMap<u32, VecDeque<f32>>` to
`HashMap<u32, SpeakerBuffer>`. Every playback backend now calls `drain_into` and mixes
what it is handed; the policy lives in one place and is unit-tested there rather than
being reimplemented per backend.

| Behaviour | Rule |
| --- | --- |
| Playout starts | when the buffer holds its target (default 40 ms, two frames), or when the sender's terminator says the talkspurt is over, so a one-word "yes." still plays |
| Target grows | +20 ms whenever the buffer runs dry *while the sender is still live*, capped at the ceiling (default 200 ms) |
| Target relaxes | −10 ms at the end of a talkspurt that had no underrun, floored at 40 ms, so recovery is slower than reaction |
| Depth shrinks | the shallowest depth over a 2 s window was never needed, so up to 20 ms of it is skipped out, with a 2.5 ms ramp across the seam |
| Priming | per speaker, not global: a second speaker starting mid-sentence no longer plays with nothing buffered, and no longer makes everyone wait for the slowest |

The two numbers are `JitterConfig { floor_ms, ceiling_ms }`. Nothing in the UI sets them
yet; `AudioMixer::set_jitter` retunes every live buffer, so wiring a settings row to it is
a small piece of work and the obvious next one.

The policy is unit-tested in `mixer.rs` rather than per backend: that playout waits for
the target and then starts, that a one-word utterance plays on its terminator without
reaching it, that running dry grows the target and a clean talkspurt relaxes it, that the
ceiling and floor hold, that `set_jitter` reaches every live speaker, and that one
speaker still filling up no longer holds up another that is ready.

The fixed cost on the listener therefore goes from **100 ms prime + 50 ms output buffer**
to **40 ms target + 10 ms output buffer**, and the target is now the only part that grows,
only when the network earns it, and it comes back down afterwards.

## 5. Measuring instead of reading

None of the above is a measurement; the e2e suite has none for latency. The
`voice-fidelity` and `starling-voice` tests check that audio arrives and what it sounds
like, and the tunnel-only `audio-bot` cannot exercise the UDP path
(`src/util/audio-bot.ts:29-38`).

* **Server forwarding delay, both servers, one machine.** A small example binary in
  `vendor/client/crates/mumble-protocol` that runs two `client::run` instances, has one
  send audio packets whose "Opus" payload is a monotonic timestamp (neither server
  inspects the payload), and has the other record arrival time. Run against Starling
  `--all-in-one` on 64738 and against the murmur container, compare the one-way delay
  distributions. This settles the Starling-versus-legacy question directly.
* **Mouth to ear.** Two clients on one machine with the decoded-audio tap
  (`FANCY_E2E_AUDIO_DUMP_DIR`, `mixer.rs:44-70`) on the listener and a click track fed to
  the speaker's input, then cross-correlate. Coarser, but it is the number the user hears
  and the one to track while working through section 4.
