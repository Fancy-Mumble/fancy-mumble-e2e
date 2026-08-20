# Botroom — LLM bots conversing on a Starling server

Design, 2026-08-17. **Built and running the same day** — the code is in
[`botroom/`](../botroom/) with its own [README](../botroom/README.md), and this
stays as the reasoning behind it. §8 records what was verified and what is
left. Where the built thing diverges from the first draft of this plan, the
plan has been corrected rather than left to rot.

## 1. What it is

An external program that logs *N* bot users into a Starling server, puts them
in one channel, and has them carry a spoken conversation about a topic the
operator names at start-up. Each bot posts its line as a channel text message
and speaks it through TTS. The GPU services (LLM, TTS) and the bot process are
deployed on `nazuna` (the `nazuna-wg` SSH host).

Operator UX:

```
docker compose run --rm botroom \
    --server mumble.example.org:64738 --channel "Lounge" \
    --topic "whether cities should ban private cars" --participants 3
```

Assumptions made where the brief was open — say so if any is wrong:

- **"Direct socket connection for exchanging texts"** is read as: every bot
  holds its own TLS control connection to Starling and posts its lines as
  `TextMessage`s there. Bots learn what the others said through an in-process
  conversation bus (they are all one program), *not* by decoding each other's
  audio, so no speech-to-text is needed. Humans in the channel who *type* are
  heard through the same connections and become participants; humans who
  *speak* are a stretch goal (§8).
- One conversation per run, one channel, sequential turns (a voice chat where
  people talk over each other is not the goal).

## 2. What is on nazuna (surveyed 2026-08-17)

| | |
|---|---|
| Host | Ubuntu 26.04, 24 cores, 59 GB RAM, kernel 7.0; WireGuard `10.8.0.8` |
| GPUs | `nvidia-smi 0` = **RTX 3060 12 GB**, `nvidia-smi 1` = **RTX 3090 24 GB**; driver 580.173, CUDA 13; Docker has the `nvidia` runtime |
| Disk | **root at 97 %, 63 GB free.** Docker holds 90 GB of images, the open-webui Ollama store alone is 53 GB. Every model we add must fit in that headroom |
| Node | under nvm (`. ~/.nvm/nvm.sh`), Rust 1.94, ffmpeg with `libopus`, Python 3.14 (no torch) |
| Repo | `~/Documents/projects/fancy-mumble-e2e` clone (with built `starling` and `mumble-tauri`) |

Already running, and relevant:

- **`ghcr.io/malaiwah/qwen3-tts-server`** on `:8882` — Qwen3-TTS-12Hz-1.7B-Base,
  OpenAI-compatible, 9 preset voices (`aiden dylan eric ryan serena vivian
  sohee ono_anna uncle_fu`), `instruct` for style, and a
  **`/v1/audio/speech/pcm-stream`** endpoint that streams raw 24 kHz int16 PCM
  at token granularity (~130 ms to first chunk, ~3× real time, ~4.4 GB VRAM).
  Its compose file (`~/learn-jp-speech/docker-compose.qwen.yml`) *said* it was
  pinned to the 3060 while using `device_ids: ["1"]`, which is the **3090**.
  Corrected to `["0"]` on 2026-08-17 with the operator's go-ahead; the original
  is beside it as `docker-compose.qwen.yml.bak-botroom`.
- `kokoro-fastapi-gpu` on `:8881` — a lighter OpenAI-compatible TTS and a
  usable fallback, **stopped** on 2026-08-17 to clear the 3090
  (`docker compose -f ~/learn-jp-speech/docker-compose.speech.yml start qwen3-tts`
  brings it back). Its CPU twin on `:8880` still runs.
- `whisper-asr-webservice` on `:9000` — STT, only needed for the stretch goal.
- `open-webui:ollama` with `qwen3:32b`, `qwen3-coder:30b` pulled; sees *both*
  GPUs and is not pinnable, so we run our own LLM server.
- `web-gpu-service` holds 2.2 GB on the 3060.

GPU budget, as it now stands: the 3090 is **the LLM's alone** — 20.5 GB of
24.6 for Qwen3.8-27B at Q4_K_M with a 64k context — and the 3060 carries
6.9 GB of 12 (the pre-existing `web-gpu-service`, plus the Qwen3-TTS that was
moved there). Getting to that took the re-pin above and stopping kokoro-gpu,
which between them were holding 6 GB of the card the model needed.

## 3. What the wire needs (from the Starling survey)

- Starling accepts a **stock Mumble 1.4/1.5 client** unchanged; the epoch-1
  redesign is additive (`vendor/starling/docs/PROTOCOL-REDESIGN.md` §3). A bot
  that announces nothing Fancy gets murmur semantics.
- **Audio over the TCP tunnel is first-class and never rate-limited**
  (`gateway/src/listener.rs`, `voice/src/tunnel.rs`) — no OCB2/XChaCha key
  schedule needed. Framing follows the *announced* Mumble version: 1.4 → legacy
  type-4 packet, ≥ 1.5 → protobuf `Audio`. Sequence counts in **10 ms units**
  (a 20 ms frame advances it by 2). `Authenticate.opus = true` is mandatory.
- **`TextMessage` is throttled ~1/s per connection** (murmur's bucket, silent
  drop for legacy clients). `ChannelState`/`UserState` share that budget.
- Guests work; no cert needed unless `cert_required`. A name that is
  *registered* is refused for a guest, and **same-named connections from one
  IP replace each other silently** (`handshake.rs may_replace`), so bot
  usernames must be unique and unregistered. No per-IP connection limit.
- Channels are joined by `UserState{session, channel_id}`; creating one needs
  permission a guest usually lacks — the operator picks an existing channel
  (or a privileged "room keeper" account creates a temporary one, as
  `scripts/audio-bots.mts` already does).

## 4. What we reuse

`src/util/audio-bot.ts` (755 lines, zero dependencies) is already a Mumble
client that logs in as either flavour, joins/creates a room, and streams Opus
frames down the tunnel at an exact cadence, with the sequence-unit and
rate-limiter lessons written into it. `src/util/opus-source.ts` turns audio
into 20 ms Opus packets with ffmpeg and a 40-line Ogg page walk.

**Decision: build in TypeScript on top of `AudioBot`**, in this repo. The
alternative — a Rust binary on `vendor/client/crates/mumble-protocol` (which is
Tauri-free and has `force_tcp`, `SendTextMessage`, `SendAudio` ready) — is
sound but costs more: it announces epoch-1 by default, needs a cargo build in
the image, and the bot logic (HTTP to LLM/TTS, turn-taking) is a few hundred
lines in either language. The wire part is the risky part, and it already
exists and is proven against Starling in TS.

`AudioBot` needs three additions, all small:

1. **Text**: `sendText(message)` → `TextMessage{channel_id:[here], message}`;
   an `onText(actor, message)` event for incoming ones; track `UserState`
   names so an actor session resolves to a name (and so bots can tell humans
   from bots).
2. **Live audio**: today it pre-encodes a clip and loops it. Add a *live
   queue* mode: `speak(pcmStream) → Promise<void>` that feeds packets in as
   they are produced, paces them out at `frameMs`, sends the terminator on the
   last one, and resolves when the utterance has left the socket. Ticker
   pauses (sequence stays contiguous) if the queue runs dry.
3. **Incoming voice presence**: note the session of any `UDPTunnel` packet
   that arrives (server→client audio carries it), so the director can tell
   that a human is talking (§8). No decoding.

## 5. Architecture

```
nazuna (docker compose "botroom")                     anywhere
┌───────────────────────────────────────────────┐    ┌───────────────┐
│ llm   llama-server, Qwen3.8-27B GPU 1 (3090)  │    │   Starling    │
│ tts   qwen3-tts-server :8882  GPU 0 (3060)    │    │   :64738      │
│ botroom  node + ffmpeg                        │    └───────▲───────┘
│   ┌──────────┐  text  ┌────────┐  pcm ┌─────┐ │            │ N TLS
│   │ director ├──────►│ llm.ts │      │tts  │ │            │ connections
│   │ (turns,  │◄──────┤        │      │ .ts │ │            │ text + Opus
│   │ transcript)      └────────┘      └──┬──┘ │            │ via UDPTunnel
│   │          │  utterance ┌────────┐     │    │            │
│   │          ├──────────►│speech  │◄────┘    │            │
│   └────▲─────┘           │ffmpeg→ │ opus     │            │
│        │ human text      │opus q  ├─────►  AudioBot ×N ───┘
│        └─────────────────┴────────┘
└───────────────────────────────────────────────┘
```

Files, all under a new top-level `botroom/`:

| file | job |
|---|---|
| `main.mts` | CLI/env parsing, start-up, shutdown, reporting (modelled on `scripts/audio-bots.mts`) |
| `config.ts` | one typed `Config`: server/channel/password, topic, participants, language, LLM/TTS URLs+model, voices, turn limits, seed |
| `personas.ts` | N personas (name, one-line character, stance on the topic, TTS voice, `instruct` style). Generated by one LLM call from the topic, or taken from `--persona-file`; usernames `Ada-bot`-style, unique |
| `llm.ts` | `LlmClient`: OpenAI-compatible `/v1/chat/completions`, streaming, `chat_template_kwargs {enable_thinking:false}` (llama-server; also fits vLLM/Ollama) |
| `tts.ts` | `TtsClient`: POST `/v1/audio/speech/pcm-stream` → async iterable of 24 kHz s16le chunks; Kokoro/OpenAI-style fallback via `/v1/audio/speech` wav |
| `speech.ts` | PCM → ffmpeg (`-f s16le -ar 24000` in, `-ar 48000 -c:a libopus -frame_duration 20 -vbr off -page_duration 20000 -f ogg` out) → incremental Ogg page walk (`opus-source.ts`'s, made streaming) → `AudioBot.speak` |
| `director.ts` | transcript, speaker choice, prompt building, pipelining, human turns, end conditions |
| `Dockerfile`, `docker-compose.yml`, `README.md` | deployment (§7) |
| `src/util/audio-bot.ts` | the three additions from §4 |

### Director

- **Transcript**: `{who, text, at, source: bot|human}`. Bots' lines are
  appended when they *start speaking*; human `TextMessage`s from non-bot
  sessions in the channel are appended as they arrive.
- **Prompt** per turn: system = persona + topic + the other participants +
  rules (spoken register, 1–3 sentences, plain text, no lists/emoji/stage
  directions, never prefix your own name, react to the last speaker,
  sometimes address someone by name, stay in `language`). History = last ~30
  transcript lines, own lines as `assistant`, everyone else as `user`
  prefixed `Name:`. `temperature 0.9`, `max_tokens ~120`, stop on `\n\n`.
  Post-process: strip a leading `Name:`, quotes, markdown; if the line is
  near-duplicate of a recent one, regenerate hotter once.
- **Who speaks next**: never the last speaker; if the last line names a bot,
  that bot with p≈0.8; else weighted by time since they last spoke. A human
  line is answered by the bot it names, else a random one, and pre-empts the
  planned next turn.
- **Pipelining**: while bot A's audio plays, B's line is already generated
  and its TTS started; B starts on A's terminator + a pause of 300–900 ms
  (randomised). LLM (3090) and TTS (3060) run on different cards, so this
  hides LLM latency completely; only the first turn pays it.
- **Text pacing**: one `TextMessage` per utterance, posted on its own bot's
  connection when its audio starts — well under the 1/s bucket, and buckets
  are per connection anyway.
- **Steering**: a list of sub-topics generated at start; every ~8 turns the
  next prompt gets a nudge towards the next unexplored one so the talk moves.
- **End**: `--turns N` / `--minutes N` / SIGINT — finish the utterance in
  flight (terminator), each bot sends a short goodbye text (optional), then
  `AudioBot.stop()` for all.

### Latency budget per turn (expected)

LLM 27B Q4 on a 3090 ≈ 25–30 tok/s → a 60-token line ≈ 2–2.5 s (hidden by
pipelining). TTS first chunk ≈ 150–300 ms, then 3× real time. Opus encode via
ffmpeg is negligible. So the audible gap between speakers is the deliberate
pause plus ~0.3 s.

## 6. Model choices

- **LLM: [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B), released
  2026-08-13/14, on the 3090.** 27B dense, hybrid Gated-DeltaNet + gated
  attention (only every 4th layer has a KV cache, 4 KV heads — so long
  context is cheap in VRAM), 262k native context, thinking on by default and
  switched off with `enable_thinking: false` in the chat-template kwargs;
  recommended non-thinking sampling `temperature 0.7, top_p 0.8, top_k 20,
  presence_penalty 1.5`. BF16 is 55.6 GB and the official FP8 30.9 GB —
  neither fits a 24 GB card, so vLLM is out; we serve a **GGUF Q4_K_M
  (~17 GB, Unsloth's ladder) with `llama-server`**
  (`ghcr.io/ggml-org/llama.cpp:server-cuda`, `-ngl 99 -c 16384 -fa on
  --jinja --chat-template-kwargs '{"enable_thinking":false}'`), which is
  OpenAI-compatible so `llm.ts` is one client. Ollama has no `qwen3.8`
  library tag yet (community GGUFs run through its Hugging Face integration),
  so llama.cpp is the deterministic choice; the compose service is swappable
  for Ollama later without touching the bot. Expected speed on a 3090:
  memory-bound, ~25–30 tok/s → a 60-token line in ~2–2.5 s, hidden by
  pipelining except for the first turn. If we ever want a smaller/faster
  model, `LLM_MODEL`/GGUF path is a knob (e.g. IQ4_XS ~15 GB, or a small
  Qwen3.5 as a last resort).
- **TTS: the existing `qwen3-tts-server` (`:8882`), re-pinned to the 3060.**
  Its compose comment already said 3060; only the `device_ids` was wrong.
  Fixing that one line (in `~/learn-jp-speech/docker-compose.qwen.yml`, then a
  restart) both freed the 3090 for the 27B model and gave botroom a TTS on the
  3060 with no second instance and no second copy of the weights. `TTS_URL` points at
  `host.docker.internal:8882` from the bot container (or `127.0.0.1:8882` on
  the host). If we prefer isolation from the learn-jp stack later, a second
  instance sharing the `learn-jp-qwen_qwen-hf-cache` volume is a 10-line
  compose addition. Voices: up to 9 distinct presets, so up to ~7 English
  bots with a different voice each; beyond that, voices repeat with different
  `instruct` styles — and each preset's declared gender is matched to the
  persona's, because a woman's name in a man's voice is the one flaw nobody
  listens past. Kokoro (`:8881`) is the drop-in fallback through the same
  `TTS_URL` knob.

## 7. Deployment on nazuna

`botroom/docker-compose.yml` (sketch):

```yaml
name: botroom
services:
  llm:
    image: ghcr.io/ggml-org/llama.cpp:server-cuda
    command: >
      -m /models/Qwen3.8-27B-Q4_K_M.gguf -ngl 99 -c 16384 -fa on
      --jinja --chat-template-kwargs '{"enable_thinking":false}'
      --host 0.0.0.0 --port 8080
    volumes: [botroom-models:/models]
    ports: ["127.0.0.1:8090:8080"]
    deploy: { resources: { reservations: { devices:
      [{ driver: nvidia, device_ids: ["1"], capabilities: [gpu] }] } } }   # 3090
  botroom:
    build: { context: .., dockerfile: botroom/Dockerfile }   # node:22-slim + ffmpeg
    profiles: [run]
    depends_on: { llm: { condition: service_healthy } }
    extra_hosts: ["host.docker.internal:host-gateway"]
    environment:
      LLM_URL: http://llm:8080            # OpenAI-compatible
      TTS_URL: http://host.docker.internal:8882   # the learn-jp Qwen3-TTS, on the 3060 after re-pin
volumes:
  botroom-models: {}
```

Steps: `git pull` on nazuna → fetch the GGUF once into the models
volume (`huggingface-cli download unsloth/Qwen3.8-27B-GGUF Q4_K_M/…`, ~17 GB;
inside the 63 GB but check `df` first) → `docker compose up -d llm` (watch
`nvidia-smi`: the 3090 should show llama-server alone) →
`docker compose run --rm botroom --server … --topic … --participants 3`.
Dev loop without Docker: `. ~/.nvm/nvm.sh && npx tsx botroom/main.mts …`
with `LLM_URL=http://127.0.0.1:8090` and `TTS_URL=http://127.0.0.1:8882`.
Note the box's `render`-group/iGPU trap does not apply here (CUDA only,
`/dev/nvidia*` is world-rw).

## 8. What was built, and what it cost

All four milestones landed on 2026-08-17. `botroom/` is about 1,600 lines:
`main.mts` (wiring), `config.ts`, `personas.ts`, `llm.ts`, `tts.ts`,
`speech.ts`, `director.ts`, `util.ts`, `selftest.mts`, plus the Dockerfile and
compose. `src/util/audio-bot.ts` gained `sendText`, `speak()`, `onText`,
`onVoice`, `nameOf()` and an optional `BotSpec.source`.

**Verified on nazuna**, against a Starling started for the purpose on 64738:

| | |
|---|---|
| Ogg demuxing | `botroom/selftest.mts` — the incremental walk is byte-identical to `opus-source.ts`'s, fed in random-sized pieces |
| Streaming encode | first Opus frame 22–36 ms in, not 1172 ms (see below) |
| Real TTS | first frame 167 ms after asking, over the PCM-streaming endpoint |
| Model | Qwen3.8-27B Q4_K_M loads in llama.cpp's `server-cuda`, ~33 tok/s, 17.4 GB |
| Audio on the wire | a fourth client in the channel heard all three bots — 94 s of speech across 8 turns — and read every message |
| Pipelining | each line was ready 9–13 s before its turn came, so only turn one pays the model |

**Four things went wrong, and each is now a comment where it bit:**

1. **ffmpeg's input probe decides whether any of this streams**, not the Ogg
   muxer. The default probe is larger than a whole utterance, so ffmpeg held
   every frame until synthesis finished: first frame at 1172 ms of a 1201 ms
   run. `-probesize 4096` → 22 ms. `-analyzeduration 0` alone does nothing, and
   `-fflags +nobuffer` — which looks like it belongs — costs the first four
   frames of every utterance.
2. **Qwen3.8's chat template refuses a system message that is not first**
   (`raise_exception('System message must be at the beginning')`, HTTP 500).
   The steering nudge was appended after the history, which is the obvious
   place; it now folds into the leading system message.
3. **Starling's root channel is not called "Root"** — it is named after the
   instance — so asking for a channel by that name ends with a bot trying to
   create the channel it is already in. An empty room name now means "stay
   where the server put me".
4. **The model has to be told who just spoke.** Without it, bots addressed
   people who had not spoken and, twice, themselves ("Lena, honestly, ..." said
   by Lena). Speaker fairness also needed the silence weight squared.

**Added the same evening — the room got human, and got ears.** Every line
now comes back from the model as `{text, mood, heat}` (schema-constrained
decoding on llama-server): mood is fed to the synthesiser, heat is averaged
into a room temperature. Lines are spoken one sentence at a time
(`botroom/line.ts`), so a speaker can be cut off and resume where they were.
Heated rooms interrupt: the next speaker starts over the current one, both
stop, and a per-persona phrasebook (`phrases.ts`, generated at start-up in the
conversation's language) supplies the "sorry — go on" / "let me finish"; the
winner carries on. People in the channel are heard through the first bot's
tunnel: their Opus is wrapped as Ogg (`ogg.ts`) and sent to a Whisper on the
3060 (`humans.ts`; `stt` in the compose file), and answered. Talk over a bot
and it either stops for you or tells you to wait, by a per-person **standing**
that moves with behaviour. `heckler.mts` is a synthetic person for testing all
of it without a microphone.

What that cost to learn: the Qwen3-TTS server serialises generation *and*
finishes requests whose client has hung up, so speculative prefetching stalled
it for two minutes — synthesis is now a single prioritised lane on our side;
and Qwen3-TTS occasionally never emits its stop token (one 83-character
sentence became 88 seconds of audio), so every request has an audio budget
scaled to its text.

**And the clicking, later that night.** Three causes, found by recording what
a client actually receives (`listen.mts --record`) and decoding it: the TTS
PCM stream is *length-prefixed* and had been fed to the encoder raw — two
bogus samples every 320 ms; the Fancy client plays with exactly the lead the
sender gives it and the sender gave none (now `LEAD_FRAMES`, 120 ms ahead);
and cancelled requests kept generating on the upstream server, so after a
clash everything crawled — the "audio freaks out when it gets heated" report.
The mood hints were suspected and cleared (18/18 word-perfect through
Whisper). The server is now run patched (`botroom/patches/`), and replaces
the learn-jp instance rather than sharing the 3060 with it.

Still open, in order of value: voice cloning through the TTS server's `vc_*`
voices; the `CustomVoice` checkpoint, which actually follows the mood hint
(the Base model on the box mostly does not — mood lives in the words); the
UDP voice path, which botroom deliberately does not exercise (see the header
of `audio-bot.ts`).

## 9. What is still risky

- **Disk on nazuna** — 44 GB free after the 17 GB GGUF landed. Check `df`
  before pulling another model.
- **The 3090 is the model's alone now** — 20.5 GB of 24.6, with the 64k
  context that headroom bought. The two containers that were sharing it are on
  the 3060 (Qwen3-TTS) and stopped (kokoro-gpu), so anything else that wants
  that card — open-webui's Ollama, for one — has about 4 GB to work with while
  botroom's model is up.
- **Qwen3.8 is three days old.** llama.cpp loads it and the "unused tensor
  blk.64" warnings are its MTP head, which llama.cpp does not use — expected,
  not a corrupt download. But quant and runtime support this new can change
  under you; pin the image if a run matters.
- **Bot names must not collide with registered accounts** on the target server:
  a guest using a registered name is refused, and two same-named connections
  from one address replace each other silently. `--username-suffix` exists for
  this and defaults to `-bot`.
- **Channel permission**: joining needs `Enter`, creating needs a privileged
  account (`--admin`, the room keeper `scripts/audio-bots.mts` already uses).
  Without one the bots stay in the root, which is usually what you want anyway.
- Decisions worth revisiting: TypeScript on `AudioBot` rather than Rust on
  `mumble-protocol`; llama.cpp rather than Ollama or vLLM (forced — neither
  serves a 27B model in 24 GB without a GGUF); the bots share a transcript
  in-process rather than hearing each other, so they are deaf to human *speech*
  until the whisper path is built.
