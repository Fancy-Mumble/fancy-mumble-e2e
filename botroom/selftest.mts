/**
 * Check the audio pipeline on this machine, without a server or a GPU.
 *
 *   npx tsx botroom/selftest.mts            # ffmpeg only
 *   npx tsx botroom/selftest.mts --tts-url http://127.0.0.1:8882
 *
 * Two things here are environment-dependent enough to be worth proving before
 * blaming the server:
 *
 * 1. **The incremental Ogg walk.** `speech.ts` parses pages out of a pipe as
 *    they arrive, where `src/util/opus-source.ts` parses a finished file. This
 *    runs both over the same bytes — the incremental one fed in awkward,
 *    randomly sized pieces — and insists they agree packet for packet.
 * 2. **Whether ffmpeg actually streams.** The Ogg muxer buffers about a second
 *    of audio into a page unless `-page_duration` is honoured, and a build that
 *    ignores it turns every utterance into a second of silence followed by a
 *    burst. That shows up here as a first-packet time near the end of the run
 *    rather than near the start.
 */

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { opusFrames, OggDemuxer } from "./speech";
import { TtsClient, type Speech } from "./tts";
import { AsyncQueue, delay } from "./util";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const FRAME_MS = 20;
const SECONDS = 3;
const RATE = 24_000;

let failures = 0;
const check = (ok: boolean, what: string, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/** A tone, delivered the way a synthesiser delivers: in pieces, over time. */
function tone(seconds: number, chunkMs = 120, gapMs = 40): AsyncIterable<Buffer> {
  const queue = new AsyncQueue<Buffer>();
  void (async () => {
    const samplesPerChunk = Math.round((RATE * chunkMs) / 1000);
    const total = Math.round(RATE * seconds);
    for (let at = 0; at < total; at += samplesPerChunk) {
      const count = Math.min(samplesPerChunk, total - at);
      const chunk = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) {
        const value = Math.sin((2 * Math.PI * 220 * (at + i)) / RATE) * 12000;
        chunk.writeInt16LE(Math.round(value), i * 2);
      }
      queue.push(chunk);
      await delay(gapMs);
    }
    queue.close();
  })();
  return queue;
}

console.log("botroom selftest\n");

// -- 1. the incremental page walk agrees with the reference one -------------

console.log("ogg demuxer");
{
  const { encodeToOpus } = await import("../src/util/opus-source");
  const reference = await encodeToOpus(
    { kind: "lavfi", filter: "sine=frequency=440", seconds: 2 },
    FRAME_MS,
    32,
  );

  // The same encode again, this time reading the container ourselves.
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawnFfmpeg();
    const out: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    proc.once("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`)),
    );
  });

  const demuxer = new OggDemuxer();
  const packets: Buffer[] = [];
  // Awkward on purpose: a page header split across two chunks is exactly the
  // case a whole-file parser never sees.
  for (let at = 0; at < raw.length; ) {
    const size = 1 + Math.floor(Math.random() * 997);
    packets.push(...demuxer.push(raw.subarray(at, at + size)));
    at += size;
  }

  const audio = packets.slice(2); // OpusHead, OpusTags
  check(
    audio.length === reference.packets.length,
    "packet count matches the reference walk",
    `${audio.length} vs ${reference.packets.length}`,
  );
  const identical = audio.every(
    (packet, i) => reference.packets[i] !== undefined && packet.equals(reference.packets[i]),
  );
  check(identical, "every packet is byte-identical");
}

// -- 2. frames come out while the input is still arriving -------------------

console.log("\nstreaming encode");
{
  const started = performance.now();
  let first: number | null = null;
  let count = 0;
  let bytes = 0;

  const speech: Speech = {
    kind: "pcm",
    sampleRate: RATE,
    channels: 1,
    chunks: tone(SECONDS),
    cancel: () => undefined,
  };
  for await (const packet of opusFrames(speech, { frameMs: FRAME_MS, bitrateKbps: 32 })) {
    first ??= performance.now() - started;
    count += 1;
    bytes += packet.length;
  }
  const elapsed = performance.now() - started;
  const expected = (SECONDS * 1000) / FRAME_MS;

  check(
    Math.abs(count - expected) <= 2,
    `${SECONDS}s of audio is ${count} frames of ${FRAME_MS}ms`,
    `expected about ${expected}`,
  );
  check(bytes > 0 && count > 0, "frames are not empty", `${(bytes / count).toFixed(0)} bytes each`);
  // The producer takes about 1 s of wall clock for 3 s of audio, so a first
  // frame at the very end means ffmpeg buffered the lot.
  check(
    first !== null && first < elapsed * 0.6,
    "the first frame arrives long before the last",
    `first at ${first?.toFixed(0)}ms of ${elapsed.toFixed(0)}ms`,
  );
}

// -- 3. the synthesiser, if one was named -----------------------------------

const ttsUrl = flag("tts-url") ?? process.env.TTS_URL;
if (ttsUrl !== undefined) {
  console.log(`\nspeech endpoint at ${ttsUrl}`);
  const tts = new TtsClient({ url: ttsUrl, model: "tts-1", language: "English" });
  try {
    const voices = await tts.voices();
    check(voices.length > 0, "it offers voices", voices.map((voice) => voice.id).join(", "));

    const started = performance.now();
    const speech = await tts.speak(
      "This is a test of the botroom speech path. If you can hear this, the pipeline works.",
      { voice: voices[0]?.id ?? "ryan" },
    );
    const openedAt = performance.now() - started;
    check(true, `synthesis started`, `${speech.kind}, headers in ${openedAt.toFixed(0)}ms`);

    let first: number | null = null;
    let frames = 0;
    for await (const _packet of opusFrames(speech, { frameMs: FRAME_MS, bitrateKbps: 32 })) {
      first ??= performance.now() - started;
      frames += 1;
    }
    check(frames > 20, "it produced speech", `${frames} frames = ${(frames * FRAME_MS) / 1000}s`);
    check(
      first !== null && first < 3000,
      "the first frame is quick enough for conversation",
      `${first?.toFixed(0)}ms`,
    );
    check(tts.isStreaming, "the low-latency PCM endpoint was used");
  } catch (e) {
    check(false, "speech endpoint", (e as Error).message);
  }
}

console.log(`\n${failures === 0 ? "all good" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);

function spawnFfmpeg() {
  return spawn(
    process.env.E2E_FFMPEG ?? "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-t", "2", "-i", "sine=frequency=440",
      "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k",
      "-frame_duration", String(FRAME_MS), "-vbr", "off", "-f", "ogg", "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}
