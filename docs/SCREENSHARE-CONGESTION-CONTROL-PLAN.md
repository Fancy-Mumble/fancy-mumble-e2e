# A modern screen share: congestion control, per-viewer adaptation, codecs, audio, FEC

Plan, 2026-08-30. Supersedes the same-day first draft, which planned "add GCC to the
uplink" against a code snapshot that had already moved and whose central premise turned
out to be obsolete (section 2). Facts below were verified against the working trees of
`vendor/client` and `vendor/starling` and against the str0m 0.21.0 and cros-codecs 0.0.6
sources; line numbers are as of this date.

## 0. TL;DR

The screen share has no congestion control. A share runs clean for ~45 s, queues build on
the uplink, then every keyframe dies in transit while deltas keep flowing, so viewers paint
nothing and signalling on the same link goes sluggish. Three stopgaps (halved bitrate curve,
32-packet burst pacing, a viewer resync) bound the damage; they do not measure the link.

This plan makes eight decisions:

1. **One WebRTC stack everywhere: str0m.** The server already uses it. The client's Rust
   broadcaster and native viewer move from webrtc-rs to str0m, which brings bandwidth
   estimation, pacing, probing, RTX and stats for free. webrtc-rs leaves the client.
2. **Uplink and downlink are separate control problems.** The presenter adapts its encoder
   to its own link (bitrate, then frame rate, then resolution, so text stays sharp). The
   server adapts per viewer, so one slow viewer never degrades the share for the room.
3. **Keyframes and still screens stop being expensive.** Keyframes are size-bounded and
   paced so they survive a congested link. A screen that is not changing costs almost nothing.
4. **Both ends can see the link, and congestion is testable in CI.** Presenter stats reach
   the UI (today: nothing), the native viewer gains loss and RTT, the server logs per-viewer
   estimates, and a shaping proxy in the e2e harness reproduces a slow or lossy uplink.
5. **Three codecs, chosen per share: AV1 > VP9 > H.264.** AV1 has screen-content tools
   (30-50 % less bitrate for text); VP9 is the widely decodable bridge; H.264 is the floor.
   Both new codecs already have VA-API encoders compiled into the client.
6. **Spatial simulcast (two layers), not SVC.** Full resolution plus a 720p layer; the
   server picks per viewer. With temporal layers that is four downlink rungs per viewer.
7. **Screen-share audio as one Opus track with absolute priority**, captured without the
   presenter's own voice playback, sent ahead of video.
8. **FEC on audio (Opus in-band) and video (FlexFEC-03, built into str0m by us).**

Ten phases, each shippable alone. Phase 1 alone fixes the observed collapse with no server
change. The riskiest single item is packet arrival timestamps on the server (Phase 2):
every delay-based estimator depends on them, and the loss-based control stands if they fall
short.

## 0.1 Status (2026-08-30)

Phase 1 is **built**, plus the client and server halves of Phase 0's
instrumentation. What is in the tree (uncommitted, in `vendor/client` and
`vendor/starling`):

| Landed | Where |
|---|---|
| Loss-driven AIMD controller + per-track allocator, 12 unit tests | `fancy-screenshare/src/congestion/mod.rs` (new) |
| `EncodePipeline::set_bitrate` / `content_bitrate`, both defaulted | `pipeline.rs` |
| Receiver reports parsed (loss + RFC 3550 RTT), 1 Hz budget tick, 5 s `uplink estimate` log | `broadcast.rs` (`watch_sender_feedback`) |
| openh264 live retune via `SetOption`, contained unsafe module | `encode.rs` + new `openh264-sys2` dep |
| VA-API live retune via `tune()` | `linux/vaapi.rs` |
| NVENC live retune via `nvEncReconfigureEncoder` | `linux/nvenc.rs` |
| Windows MF live retune via `SetValue` | `gpu_windows.rs` |
| `screen_broadcast_stats` Tauri command | `mumble-tauri/src/commands/screenshare.rs` |
| Uplink section in Stats for Nerds (4 locales) | `StreamStatsPanel.tsx`, `core/locales/*/chat.json` |
| Per-viewer `enable_bwe` + egress stats logged instead of dropped | `sfu/src/session/{broadcast,forward,mod}.rs` |

**All four encoder tiers now retune live.** NVENC's entry point was an untyped
slot in the dlopen'd function table; it is now typed, and the session retains
its `NV_ENC_CONFIG` so a retune can re-poke the rate-control fields and hand
the whole thing back with `resetEncoder = 0` and `forceIDR = 0`. The ABI was
not guessed: `sizeof(NV_ENC_RECONFIGURE_PARAMS) == 1824`,
`offsetof(reInitEncodeParams) == 8` and the function-table slot offset (264)
were read out of the system's `ffnvcodec/nvEncodeAPI.h` (API 12.1) with a C
probe and are now `const` assertions that fail the build if they ever drift.
The same probe re-confirmed every offset in `cfg_off`.

**One correctness fix the retune forced.** Section 2's trap is real and was
verified in the cros-codecs source: `tune()` calls `apply_tunings` ->
`new_sequence()`, so the next frame is an ordinary **P** slice carrying fresh
SPS/PPS. `patch_zero_nal_headers` inferred IDR-ness from the presence of an
SPS, so on radeonsi every retune would have stamped an IDR NAL header onto a P
slice and reported a false keyframe. It now reads the real `slice_type` out of
the slice RBSP (Exp-Golomb, `slice_type_is_intra`) and keeps the old inference
only as a fallback. The pre-existing test fixtures turned out to be valid
Exp-Golomb and still pass unchanged.

Not yet built, in rough priority order:

- **Phase 1's keyframe VBV bounding.** The verified `vbvBufferSize` offset is
  in hand, but NVENC's `LOW_LATENCY` tuning already sets a small VBV and
  overriding it with a guessed value could regress quality. This wants a
  measurement on real hardware first, not a plausible constant.
- **Phase 1's still-screen economy.** Raising `IDLE_REPEAT` from 90 ms during
  idle collides with the JS freeze heuristic, which scores the cadence change
  itself as a freeze. The plan's answer - flag repeat frames in the IPC header
  - does not work as written: repeats are a SENDER concept and the viewer that
  runs the heuristic cannot see them without an in-band signal. Needs a design
  pass, so it was left alone rather than half-done.
- **The e2e shaping proxy.** Blocked on a server change, not on the proxy: the
  advertised endpoint (`public_url`) and the bound port (`media_port`) are
  already independent, but the SFU's ICE candidate is built from the BOUND
  port (`runtime.rs:33`), so a proxy on the advertised port is bypassed. An
  optional `public_port` in `SfuConfig` would fix it and is independently
  useful for port-forwarded deployments.
- Then Phases 2-10 as written.

Verified: `cargo clippy --all-targets` clean for `fancy-screenshare` (Linux GPU
feature and `x86_64-pc-windows-gnu`), `mumble-tauri` and `starling-sfu`;
`cargo fmt` clean; 43 screenshare tests and 5 SFU tests pass; frontend `tsc`,
`eslint` and all 1939 vitest tests pass. Two of the new tests are the ones that
matter: a retuned openh264 encoder emits measurably fewer bytes on identical
content, and it emits no keyframe while doing so.

**Not verified: any of it on a GPU.** The VA-API, NVENC and Media Foundation
retunes are compile-checked (NVENC additionally ABI-checked) but have never run
against a driver. The `#[ignore]`d device test in `vaapi.rs` is the vehicle and
remains verification item 2; NVENC and MF have no equivalent yet. Nor has any
of this run against a real congested link - that is what the shaping proxy
above is for.

## 1. The failure

Logs from the night of the first draft: a 1080p share at ~40 fps, ~12 Mbit target, clean
for 45 s; then the delivered-keyframe counter freezes (every IDR lost in transit, deltas
still arriving), the viewer shows "Connecting...", and the client feels unresponsive
because the control TCP connection shares the saturated uplink. The encoder held its
target throughout: `scaled_bitrate` picks a number from pixel rate alone
(`fancy-screenshare/src/encode.rs:77-82`) and nothing ever moves it.

Stopgaps in the working tree (all uncommitted, none measures the link):

| Stopgap | Where |
|---|---|
| Bitrate curve re-based to 1080p60, ceiling 20 -> 12 Mbit | `encode.rs:78,81`; Windows copy at `gpu_windows.rs:825-829` NOT updated (still 1080p30 / 20 Mbit) |
| Send leg writes 32 RTP packets per 2 ms | `broadcast.rs:723-732` |
| VA-API planned ~2 s GOP, `force_keyframe` dropped, zero-NAL-header repair | `linux/vaapi.rs:260,268,327,407-427` |
| Viewer `SampleBuilder::with_max_time_delay(2 s)` + PLI every 512 pushed-without-popped packets | `viewer.rs:887-923` (the JS side separately has an 8 s `KEY_DROUGHT_MS`, `nativeStreamCore.ts:38-41`) |

## 2. What the code does today

### 2.1 The premise that was wrong

The SFU strips the `TransportSequenceNumber` extension from the broadcaster's peer and
sends a constant 50 Mbit REMB instead, documented at
`starling/crates/sfu/src/session/broadcast.rs:259-276`: batch reads from the UDP socket
compress a frame's packets into near-identical timestamps, Chrome's GCC saw false overuse
and throttled to <1 fps.

There is no Chrome broadcaster. Nothing in the client UI or channelviewer calls
`getDisplayMedia`; broadcasting is always the native Rust path, webrtc-rs 0.13
(`fancy-screenshare/src/broadcast.rs:370-496`). webrtc-rs has no send-side bandwidth
estimator at all, and `register_default_interceptors` registers the TWCC *receiver* only
(`webrtc-0.13.0/src/api/interceptor_registry/mod.rs:22-33`), so outbound RTP carries no
transport-wide sequence number regardless of SDP. The strip protects against a throttle
this client cannot perform, and the REMB goes to a peer with no REMB reader (`interceptor
0.14` has none). Two things in that comment remain true and matter: the batch-read
timestamp compression is real (`runtime.rs:113` stamps `Instant::now()` per packet inside
`batch_drain_udp`, `:132-139`, up to 200 packets), and any delay-based estimator we add,
str0m's included, will see it. That is Phase 2.

### 2.2 Fact table

| Fact | Where |
|---|---|
| Broadcaster RTCP loop reads everything, downcasts only PLI/FIR | `broadcast.rs:806-817` |
| One PeerConnection for screen + camera, mids "0","1"; `send_encodings: vec![]`; H.264 only | `broadcast.rs:196,417-458` |
| The `42e034` profile-level-id is decorative: webrtc-rs offers media-engine defaults, the SFU picks `42e01f` | `broadcast.rs:434-436`; str0m `codec_config.rs:257-265` |
| Cross-thread control template: `Arc<AtomicBool>` keyframe flag per track | built `broadcast.rs:506-508`, consumed `:870` |
| `capture_loop` takes `EncodeSettings` by value; `frame_interval` frozen at `:843`; `FrameScaler` built once per pipeline | `broadcast.rs:819-827`; `pipeline.rs:206,355-416` |
| Still screen: `IDLE_REPEAT` 90 ms re-encodes the last picture (~11 fps of P-frames) to satisfy the viewer's freeze heuristic | `broadcast.rs:847-863`; heuristic `nativeStreamCore.ts:139-148` |
| `EncodePipeline` has one defaulted method (`encode_repeat`), the precedent for adding more | `pipeline.rs:31-61` |
| VA-API: `tune()` exists in cros-codecs (CBR->CBR only) but is never called; `Tunings` only at construction | `linux/vaapi.rs:269-277`; `cros-codecs/src/encoder.rs:160-167` |
| NVENC: reconfigure slot is an untyped `*mut c_void`; `NV_ENC_CONFIG` is an opaque blob poked at verified offsets | `linux/nvenc.rs:347,120-142` |
| Windows MF: live `ICodecAPI::SetValue` already used per frame for `ForceKeyFrame`; mean bitrate set once | `gpu_windows.rs:363-369,795-807` |
| openh264: rebuilt on resize only, no bitrate path; safe wrapper hides `SetOption` | `encode.rs:114-156` |
| No damage tracking, no temporal layers, no LTR, no RTX, no simulcast anywhere in the crate | grep |
| **No number crosses from the broadcaster to the UI** (lifecycle events only) | `mumble-tauri/src/commands/registry.rs:282-304`, `screenshare.rs:107-124` |
| Native viewer: `SampleBuilder` + H.264 depacketizer, decode in the UI via WebCodecs (`avc1.` hardcoded); no receive-side loss/jitter from webrtc-rs | `viewer.rs:124-125,887-923`; `nativeStreamCore.ts:187` |
| SFU: str0m media mode (depacketize, re-packetize per viewer with fresh SSRC/seq); one `Rtc` per viewer; egress **unpaced** | `forward.rs:44-71,82-84` |
| SFU drops `MediaEgressStats`/`EgressBitrateEstimate` (emitted every 5 s); no `enable_bwe` anywhere | `forward.rs:96-98`; `broadcast.rs:292,304` |
| SFU viewer peers keep the standard extension map, so viewers already send TWCC feedback nobody reads | `broadcast.rs:296-306` |
| SFU forwards by the broadcaster's mid verbatim and ignores `rid` | `forward.rs:50` |
| SFU PLI forwarding is coalesced (one per mid per tick, 1 s minimum) | `forward.rs:164-210`, `mod.rs:31` |
| SFU has one trivial test (`broadcast_session_starts_empty`); negotiation, REMB, PLI, socket loop untested | `helpers.rs:138-149` |
| Voice UDP, control TCP and screen-share UDP are separate sockets on separate runtimes, sharing only the physical uplink; no DSCP anywhere | `sfu/session/mod.rs:124-162`; `services/voice/src/socket.rs:39` |
| e2e: five screen-share suites, all loopback; no shaping helper; stats scrapers exist | `src/tests/screen*.test.ts`, `src/pages/stream.page.ts:419-474` |

### 2.3 Capability inventory for codecs, simulcast, audio, FEC

| | str0m 0.21 | Client |
|---|---|---|
| VP9 / AV1 | Real packetizers and depacketizers (`packet/vp9.rs`, `packet/av1.rs` with OBU aggregation), enabled by default (VP9 PT 98/100, AV1 PT 45). VP9 receive exposes `tid` and spatial-layer byte offsets in `Vp9CodecExtra`; VP9 *send* hardcodes TID=0 (`vp9.rs:184-186`); `Av1CodecExtra` is `is_keyframe` only; no AV1 dependency descriptor (`rtp/ext.rs:26-69`) | VA-API VP9 and AV1 encoders already compiled under the `vaapi` feature (`cros-codecs/src/encoder/stateless/{vp9,av1}/vaapi.rs`); cros-codecs has no layer controls (`PredictionStructure::LowDelay` only). NVENC hardcodes H.264 GUIDs and never enumerates codecs (`nvenc.rs:84-98,736,768`). MF hardcodes `MFVideoFormat_H264` (`gpu_windows.rs:715-766`). No software VP9/AV1 encoder or decoder in the tree. UI has no `isConfigSupported` probe; `DeliveryMode` is `H264 | Jpeg` |
| Simulcast | `add_media(.., Some(Simulcast))` with per-rid SSRC+RTX, `Writer::rid()`, `MediaData.rid`, `KeyframeRequest.rid`, `request_keyframe(Some(rid), ..)`; `examples/chat.rs:627-684` is the forward-one-rid reference; RTP timestamps pass through unrewritten; munged `ssrc-group:SIM` refused | No layer primitive at any tier. The START payload (`trackContent.ts`) is the only track metadata carrier and is opaque to the server (`services/screenshare/src/lib.rs:591-596`) |
| Audio | Opus PT 111 by default, one RTP packet per 20 ms frame, `Writer::audio_level`, talkspurt marker; audio streams are **unpaced** and drained ahead of all video (`pacer/leaky.rs:267-277`); BWE counts audio bytes; DTX detection is ours | `opus`, `cpal`, `rodio`, `pipewire` present; `OpusEncoder` (`mumble-protocol/src/audio/encoder.rs:138`), `AudioMixer::feed(session, ..)` (`mixer.rs:157`). **No loopback or monitor capture on any OS** (`wasapi.rs` opens `eCapture` only; `audio/pipewire.rs` opens sinks for playback only). UI rows are inert "Soon" stubs (`StreamConfigMenu.tsx:149-154`, `ScreenSharePickerDialog.tsx:577-582`). Webview viewer already negotiates and attaches an audio track (`useScreenShare.ts:503-516`) but the `<video>` is hardcoded `muted` (`ScreenShareViewer.tsx:90-94`); native viewer drains audio (`viewer.rs:519-526`). SDP-answer discriminators count m-sections and string-match direction (`screenshare.rs:158-170`, `stream_view.rs:351`) |
| FEC | **None.** No ulpfec/flexfec/red; those names resolve to `Codec::Unknown` and can never match. NACK/RTX only. Own FEC needs `set_rtp_mode(true)` for the whole `Rtc` plus own packetization (`Writer::write` panics in rtp mode) | webrtc-rs lists `video/ulpfec` but has no FEC interceptor |

## 3. Decisions

### 3.1 str0m, completely

**Rejected:** the first draft's wholesale port of str0m's `src/bwe/` into the webrtc-rs
client. Measured cost: ~7.9k lines of `bwe/`, ~1.8k of TWCC/pacer support, plus glue (a
custom interceptor recording send time per TWCC seq, `configure_twcc_sender_only`, an RTCP
adapter, a timer loop). And it would still ramp only downward: str0m's probes are
RTX-based padding, which `TrackLocalStaticRTP` cannot emit, so probing means hand-rolling
RTX as well.

**Chosen:** replace webrtc-rs with str0m in the broadcaster (Phase 3) and the native viewer
(Phase 6). Verified against str0m 0.21.0:

- Broadcaster: `RtcConfig::enable_bwe(Some(initial))` (`config.rs:372-384`) installs the
  delay+loss estimator and a leaky-bucket pacer at ~1.1x estimate (`pacer/control.rs:28-55`);
  `Rtc::bwe().set_desired_bitrate()` (`bwe/api.rs:39-56`) is the ceiling and enables probing
  (`bwe/probe/control.rs:226-247`); `Event::EgressBitrateEstimate` arrives smoothed over 3 s
  with 5 % hysteresis (`bwe/smoother.rs:7-11`); NACK/RTX is automatic (`streams/send.rs`
  2000-packet / 3 s cache, 15 % ratio cap); `PeerStats`/`MediaEgressStats` carry RTT, loss,
  bytes. The H.264 packetizer takes a full Annex-B access unit (`packet/h264.rs:230-261`).
  `sdp_api().add_media(Video, SendOnly, ..)` -> `apply()` -> `accept_answer()` is the
  offerer flow (`change/sdp.rs:274-344,502-524,158-229`); one `Candidate::host` suffices
  against the ICE-lite SFU (peer-reflexive both ways, no STUN needed); the client ends as
  DTLS client, as today. The estimator needs TWCC feedback: with RR only it never leaves the
  initial value (`bwe/delay/control.rs:48`), which is why Phase 1's loss controller stays
  ours and why Phase 2 precedes Phase 3.
- Native viewer: recvonly offer with 2 video + 1 audio works; NACK/RTX and TWCC feedback
  are automatic; `MediaIngressStats.loss` and STUN RTT close the "no receive-side loss" gap
  (jitter stays unexposed); the depacketizer emits Annex-B with `is_keyframe` from NAL type 5,
  so `AvccStream`/`build_avcc` (`viewer.rs:661-734`) stay. The gap policy changes:
  `reordering_size_video` (default 30) holds back by count with no time bound
  (`packet/buffer_rx.rs:238-249`); two readings of the code disagree on whether it counts
  packets or complete frames, so the value is fixed by test (Phase 6 gate), and
  `contiguous == false && !is_keyframe` replaces the 512-packet watchdog as the PLI trigger.
- Both need one SFU change: str0m mids are random 3-character ids (`rtp/id.rs:127`) and
  `forward.rs:50` forwards by mid verbatim. Map by kind-ordinal in the SFU; clients keep
  reporting ordinals ("0","1") in `ViewerFrame.mid` so the embedder is untouched.
- Size: `broadcast.rs` 1102 -> ~700 lines (delete `RtpStamper`, the hand pacer,
  `build_peer`, `watch_sender_keyframes`; keep `capture_loop`, `SendLeg` timing logs, keyframe
  flags, `SignalSink` and the offer retry) plus a shared `driver.rs` of ~300 lines (UDP socket,
  one `Rtc`, command channel; `Rtc` is single-owner, so capture threads hand frames over a
  channel instead of `block_on(track.write_rtp)`). `viewer.rs` 1099 -> ~800. Cargo:
  `str0m = { version = "0.21", default-features = false, features = ["aws-lc-rs"] }`
  (`aws-lc-sys` is already in the lockfile). webrtc-rs's 14 crates leave the client: build
  time, and RUSTSEC surface under the cargo-deny gate. The webview viewer family (WebView2,
  the Windows default) is unaffected.

### 3.2 Uplink and downlink are separate problems

The presenter's estimator answers "how much can *my* uplink carry"; it must not be driven
by the slowest viewer. The SFU answers, per viewer, "how much can *this* downlink carry"
using str0m's BWE on that viewer's peer (they already send TWCC) and adapts by dropping
disposable frames (Phase 5) or choosing a smaller simulcast layer (Phase 8). Neither leg
ever asks the encoder to change on a viewer's behalf.

### 3.3 A codec-agnostic layer tag instead of bitstream sniffing at the SFU

The broadcaster knows each frame's temporal layer and (from Phase 8) its rid. It stamps the
temporal id into a small user header extension, `fancy-layer`, registered through
`Extension::with_serializer` exactly like str0m's own VLA extension (`rtp/vla.rs`,
`tests/vla.rs`); str0m attaches it to a frame's first packet and the SFU reads
`MediaData.ext_vals`. This works identically for H.264, VP9 and AV1, so the SFU never parses
NAL or OBU headers, and it survives a codec change without touching forwarding.

### 3.4 Degradation preference by content

`screenshare` and `custom` modes keep resolution and step frame rate (60 -> 30 -> 15 -> 5);
`gaming` steps resolution first (source -> 1280 -> 720). The user's preset is a ceiling,
never exceeded (`streamSettings.ts:19-33` is the vocabulary).

### 3.5 AV1 > VP9 > H.264, chosen per share

VP9 is not skipped: it is the codec with the broadest decode support (any WebKitGTK with
libvpx, WebView2) and the one str0m understands best. AV1 is preferred where the whole
channel can decode it. The presenter picks the best codec in (its encode set) intersect
(every channel member's decode set); a later joiner outside that set forces a re-offer one
rung down rather than a blank viewer. CPU-only presenters stay on H.264 (no software
VP9/AV1 encoder builds cleanly on MSVC and MinGW, and none is real-time at share resolutions).

### 3.6 Simulcast, not SVC

str0m's send packetizers flatten layers (VP9 descriptor TID is hardcoded to 0; no AV1
dependency descriptor) and no encoder tier exposes spatial SVC, whereas str0m's simulcast
send and receive paths are complete and tested. Two rids, "h" (full) and "l" (<= 720p), on
one m-line; cost ~30 % more encode.

### 3.7 Audio is unpaced and reserved

str0m sends audio streams ahead of every video packet by default (`set_unpaced`), and BWE
still counts the bytes. The allocator reserves the audio budget off the top before video.

### 3.8 FEC: Opus in-band now, FlexFEC-03 in str0m by us

Audio FEC is an encoder flag fed by measured loss. Video FEC does not exist in str0m; the
raw-RTP escape hatch (`set_rtp_mode(true)`) would make us re-own packetization for every
codec on that peer. We implement FlexFEC-03 (what Chromium negotiates) inside str0m's media
mode as a repair stream beside each video stream, carry it as a git dependency, and
contribute it upstream. It is a planned phase with a design (Phase 10), not a maybe.

## 4. Phases

Each phase ships alone and is judged with the harness from Phase 0.

### Phase 0 - See the link on both ends; be able to break it on purpose

- Broadcaster: generalise `watch_sender_keyframes` to `watch_sender_feedback`; downcast
  `ReceiverReport` (`fraction_lost`, `total_lost`, `jitter`, RTT from `last_sender_report`
  and `delay`) into the existing 5 s send-leg roll-up (`broadcast.rs:774-794`). New 1 Hz
  `screen-broadcast-stats` Tauri event (target and actual kbps, fps sent, keyframes, loss,
  RTT; later estimate, rung, layer, codec) and a presenter section in `StreamStatsPanel.tsx`.
  Written so the numbers come from `PeerStats`/`MediaEgressStats` after Phase 3 without
  changing the event.
- SFU: `enable_bwe` on viewer peers; stop dropping `EgressBitrateEstimate` and
  `MediaEgressStats` at `forward.rs:96-98`; per-viewer estimate and loss in the SFU stats
  line. Side effect: str0m's pacer replaces wire-speed egress bursts.
- e2e: a shaping UDP proxy in TypeScript (no root, cross-platform) placed at the SFU's
  advertised `media_port` and forwarding to the real port, with token-bucket rate, delay and
  loss knobs. The existing `stream.page.ts` scrapers (fps, freezes, kbps, buffer health) are
  the measurement layer. This is the harness every later phase is judged against.

### Phase 1 - Loss-driven bitrate control and live encoder retune (no server change)

- `fancy-screenshare/src/congestion/mod.rs`: `CongestionController` with the loss AIMD half
  of GCC (`fraction_lost` > 10 % -> target x (1 - 0.5 x loss); < 2 % -> +5 % per RTT; hold
  between; floor 800 kbps; ceiling `scaled_bitrate`). `BitrateAllocator`: audio reserved off
  the top (from Phase 9), then screen bulk, camera a fixed slice.
- Plumbing on the keyframe-flag template: per-track `Arc<AtomicU32>` target; `capture_loop`
  reads it each tick and calls `EncodePipeline::set_bitrate(&mut self, bps)` (a defaulted
  no-op, like `encode_repeat`) when it moved more than ~5 %.
- Tier retunes: VA-API `tune(Tunings { rate_control: ConstantBitrate(bps), .. })` (variant
  stays CBR; identical tunings are free; a tune re-emits SPS/PPS on a P-frame, which
  `patch_zero_nal_headers`/`contains_idr` must not mislabel as a keyframe). NVENC: type the
  reconfigure slot, retain the `EncConfig` blob per session, re-poke `AVERAGE_BITRATE` and
  `MAX_BITRATE`, submit with `resetEncoder = 0`. MF:
  `SetValue(CODECAPI_AVEncCommonMeanBitRate)` via the existing `variant_u32` helper; the
  pipeline starts retaining `EncodeSettings`. openh264: `openh264-sys2` and
  `SetOption(ENCODER_OPTION_BITRATE)`, fallible and non-fatal.
- Keyframe economy: bound IDR size with a small VBV where the tier allows (NVENC
  `vbvBufferSize` of one to two frames' worth, MF `CODECAPI_AVEncCommonBufferSize`); spread
  an IDR over about two frame intervals in the pacer; keep `PERIODIC_KEYFRAME` at 20 s.
- Still-screen economy: after ~1 s without a fresh frame, raise `IDLE_REPEAT` from 90 ms to
  ~500 ms and apply a QP floor (~18) so CBR stops spending the whole budget refining a static
  image. Flag repeat frames in a spare bit of the IPC record header (`stream_view.rs:20-36`)
  so the JS freeze heuristic and `screen-share-health.test.ts` learn that a cadence change is
  not a freeze.

### Phase 2 - SFU: honest arrival timestamps, TWCC back on, REMB off, mid and codec mapping

- `runtime.rs:113` is the one line that stamps every `Input::Receive`. Read with `recvmmsg`
  and `SO_TIMESTAMPNS`, pass the kernel receive time as the `Instant`, after a one-time
  `CLOCK_REALTIME` to `Instant` calibration. Per-packet `Instant::now()` inside the drain
  loop does not help; the compression happens in the kernel queue.
- Restore `set_extension(3, TransportSequenceNumber)` in `create_receiving_peer` behind
  `sfu.twcc_uplink` (default on once Phase 3 ships; the flag makes a rollout problem a
  config change). Delete the constant REMB (`mod.rs:30`, `send_remb`).
- Ordinal-mid mapping in `forward.rs`. Codec table: either the str0m clients offer `42e01f`
  or the SFU gains `42e034` on both legs (str0m rejects a remote level above its local one,
  `payload_params.rs:409-446`, and a miss shows only as a `no_pt_match` debug counter).
  Register the `fancy-layer` extension on both legs.
- First real tests on this surface: extension map, timestamp path, mid mapping.

### Phase 3 - str0m broadcaster: delay-based estimate, pacer, probing

- `driver.rs`: UDP socket, one `Rtc`, `poll_output` loop (`Transmit` -> send, `Timeout` ->
  wait, `Event` -> dispatch), `Input::Receive`/`Input::Timeout`, and a command channel
  (answer, frame, keyframe request, stop). The SFU's `runtime.rs:73-110` is the template.
- `add_media`/`apply` replaces `build_peer`; `RtpStamper` and the hand pacer are deleted;
  `Event::KeyframeRequest` sets the existing per-track flags; `EgressBitrateEstimate` feeds
  the allocator, final target = min(delay estimate, loss AIMD);
  `set_desired_bitrate(sum of per-track ceilings)` after `Connected`; frames are dropped at
  the driver when the pacer queue is deep, otherwise latency balloons.
- Host candidate: bind `0.0.0.0:0`, pick the interface by `connect()` to the SFU IP;
  loopback is allowed (the localhost-server case).
- Gate: the shaped e2e at 3 Mbit converges; a synthetic test modelled on str0m's
  `tests/bwe/common.rs` proves the Phase 2 timestamps before the flag defaults on.

### Phase 4 - Adaptation ladder and temporal layers

- Ladder per 3.4, dwell >= 10 s in each direction; `frame_interval` (`broadcast.rs:843`) and
  `FrameScaler` become mutable; the rung is shown in Stats so a downgrade is explainable.
- L1T2: odd frames are non-reference. openh264 `iTemporalLayerNum`, NVENC hierarchical-P
  `maxTemporalLayers`, MF `CODECAPI_AVEncVideoTemporalLayerCount`. cros-codecs has no layer
  control, so the VA-API tier steps fps at the capture loop instead. Halving fps is then
  "skip T1 locally": no encoder re-init, no IDR. Resolution steps still re-init and force an
  IDR, which is why they come last.
- `fancy-layer` tagging per 3.3.

### Phase 5 - Per-viewer adaptation at the SFU

- With per-viewer BWE (Phase 0) and `fancy-layer` (Phase 4), the SFU skips `writer.write()`
  of T1 frames for a viewer whose estimate is below the stream rate. str0m allocates the
  viewer stream's sequence numbers only on write (`packet/payload.rs:67`), so a skipped frame
  leaves no gap and triggers no NACK; SPS/PPS caching is per viewer, so whole-AU skips are
  safe. Never skip reference frames or partial AUs.
- Joiner keyframes stay PLI-driven and coalesced (`forward.rs:111-159`); a GOP cache is not
  worth it here (NVENC runs an infinite GOP, the others a 20 s period).

### Phase 6 - str0m native viewer; restore the ceiling; loose ends

- Viewer migration per 3.1: `reordering_size_video` fixed by test, `contiguous:false` PLI,
  `StreamPaused` (1.5 s) as the fast disconnect signal (ICE-only detection takes 15-30 s
  against an ICE-lite peer), ordinal mids, stats gain loss and RTT. Gate: one dropped
  sequence number never freezes playback for more than 1 s. Then remove `webrtc` and
  `bytes` from `fancy-screenshare/Cargo.toml`.
- Revert `scaled_bitrate` to the wider curve and make `gpu_windows.rs` call the shared
  function instead of its divergent copy. Optional: DSCP AF41 on the screen-share sockets
  and EF on voice (cheap, helps Wi-Fi WMM, a no-op on the open internet).

### Phase 7 - AV1 and VP9 as first-class codecs

- Codec becomes a pipeline parameter: `EncodeSettings.codec`, `EncodedFrame.codec`; the emit
  path stops assuming Annex-B (AVCC conversion in `viewer.rs:656,716` is H.264-only; VP9 and
  AV1 frames pass through as-is).
- Encoder tiers:
  - VA-API: `encoder::vp9` and `encoder::av1` from cros-codecs, already compiled;
    `linux/vaapi.rs` is the template, `pick_level` becomes per-codec.
  - NVENC: add the `nvEncGetEncodeGUIDCount`/`GUIDs` capability probe (absent today), then
    `NV_ENC_CODEC_AV1_GUID` + `NV_ENC_AV1_PROFILE_MAIN_GUID` with `NV_ENC_CONFIG_AV1` offsets
    verified the same way as `cfg_off`. NVENC has no VP9 encoder: that tier offers AV1 or H.264.
  - MF: `MFTEnumEx` for `MFVideoFormat_AV1` and `MFVideoFormat_VP90`; same `ICodecAPI` retune.
  - CPU: H.264 only (3.5).
- Decode: WebCodecs `vp09.*` and `av01.*` probed with `VideoDecoder.isConfigSupported` at
  startup (the current check is `typeof VideoDecoder`); a new capability handshake in
  `nativeStreamViewWorker.ts:185-190`; `DeliveryMode` gains `Vp9` and `Av1`;
  `nativeStreamCore.ts:187` derives the codec string per codec. The Rust JPEG fallback stays
  H.264-only, so a client on that path advertises H.264 decode only.
- Selection per 3.5: each client publishes its decode set in the START/presence payload
  (`trackContent.ts`, opaque to the server); the presenter picks; a joiner outside the set
  triggers a re-offer one codec down (one IDR, ~1 s glitch). Codec shown in Stats on both ends.
- SFU: nothing codec-specific in forwarding thanks to `fancy-layer` (VP9 additionally arrives
  with `Vp9CodecExtra.tid`). Set AV1 fmtp `profile`/`level-idx` and VP9 `profile-id=0`
  explicitly on both legs; str0m leaves them unset.
- Temporal layers per codec: NVENC AV1 and MF expose layer counts; VA-API VP9/AV1 step fps
  at the capture loop like VA-API H.264.
- The bitrate curve gets a per-codec factor (AV1 ~0.6x, VP9 ~0.75x of H.264 for screen
  content) so the allocator and ladder stay codec-neutral.

### Phase 8 - Spatial simulcast (two layers)

- Broadcaster: a second encoder instance per tier at <= 720p longest edge and ~1/3 of the
  top layer's bitrate; both consume the same captured frame and the same emit-instant clock,
  so RTP timestamp bases match across a switch (str0m passes timestamps through unrewritten).
  Offer with `Simulcast::new().add_send_layer("h").add_send_layer("l")`; write with
  `Writer::rid()`. The allocator splits per rid; when the uplink cannot carry both, "l" is
  dropped first and its viewers fall to T1-dropping on "h".
- SFU: replace `forward.rs:49-63` with a per-viewer layer selector (rid from the viewer's
  estimate and rendered-size hint, T1 drop within a rid) and a switch state machine: request
  a keyframe on the new rid, keep forwarding the old until `is_keyframe()` arrives on the new
  one. Four rungs per viewer: h/T0+T1, h/T0, l/T0+T1, l/T0.
- Viewer size hint: a small `viewerHint` signal (rendered width) over the existing
  WebRtcSignal path so PiP and thumbnails land on "l" without waiting for BWE.
- Probe encoder session limits per tier (consumer NVENC caps concurrent sessions) and fall
  back to single-layer where the second instance cannot be created.

### Phase 9 - Screen-share audio

- Capture. Windows: `ActivateAudioInterfaceAsync` with
  `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` and
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` on our own PID (Windows 10 2004+), so the
  presenter's voice playback is never re-shared; endpoint loopback as the older-Windows
  fallback with a UI warning that viewers will hear the call. Linux: PipeWire per-application
  capture, linking every `Stream/Output/Audio` node except our own playback node into one
  capture stream (the OBS "application audio capture" approach). Never open `<sink>.monitor`
  by name (it silently records the microphone). New modules in `fancy-audio-device`; the
  screen-share PipeWire video stream stays video-only.
- Encode: reuse `OpusEncoder` (`mumble-protocol/src/audio/encoder.rs`) in `Audio`
  application mode, 48 kHz stereo, 20 ms, 96-128 kbps, in-band FEC on (Phase 10a); our own
  silence detection sets `start_of_talkspurt`; the presenter's "mute stream audio" stops
  writing.
- Transport: one sendonly Opus m-line on the broadcaster peer; str0m sends it unpaced; the
  allocator reserves it (3.7). START payload gains `audio: true`. Prerequisite: make the
  SDP-answer discriminators structural (parse direction per m-section) before the m-line
  count changes (`screenshare.rs:158-170`, `stream_view.rs:351`).
- Viewers. Webview: drop the hardcoded `muted` when the share announces audio; the existing
  volume and mute controls already drive the element, and the click that opened the stream
  satisfies autoplay. Native: Opus decode (existing decoder) into `AudioMixer` with the key
  widened from `session` to `(session, source)` so share audio has its own gain, mapped to the
  same volume slider. A/V sync: RTP timestamps from one clock plus str0m sender reports; the
  native paint-on-arrival path accepts <= 100 ms skew (documented gap).
- The existing UI stubs ("Share Stream Audio", "Mute stream audio") become the toggles,
  default off.

### Phase 10 - FEC on audio and video

- 10a Audio, ships with Phase 9: Opus in-band FEC on, `set_packet_loss_perc` fed from
  measured loss. The SFU cannot re-encode, so the presenter's setting covers every viewer:
  use the maximum of the uplink loss and the worst viewer loss the SFU reports back in the
  existing `Health` message.
- 10b Video: FlexFEC-03 in str0m media mode, authored by us against 0.21 and carried as a
  git dependency until merged.
  - Send: each video `StreamTx` gets an optional repair `StreamTx` (own SSRC, `flexfec-03`
    payload type, `a=ssrc-group:FEC-FR`, `a=fmtp repair-window`), fed by the packetizer output.
    1-D interleaved protection with the block size chosen from the loss estimate (0 % off;
    2 % one repair per 10; 10 % one per 4; 30 % overhead cap). Repair packets ride the pacer
    at `Padding` priority so they never delay media, and count in BWE; the allocator subtracts
    the overhead. Keyframes get the densest block.
  - Receive: repair packets enter a per-`StreamRx` recovery buffer keyed by the FEC header's
    sequence mask; a recovered packet is injected into the normal register and depacketizer
    path and its sequence number is removed from the NACK register, so FEC and NACK/RTX
    compose instead of racing.
  - Negotiation: `Codec::FlexFec` with `match_score` and answer emission; off unless both
    sides negotiate it.
  - Applied on both legs: broadcaster -> SFU with overhead from the uplink loss estimate, and
    per viewer on SFU -> viewer with overhead from that viewer's `MediaEgressStats.loss`, which
    is where Chromium webview viewers benefit directly.
  - Size ~1.5-2k lines plus tests. Escape hatch if upstream stalls: `set_rtp_mode(true)` on
    our peers with our own packetization and FEC emission (all-or-nothing per `Rtc`).

## 5. Files

| File | Change |
|---|---|
| `client/crates/fancy-screenshare/src/congestion/mod.rs` | new: loss AIMD, allocator (audio, screen, camera, rids, FEC overhead), ladder |
| `client/crates/fancy-screenshare/src/driver.rs` | new: UDP socket + `Rtc` + command channel, shared by both peers |
| `client/crates/fancy-screenshare/src/broadcast.rs` | feedback loop (P0), targets (P1), str0m peer (P3), mutable interval and scaler, `fancy-layer` (P4), second encoder and rids (P8), audio m-line (P9) |
| `client/crates/fancy-screenshare/src/viewer.rs` | str0m peer, gap policy, stats (P6), VP9/AV1 delivery (P7), audio out (P9) |
| `client/crates/fancy-screenshare/src/{pipeline,encode}.rs`, `linux/{vaapi,vaapi_vp9,vaapi_av1,nvenc,mod}.rs`, `gpu_windows.rs` | `set_bitrate`, VBV, QP floor, temporal layers, codec enumeration and VP9/AV1 tiers, second instance for simulcast, per-codec curve, Windows curve reconciliation |
| `client/crates/fancy-screenshare/Cargo.toml` | + `str0m` (no default features), + `openh264-sys2`; - `webrtc`, `bytes` (P6) |
| `client/crates/fancy-audio-device/src/{loopback_windows,pipewire_app_capture}.rs` | new: system-audio capture (P9) |
| `client/crates/mumble-protocol/src/audio/{encoder,mixer}.rs` | Opus `Audio` mode and in-band FEC; mixer key widened (P9, P10a) |
| `client/crates/mumble-tauri/src/commands/{screenshare,stream_view}.rs` | stats event; repeat flag bit; structural SDP discriminators; codec and audio capabilities |
| `client/.../ui/.../stream/{StreamStatsPanel,ScreenShareViewer,StreamConfigMenu,ScreenSharePickerDialog}.tsx`, `nativeStreamCore.ts`, `nativeStreamViewWorker.ts`, `trackContent.ts`, `streamSettings.ts` | presenter stats; repeat-aware freeze heuristic; codec probe and `vp09`/`av01`; unmute; live audio toggles; START payload capabilities |
| `starling/crates/sfu/src/session/{runtime,broadcast,forward,mod}.rs` | kernel timestamps, TWCC flag, REMB removal, ordinal mids, codec table and fmtp, `fancy-layer`, per-viewer BWE, T1 drop, rid selector, viewer hint |
| str0m (git dependency, upstream PR) | FlexFEC-03 send and receive in media mode, `Codec::FlexFec` negotiation (P10b) |
| e2e `src/util/shapingProxy.ts`, `src/tests/screenshare.{congestion,simulcast,audio}.test.ts` | new harness and suites |

## 6. Verification

1. Unit: controller trajectories on synthetic feedback (a clean link ramps to the ceiling;
   15 % loss halves the target within a few RTTs; recovery is gradual). str0m's own bwe tests
   cover the estimator. Layer-selector state machine: a switch always waits for a keyframe on
   the new rid.
2. Real device: extend the ignored VA-API test `forced_keyframes_are_idrs_on_a_real_device`
   (`vaapi.rs:596-656`) with a mid-stream `set_bitrate`; frame sizes track the target, no IDR
   is forced, `ffmpeg -v error -f null -` decodes cleanly. Same harness for the VP9 and AV1
   VA-API encoders (ffmpeg's libvpx and dav1d).
3. Shaped e2e through the proxy: 3 Mbit, 1 Mbit, 5 % loss, then lift the cap. The target
   converges near the cap, `fraction_lost` returns to ~0, freezes <= 2, ramp-back within 30 s.
   Per viewer: two viewers, one shaped; the other keeps full fps and, with simulcast, the
   shaped one lands on "l". Gap stall: one dropped sequence number, no freeze over 1 s. Codec:
   an AV1-capable pair negotiates `av01`; a VP9-only joiner forces `vp09`; an H.264-only joiner
   forces `avc1`; each with one visible IDR. Audio: a 440 Hz tone through a share is heard by
   both viewer families with the presenter's own voice playback absent from the capture
   (Goertzel check as in the voice suites). FEC: at 5 % random loss and 200 ms RTT, freezes
   <= 2 and residual post-repair loss < 0.5 %, against the NACK-only baseline from Phase 0.
4. Quiet case: a fast LAN looks like today (ceiling bitrate, no oscillation, no extra IDRs);
   the five existing screen-share suites stay green after every phase.

## 7. Risks

- Kernel receive timestamps are load-bearing for any delay-based estimator. If
  `SO_TIMESTAMPNS` proves insufficient, Phases 1, 4, 5 and 8 stand on the loss controller.
- str0m negotiation failures are silent (`no_pt_match`, `no_writer` debug counters). Add
  warn-level logs and tests for mid, codec and rid mapping before either client migrates.
- The viewer's gap policy moves from time-bound to count-bound; the Phase 6 gate exists for
  exactly this.
- VP9/AV1 decode on WebKitGTK depends on the distro's GStreamer plugins; the per-share
  selection with VP9 and H.264 rungs is the mitigation, and the probe must be
  `isConfigSupported`, not `typeof VideoDecoder`. An NVENC presenter with a VP9-only viewer
  lands on H.264.
- Simulcast doubles encoder sessions; probe the limits and drop "l" first.
- System-audio capture is the most platform-fragile item (process loopback needs Windows
  10 2004+; PipeWire per-application linking depends on node-graph timing). Ship behind the
  toggle, default off.
- Video FEC lives in str0m and is carried as a git dependency until merged; the raw-RTP
  escape hatch costs us the packetizers for every codec.
- The SFU media path has one trivial test. Every phase touching it adds coverage first.
- `openh264-sys2` puts unsafe FFI in the fallback tier; keep the retune fallible.
