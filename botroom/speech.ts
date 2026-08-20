/**
 * Synthesised speech to Mumble audio frames, without waiting for the sentence
 * to finish.
 *
 * `src/util/opus-source.ts` does the same job for the load bots, but in one
 * shot: run ffmpeg to completion, walk the Ogg pages, hand back an array. A
 * talking bot cannot wait for that — the point of the streaming TTS endpoint is
 * that the first syllable is on the wire while the last one is still being
 * generated. So ffmpeg is fed and drained at the same time, and the Ogg page
 * walk becomes incremental.
 *
 * # Why ffmpeg is still the encoder
 *
 * Same reason as `opus-source.ts`: every Node Opus binding is either a native
 * module with a toolchain behind it or a multi-megabyte WASM blob, and ffmpeg
 * is already a precondition of this repo's media work. It also resamples
 * whatever the TTS emits — 24 kHz here — to the 48 kHz Mumble insists on.
 *
 * # The flag that matters
 *
 * `-page_duration 20000` (microseconds) tells the Ogg muxer to close a page
 * every 20 ms. Without it ffmpeg fills pages of about a second before writing
 * anything, which puts a second of latency in front of every utterance and
 * makes the streaming endpoint pointless. `-flush_packets 1` stops the I/O
 * layer adding its own buffer on top.
 */

import { spawn } from "node:child_process";

import { AsyncQueue } from "./util";
import type { Speech } from "./tts";

/** `E2E_FFMPEG` first, then `PATH` — the convention `opus-source.ts` set. */
const FFMPEG = process.env.E2E_FFMPEG ?? "ffmpeg";

export interface EncodeOptions {
  /** Opus frame duration in ms; 10, 20, 40 or 60. */
  frameMs: number;
  bitrateKbps: number;
  /**
   * Stop after this many frames, whatever the synthesiser is still sending.
   *
   * Qwen3-TTS occasionally fails to emit its end token and babbles until it
   * hits the model's own ceiling: one 83-character sentence came back as 88
   * seconds of audio, with everything else queued behind it. A budget scaled
   * to the text — the caller knows how long a sentence *should* take — turns
   * that into a clipped sentence instead of a stalled room.
   */
  maxFrames?: number;
}

/**
 * Encode one utterance, yielding Opus packets as ffmpeg produces them.
 *
 * The stream ends when ffmpeg exits; a non-zero exit throws into the consumer
 * with ffmpeg's own diagnostics attached, because "the bot went quiet" is
 * otherwise indistinguishable from a server problem.
 */
export function opusFrames(speech: Speech, opts: EncodeOptions): AsyncIterable<Buffer> {
  const input =
    speech.kind === "pcm"
      ? ["-f", "s16le", "-ar", String(speech.sampleRate), "-ac", String(speech.channels)]
      : [];
  // **This is the flag that decides whether any of this streams.** ffmpeg
  // probes an input before it will emit anything, and the default probe is 5 MB
  // or 5 seconds — more than a whole utterance of 24 kHz mono, so the default
  // holds every frame back until the synthesiser has finished and then flushes
  // the lot. Measured on this repo's ffmpeg: first frame at 1172 ms of a
  // 1201 ms run by default, 22 ms with a small probe. `-analyzeduration 0`
  // alone does nothing; it is the byte budget that matters.
  //
  // `-fflags +nobuffer` looks like it belongs here and does not: it costs four
  // frames of the front of every utterance (147 of 151), which is a clipped
  // first syllable in every sentence a bot says.
  const probe = ["-probesize", "4096", "-analyzeduration", "0"];

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...probe,
    ...input,
    "-i",
    "pipe:0",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    `${opts.bitrateKbps}k`,
    "-vbr",
    "off",
    "-application",
    "voip",
    "-frame_duration",
    String(opts.frameMs),
    "-page_duration",
    "20000",
    "-flush_packets",
    "1",
    "-f",
    "ogg",
    "pipe:1",
  ];

  const proc = spawn(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
  // The consumer walking away is the interrupted-speaker case. Everything
  // upstream stops with it: the encoder, and the synthesis request behind it,
  // which would otherwise carry on producing audio for nobody on a GPU that
  // another bot is waiting for.
  const queue = new AsyncQueue<Buffer>(() => {
    speech.cancel();
    proc.kill("SIGKILL");
  });
  const demuxer = new OggDemuxer();
  const errors: string[] = [];

  // OpusHead and OpusTags come first and are metadata, not audio. Sending them
  // as frames puts two packets of header into the call before the first sample.
  let preamble = 2;
  let emitted = 0;

  proc.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const packet of demuxer.push(chunk)) {
        if (preamble > 0) {
          preamble -= 1;
          continue;
        }
        queue.push(packet);
        emitted += 1;
        if (opts.maxFrames !== undefined && emitted >= opts.maxFrames) {
          // Over budget: end the utterance here, cleanly, and stop the source.
          queue.close();
          speech.cancel();
          proc.kill("SIGKILL");
          return;
        }
      }
    } catch (e) {
      queue.fail(e);
      proc.kill("SIGKILL");
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => errors.push(String(chunk)));
  proc.once("error", (e: Error) =>
    queue.fail(
      new Error(
        `could not run ${FFMPEG}: ${e.message}. Set E2E_FFMPEG to an ffmpeg built with libopus.`,
      ),
    ),
  );
  proc.once("close", (code) => {
    if (code === 0) queue.close();
    else queue.fail(new Error(`${FFMPEG} exited ${code}: ${errors.join("").trim()}`));
  });

  void feed(proc.stdin, speech.chunks).catch((e: unknown) => queue.fail(e));
  return queue;
}

/**
 * Write the synthesiser's output into ffmpeg, respecting backpressure.
 *
 * `EPIPE` is swallowed: it means ffmpeg has already gone, and the reason it
 * went is on its way through the `close` handler, which is a better error than
 * "write after end".
 */
async function feed(stdin: import("node:stream").Writable, chunks: AsyncIterable<Buffer>): Promise<void> {
  stdin.on("error", () => undefined);
  try {
    for await (const chunk of chunks) {
      if (stdin.writableEnded) return;
      if (!stdin.write(chunk)) {
        await new Promise<void>((resolve) => stdin.once("drain", resolve));
      }
    }
  } finally {
    if (!stdin.writableEnded) stdin.end();
  }
}

/**
 * An Ogg page walk that survives being handed half a page.
 *
 * A packet is the concatenation of consecutive segments up to and including the
 * first one shorter than 255 bytes, and it may run past the end of a page —
 * hence the carry, which lives across `push` calls as well as across pages.
 * Granule positions, the CRC and the stream serial are all ignored: ffmpeg
 * produced these bytes a moment ago on the other end of a pipe, and this is not
 * a trust boundary.
 */
export class OggDemuxer {
  private buffered: Buffer = Buffer.alloc(0);
  private carry: Buffer[] = [];

  push(chunk: Buffer): Buffer[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const packets: Buffer[] = [];
    let at = 0;

    while (at + 27 <= this.buffered.length) {
      if (this.buffered.toString("latin1", at, at + 4) !== "OggS") {
        throw new Error(`malformed Ogg from ffmpeg: no page header at byte ${at}`);
      }
      const segments = this.buffered[at + 26];
      const table = at + 27;
      const body = table + segments;
      if (body > this.buffered.length) break;

      let bodyLength = 0;
      for (let i = 0; i < segments; i++) bodyLength += this.buffered[table + i];
      if (body + bodyLength > this.buffered.length) break;

      let cursor = body;
      for (let i = 0; i < segments; i++) {
        const length = this.buffered[table + i];
        this.carry.push(this.buffered.subarray(cursor, cursor + length));
        cursor += length;
        // Anything shorter than 255 ends the packet; a run of 255s means it
        // continues, possibly onto the next page — or into the next chunk.
        if (length < 255) {
          packets.push(Buffer.concat(this.carry));
          this.carry = [];
        }
      }
      at = cursor;
    }

    if (at > 0) this.buffered = Buffer.from(this.buffered.subarray(at));
    return packets;
  }
}
