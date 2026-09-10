/**
 * A gated tone fixture: the signal a ring can actually be measured on.
 *
 * # Why neither existing signal works
 *
 * The playout ring is the resume ramp failing to reach unity gain on a shallow
 * buffer, so it only happens where the buffer re-primes - at the start of a
 * talkspurt. Measuring it needs a signal with two properties at once, and the
 * suite's two signals each have exactly one:
 *
 * * `voice-latency`'s click train rides a **continuous** 440 Hz carrier, which
 *   is clean to measure but holds the noise gate and the jitter buffer open.
 *   The buffer never drains, the ramp never runs, and nothing rings: recordings
 *   at a 20 ms and a 5 ms mix chunk come back identical to within 1-2 dB across
 *   60 Hz - 1.2 kHz.
 * * `voice-fidelity`'s speech fixture **has** onsets, but a voice carries its
 *   own periodicity. Its glottal rate lands near 100 Hz and rectification puts
 *   a strong component at 200 Hz - which is also the 5 ms chunk rate, so an
 *   envelope detector scores the talker and calls it a defect. The source
 *   fixture, which has never been near a mix chunk, reads 15.0 dB at 200 Hz on
 *   that metric.
 *
 * # What this is
 *
 * Bursts of a pure tone separated by silence: onsets, so the buffer drains and
 * primes and ramps repeatedly, on a carrier with no periodicity of its own for
 * a detector to mistake for modulation. Gain modulation at the chunk rate then
 * appears as sidebands at `carrier ± rate` in otherwise empty spectrum.
 *
 * The gaps are long enough for the buffer to actually drain and the bursts long
 * enough to measure several modulation cycles inside one.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GATED_RATE = 48_000;
export const GATED_CARRIER_HZ = 440;
/** Burst and gap, in milliseconds. */
const BURST_MS = 600;
const GAP_MS = 400;
/** Whole file, looped by the virtual mic. */
const TOTAL_MS = 10_000;

/**
 * Write the fixture if it is not already there, and return its path.
 *
 * Deterministic, so a rebuild does not change what a comparison was measured
 * against.
 */
export function ensureGatedTone(): string {
  const dir = path.join(repoRoot, "fixtures", "audio");
  const file = path.join(dir, "gated-tone-48k.wav");
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });

  const n = Math.round((GATED_RATE * TOTAL_MS) / 1000);
  const burst = Math.round((GATED_RATE * BURST_MS) / 1000);
  const gap = Math.round((GATED_RATE * GAP_MS) / 1000);
  const period = burst + gap;
  // A short fade on each end of a burst, so the *source* has no click of its
  // own: an abrupt gate would put broadband energy at every onset, which is
  // the one place the measurement looks.
  const fade = Math.round(GATED_RATE * 0.005);

  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const inPeriod = i % period;
    let a = 0;
    if (inPeriod < burst) {
      a = 0.5;
      if (inPeriod < fade) a *= inPeriod / fade;
      else if (inPeriod > burst - fade) a *= (burst - inPeriod) / fade;
    }
    const s = a * Math.sin((2 * Math.PI * GATED_CARRIER_HZ * i) / GATED_RATE);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(GATED_RATE, 24);
  header.writeUInt32LE(GATED_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([header, pcm]));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  console.log(ensureGatedTone());
}
