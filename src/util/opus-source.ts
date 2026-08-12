/**
 * Opus frames for the audio bots, produced by ffmpeg.
 *
 * # Why ffmpeg and not an Opus binding
 *
 * A bot has to put *Opus packets* on the wire, one per frame, and every Node
 * Opus binding is either a native module with a compiler toolchain behind it or
 * a WASM build several megabytes wide. ffmpeg is already a precondition of this
 * repo's media work and encodes Opus with libopus at an exact frame duration,
 * so the only thing missing is a way to get the packets back out of it — which
 * is the Ogg page walk below, about forty lines and no dependency.
 *
 * # Why Ogg
 *
 * ffmpeg will not write raw Opus packets; every container it can write either
 * frames them (Ogg, WebM) or cannot hold them at all. Ogg is the one whose
 * framing is trivial to undo: a page carries a segment table, and a packet ends
 * at the first segment shorter than 255 bytes. Nothing else about Ogg matters
 * here — the granule positions, the CRC and the stream serial are all ignored,
 * because ffmpeg produced the file a moment ago and it is not a trust boundary.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..", "..");

/**
 * The ffmpeg to shell out to.
 *
 * `E2E_FFMPEG` first, then whatever is on `PATH`. Named rather than discovered
 * so a machine with several ffmpeg builds — which is the normal state of a
 * media developer's machine — gets a run that fails loudly on the wrong one
 * instead of silently encoding with a build that has no libopus.
 */
const FFMPEG = process.env.E2E_FFMPEG ?? "ffmpeg";

/** Where a bot's audio comes from. */
export type SourceSpec =
  /**
   * A media file on disk, decoded and resampled to 48 kHz mono.
   *
   * `seconds` caps how much is taken. Worth setting for anything long: the
   * encode happens up front, so an uncapped two-hour mix is two hours of
   * ffmpeg before the bot says a word, which reads as a hung connect.
   */
  | { kind: "file"; path: string; seconds?: number }
  /**
   * An ffmpeg `lavfi` graph, for sound that needs no asset — a melody, a
   * chord, noise. The string is a filter description, not a shell command;
   * it is passed as one argv element and never goes through a shell.
   */
  | { kind: "lavfi"; filter: string; seconds: number };

/** A decoded, encoded, ready-to-send stream of Opus packets. */
export interface OpusStream {
  /** One Opus packet per frame, in order. */
  packets: Buffer[];
  /** Frame duration in milliseconds; every packet carries exactly this much. */
  frameMs: number;
  /** What produced it, for logging. */
  label: string;
}

/**
 * Encode `spec` to Opus and return its packets.
 *
 * Mono 48 kHz throughout: Mumble's wire format is 48 kHz, and a bot that sent
 * anything else would be exercising the server's tolerance for a malformed
 * stream rather than its audio path.
 */
export async function encodeToOpus(
  spec: SourceSpec,
  frameMs: number,
  bitrateKbps = 48,
): Promise<OpusStream> {
  const input =
    spec.kind === "file"
      ? ["-i", spec.path]
      : ["-f", "lavfi", "-t", String(spec.seconds), "-i", spec.filter];

  if (spec.kind === "file" && !existsSync(spec.path)) {
    throw new Error(`audio source not found: ${spec.path}`);
  }

  // For a file this is an *output* option, so it truncates after decoding
  // rather than seeking; for lavfi the duration is already an input option.
  const cap = spec.kind === "file" && spec.seconds ? ["-t", String(spec.seconds)] : [];

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...input,
    ...cap,
    "-ac", "1",
    "-ar", "48000",
    "-c:a", "libopus",
    "-b:a", `${bitrateKbps}k`,
    // The whole point of the exercise: one packet per `frameMs`, so the
    // sequence numbers the bot writes match the audio it is sending.
    "-frame_duration", String(frameMs),
    // VBR would make packet sizes vary with content, which is realistic but
    // makes a bandwidth assertion at the far end untestable. Constant bitrate
    // keeps "what should the server have seen" arithmetic.
    "-vbr", "off",
    "-f", "ogg",
    "pipe:1",
  ];

  const ogg = await run(FFMPEG, args);
  const packets = oggPackets(ogg);

  // OpusHead and OpusTags are Ogg's own preamble, not audio. Sending them as
  // frames would put two packets of metadata into the call before the first
  // sample, which a decoder answers with a glitch or a dropped stream.
  const audio = packets.slice(2);
  if (audio.length === 0) {
    throw new Error(`ffmpeg produced no Opus packets for ${describe(spec)}`);
  }
  return { packets: audio, frameMs, label: describe(spec) };
}

/** A short human name for a source, for logs. */
export function describe(spec: SourceSpec): string {
  return spec.kind === "file" ? path.basename(spec.path) : spec.filter.slice(0, 40);
}

/** The speech fixture this repo already ships, for the "voice" bots. */
export function speechFixture(): string {
  return path.join(repoRoot, "fixtures", "audio", "speech.wav");
}

// ---------------------------------------------------------------------------

/** Run a command and return its stdout, failing loudly on a non-zero exit. */
function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: string[] = [];
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => err.push(String(c)));
    proc.once("error", (e) =>
      reject(
        new Error(
          `could not run ${cmd}: ${e.message}. Set E2E_FFMPEG to an ffmpeg ` +
            `built with libopus.`,
        ),
      ),
    );
    proc.once("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(new Error(`${cmd} exited ${code}: ${err.join("").trim()}`));
    });
  });
}

/**
 * Every packet in an Ogg stream, in order.
 *
 * A packet is the concatenation of consecutive segments up to and including the
 * first one shorter than 255 bytes, and it may run past the end of a page —
 * hence the carry across iterations rather than a per-page reset.
 */
function oggPackets(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let carry: Buffer[] = [];
  let at = 0;

  while (at + 27 <= data.length) {
    if (data.toString("latin1", at, at + 4) !== "OggS") {
      throw new Error(`malformed Ogg: no page header at byte ${at}`);
    }
    const segments = data[at + 26];
    const table = at + 27;
    const body = table + segments;
    if (body > data.length) break;

    let cursor = body;
    for (let i = 0; i < segments; i++) {
      const len = data[table + i];
      carry.push(data.subarray(cursor, cursor + len));
      cursor += len;
      // Anything shorter than 255 terminates the packet; a run of 255s means
      // it continues, possibly onto the next page.
      if (len < 255) {
        packets.push(Buffer.concat(carry));
        carry = [];
      }
    }
    at = cursor;
  }
  return packets;
}
