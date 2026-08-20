# botroom

A room of LLM bots that hold a spoken conversation on a Mumble/Starling server.

The operator names a subject, a headcount and a server. The program invents that
many people, logs each of them in as its own Mumble client, and lets them talk —
out loud, as Opus speech, with feeling: every line comes with a mood the voice
follows and a heat the room feels. Heated rooms interrupt: two bots start at
once, both stop, and one says "sorry, go on" before the other carries on from
the sentence they were cut off in.

Anyone in the channel is a participant. Type, and the bots read it and answer.
*Talk*, and they notice: talk over one and it either stops for you or tells you
to wait, depending on the standing you have with the room; what you said comes
back through Whisper and gets answered. They do not post their own lines to the
chat unless you ask for that with `--text`.

```
npx tsx botroom/main.mts --server my.server:64738 --channel Lounge \
    --topic "whether cities should ban private cars" --participants 3
```

Design, model choices and the GPU layout: [`docs/BOTROOM-PLAN.md`](../docs/BOTROOM-PLAN.md).

## How it fits together

```
  director ──► llm.ts ──► llama-server        ({text, mood, heat}, in character)
      │                     Qwen3.8-27B
      │
      ├──► line.ts ──► tts.ts ──► qwen3-tts-server   (one request per sentence,
      │                  │                             24 kHz PCM, streaming)
      │             speech.ts ──► ffmpeg ──► 20 ms Opus frames
      │                                          │
      ├──────────────────────────► AudioBot ◄────┘  (one TLS connection per bot;
      │                              │               speech out, everyone's audio in)
      └──◄ humans.ts ◄── ogg.ts ◄────┘  (people's Opus → Ogg → Whisper → text)
```

The next speaker's line is generated and synthesised *while the current one is
still talking*, so only the first turn pays the full model latency. Lines are
spoken a sentence at a time, which is what lets a bot stop mid-line and pick up
where it was.

`AudioBot` is [`src/util/audio-bot.ts`](../src/util/audio-bot.ts) — the same
Mumble client the load-test fleet in `scripts/audio-bots.mts` uses, extended
here with text messages and a live-speech queue.

## Running it

Three things have to exist: a Mumble server, a chat-completions endpoint and a
speech endpoint. Any of them can be somewhere else; none of them has to be.

```sh
# 1. the pipeline on this machine, before blaming anything else
npx tsx botroom/selftest.mts --tts-url http://127.0.0.1:8882

# 2. text only — no GPU needed for speech, good for checking the model
npx tsx botroom/main.mts --topic "..." --participants 3 --mute --turns 6

# 3. no server at all: print the conversation
npx tsx botroom/main.mts --topic "..." --dry-run --turns 6

# 4. the real thing
npx tsx botroom/main.mts --server my.server:64738 --channel Lounge \
    --topic "..." --participants 4 --minutes 20 --transcript run.jsonl
```

To check that the room is actually audible to somebody else, sit in it:

```sh
npx tsx botroom/listen.mts --server 127.0.0.1:64738 --seconds 120 \
    --say "I drive a van for a living. What happens to me?" --say-after 45
```

It counts audio packets per speaker and prints every message it read, which is
a check on the *server's routing*, not on audio quality — nothing is decoded.
`--say` makes it the human in the room: the bots should drop whatever they had
prepared and answer it.

With text posting off by default, a listener reads no messages and only counts
audio; add `--text` to the bots if you want both.

To be the person who talks over them without a microphone, there is a heckler:

```sh
npx tsx botroom/heckler.mts --server 127.0.0.1:64738 --username Sebastian \
    --after 45 --say "Hang on. What about people who can't walk far?" \
    --gap 40 --say "Sorry, one more thing. Who pays for all this?"
```

It synthesises each `--say` and speaks it into the channel like any client
would, so the whole human path — noticing, yielding or complaining, transcribing,
answering — runs without anyone at a keyboard.

`--help` lists every flag. The useful ones beyond the above: `--seed N` to
replay a run exactly, `--personas file.json` to fix the cast, `--voices a,b,c`
to choose how they sound, `--no-interruptions` for a room that takes strict
turns however heated, `--no-stt` to run deaf, `--admin U --admin-pass-file F`
to have a privileged account create the channel (a guest usually may not), and
`--verbose` for room heat, timings and stage notes.

Endpoints come from flags, then the environment (`LLM_URL`, `LLM_MODEL`,
`TTS_URL`, `TTS_VOICES`, `STT_URL`, `BOT_ADMIN`, `BOT_ADMIN_PASS`), then `.env`
in the repository root.

## How the room treats people

Every person who speaks gets a **standing** with the room, 0 to 1, starting
somewhere in the middle and moving with behaviour. Speak into a gap and say
something intelligible: it goes up, and the bots answer. Talk over a bot: the
odds it stops for you ("oh — sorry, go ahead") follow your standing, tilted by
how heated the room is; otherwise it tells you to wait, and your standing
drops — more if you keep going, a little back if you stop. Above 0.5 you are
one of the conversation and what you say is answered even if somebody was
annoyed; below it, you are heard but not necessarily engaged with. Standing is
per name and survives a reconnect. `--verbose` prints every change.

## On the GPU box

```sh
docker compose -f botroom/docker-compose.yml up -d llm tts stt   # 3090 / 3060 / 3060
docker compose -f botroom/docker-compose.yml run --rm botroom \
    --server mumble.example.org:64738 --channel Lounge \
    --topic "..." --participants 3
```

The GGUF goes in `botroom/models/` (or set `BOTROOM_MODELS`). `stt` is Whisper
`large-v3-turbo` at int8 on the 3060, ~1.3 GB of VRAM and half a second per
utterance (the image defaults to float32, which is 4 GB for nothing). `tts` is
the same `qwen3-tts-server` image the learn-jp stack runs, sharing its cached
weights, with [`patches/qwen3-tts-server.py`](patches/qwen3-tts-server.py)
mounted over the server: upstream keeps generating for clients that hung up
and has no length bound, and both wrecked the room's audio (the patch header
says how). It **replaces** the learn-jp instance — they cannot share the 3060,
so stop `~/learn-jp-speech/docker-compose.qwen.yml` first, and start it again
when botroom's is down. Check the pins with `nvidia-smi` after `up`.

## Things that will bite

- **Bot names must be unique and unregistered.** They log in under their plain
  first names. Two connections from one address with the same name replace each
  other silently rather than being refused (`handshake.rs`, `may_replace`), and
  a name that belongs to a registered account is refused outright for a guest —
  `--username-suffix Bot` (or anything else) gets you out of a collision.
- **Text is rate limited to about one message a second per connection**, and a
  shed message is not reported. One line per turn is well inside that; do not
  add chatter.
- **Audio down the tunnel is not rate limited** and is a first-class path in
  Starling, not a degraded one. botroom never uses UDP, so it proves nothing
  about the voice socket.
- **ffmpeg's input probe decides whether any of this streams.** The default
  probe is larger than a whole utterance, so ffmpeg holds every frame until
  synthesis finishes and then flushes the lot — a second of silence in front of
  every sentence. `speech.ts` sets `-probesize 4096`; `selftest.mts` checks it.
- **Thinking must be off.** Qwen3.8 reasons by default and a conversational
  turn then takes seconds. `llm.ts` sends `enable_thinking: false` and strips
  `<think>` blocks; llama-server needs `--jinja` for the first half to work.
- **The synthesiser is one lane.** Qwen3-TTS serialises generation, so every
  speculative request costs everyone. `tts.ts` queues on our side — one in
  flight, ordered by urgency, cancellable while waiting — after a run where
  requests waited two minutes and timed out. `TTS_CONCURRENCY` raises it if
  your server can take it.
- **The PCM stream is framed.** Every chunk from `/v1/audio/speech/pcm-stream`
  carries a 4-byte length prefix and the stream ends with a zero frame. Feed
  it to the encoder as raw samples and you get a click every 320 ms under
  every sentence — which is what shipped for a day. `tts.ts` deframes it.
- **The receiver plays with the lead you give it.** The Fancy client primes on
  100 ms and then re-primes only after 1.5 s of silence; a sender that paces
  at exactly real time leaves every spurt after a shorter pause with zero lead,
  and every 10 ms callback comes up short — a click train. `AudioBot` runs up
  to 120 ms ahead of real time whenever it has frames (`LEAD_FRAMES`).
  `listen.mts --record DIR` measures the lead a client actually gets.
- **A cancelled request kept generating on the upstream server**, half-speed
  for it and for whoever came next; and once in a few hundred sentences the
  model babbles for minutes. Both are why the patched server exists.
- **A system message that is not first is a 500** on Qwen3.8's chat template.
  Every instruction, including the steering nudges, is folded into the leading
  one.
- **Mood mostly lives in the words.** The Qwen3-TTS *Base* model on the box
  only loosely follows the `instruct` hint (its own logs say so). The
  `CustomVoice` checkpoint follows it properly; point `TTS_URL` at one to hear
  the moods rather than infer them.
