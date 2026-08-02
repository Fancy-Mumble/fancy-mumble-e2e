import { readFileSync } from "node:fs";

/**
 * Comparing what a listener heard against what was spoken.
 *
 * # Why not a sample-by-sample comparison
 *
 * Nothing about the received signal is sample-aligned with the source. Opus is
 * lossy and phase-inexact, the encoder and decoder each add delay, the jitter
 * buffer adds a variable amount more, a resampler may have run at both ends, and
 * the far end started listening somewhere in the middle of a looping fixture. A
 * waveform difference would be enormous for audio that sounds perfect.
 *
 * # What is compared instead
 *
 * The **short-term energy envelope** — the shape of the loudness over time. That
 * is what carries the rhythm of speech: syllables, pauses between sentences, the
 * attack of a plosive. It survives everything in the list above and is destroyed
 * by the things that actually matter: a gate that clips onsets, a codec dropping
 * frames, concealment filling a gap with silence, a denoiser eating quiet
 * consonants.
 *
 * It is also the metric a tone cannot satisfy in any meaningful way. A sine has
 * a flat envelope, so it correlates with *any* other flat envelope — which is
 * precisely why the existing tone-ratio suite cannot tell working speech from
 * broken speech.
 */

/** Envelope frame length. 20 ms is about one phoneme — fine enough to see a
 * syllable, coarse enough to be immune to codec phase. */
const FRAME_MS = 20;

/** A decoded mono signal and the rate it was sampled at. */
export interface Signal {
  samples: Float32Array;
  rate: number;
}

/** Read a mono/stereo 16-bit or 32-bit-float PCM WAV into mono samples. */
export function readWav(path: string): Signal {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }

  let at = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, at + 8 + size);
    if (id === "fmt ") {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        rate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === "data") {
      data = body;
    }
    // Chunks are word-aligned; an odd size is followed by a pad byte.
    at += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path} has no fmt/data chunk`);

  const channels = Math.max(1, fmt.channels);
  const out: number[] = [];
  if (fmt.format === 3 && fmt.bits === 32) {
    for (let i = 0; i + 4 * channels <= data.length; i += 4 * channels) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += data.readFloatLE(i + 4 * c);
      out.push(sum / channels);
    }
  } else if (fmt.bits === 16) {
    for (let i = 0; i + 2 * channels <= data.length; i += 2 * channels) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += data.readInt16LE(i + 2 * c) / 32768;
      out.push(sum / channels);
    }
  } else {
    throw new Error(`${path}: unsupported format ${fmt.format} @ ${fmt.bits} bits`);
  }
  return { samples: Float32Array.from(out), rate: fmt.rate };
}

/**
 * Per-frame RMS energy, in dB relative to full scale.
 *
 * dB rather than linear because speech dynamics are logarithmic: in linear
 * terms a quiet consonant is a rounding error next to a vowel, so a correlation
 * would be dominated by the loudest few frames and would barely move if every
 * quiet sound vanished.
 */
export function envelope(signal: Signal): Float32Array {
  const frame = Math.max(1, Math.round((signal.rate * FRAME_MS) / 1000));
  const count = Math.floor(signal.samples.length / frame);
  const out = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += signal.samples[i]! ** 2;
    const rms = Math.sqrt(sum / frame);
    // Floored well below anything audible so digital silence does not become
    // -Infinity and poison the correlation.
    out[f] = 20 * Math.log10(Math.max(rms, 1e-6));
  }
  return out;
}

function pearson(a: readonly number[] | Float32Array, b: readonly number[] | Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** What the comparison found. */
export interface Fidelity {
  /** Best envelope correlation over all alignments, in `[-1, 1]`. */
  correlation: number;
  /** Where the received audio best lines up with the source, in frames. */
  lagFrames: number;
  /** Fraction of received frames that are essentially silent. */
  receivedSilenceRatio: number;
  /** The same for the source, for comparison. */
  sourceSilenceRatio: number;
  /**
   * Longest run where the far end is silent **while the source was speaking**,
   * in milliseconds — the one number here that is unambiguously a defect.
   *
   * Measured after alignment, so it is a claim about the same moment in the
   * speech rather than about two clocks. Silence during a pause does not count
   * however long it runs: that is a gate, not a dropout.
   */
  longestDropoutMs: number;
  /** Longest run of silence in the received audio, in milliseconds. */
  longestGapMs: number;
  /**
   * The same for the source — the number the one above has to be judged
   * against.
   *
   * Real speech contains pauses, and this fixture's are around a second. An
   * absolute gap threshold would therefore fail on healthy audio and tell the
   * reader nothing; what matters is whether the far end grew a gap the speaker
   * did not have.
   */
  sourceLongestGapMs: number;
}

/** Longest run of frames below the silence floor, in milliseconds. */
function longestGap(env: Float32Array): number {
  let longest = 0;
  let run = 0;
  for (const v of env) {
    run = v < SILENCE_DBFS ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest * FRAME_MS;
}

/** Frames quieter than this are treated as silence. */
const SILENCE_DBFS = -50;

/**
 * Above this, the source is unambiguously being spoken into rather than idling.
 *
 * The gap between this and [`SILENCE_DBFS`] is deliberate, and a real recording
 * is what showed why it has to exist. Room tone in the Open Speech Repository
 * fixture sits around -44 dBFS: quieter than speech, louder than digital
 * silence. A noise gate is *supposed* to close over it, so the far end is far
 * more silent than the source — 38% against 3% on a healthy run.
 *
 * Judging that as a fault would be testing the absence of a noise gate. What is
 * actually a fault is silence at the far end while the speaker was audibly
 * talking, and that is what the band between these two constants isolates.
 */
const SPEECH_DBFS = -30;

/**
 * Compare received audio against the source that produced it.
 *
 * The source is looped by the virtual microphone and the receiver joins late,
 * so alignment is searched rather than assumed: the source envelope is tiled to
 * at least the received length, and every offset is tried. The best correlation
 * is the answer, which makes the metric independent of when recording started.
 */
export function compare(source: Signal, received: Signal): Fidelity {
  const src = envelope(source);
  const got = envelope(received);
  if (got.length < 8 || src.length < 8) {
    return {
      correlation: 0,
      lagFrames: 0,
      receivedSilenceRatio: 1,
      sourceSilenceRatio: 0,
      longestDropoutMs: 0,
      longestGapMs: 0,
      sourceLongestGapMs: 0,
    };
  }

  // Tile the source so a window of the received length can start anywhere in
  // one loop of it.
  const tiled = new Float32Array(src.length + got.length);
  for (let i = 0; i < tiled.length; i++) tiled[i] = src[i % src.length]!;

  let best = -1;
  let bestLag = 0;
  for (let lag = 0; lag < src.length; lag++) {
    const window = tiled.subarray(lag, lag + got.length);
    const r = pearson(window, got);
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }

  const quiet = (e: Float32Array) => e.reduce((n, v) => n + (v < SILENCE_DBFS ? 1 : 0), 0) / e.length;

  // Silence at the far end while the source was audibly speaking, at the
  // alignment that matched best.
  let dropout = 0;
  let run = 0;
  for (let i = 0; i < got.length; i++) {
    const spoken = tiled[bestLag + i]!;
    run = got[i]! < SILENCE_DBFS && spoken > SPEECH_DBFS ? run + 1 : 0;
    dropout = Math.max(dropout, run);
  }

  return {
    correlation: best,
    lagFrames: bestLag,
    receivedSilenceRatio: quiet(got),
    sourceSilenceRatio: quiet(src),
    longestDropoutMs: dropout * FRAME_MS,
    longestGapMs: longestGap(got),
    sourceLongestGapMs: longestGap(src),
  };
}
