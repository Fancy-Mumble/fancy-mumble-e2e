import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";
import { ensureGatedTone, GATED_RATE, GATED_CARRIER_HZ } from "../../scripts/make-gated-tone.mts";
import { readWav } from "../util/audio-fidelity";
import { chunkModulation } from "../util/audio-modulation";

/**
 * Does the playout path ring at the start of a talkspurt?
 *
 * # The defect
 *
 * The mixer's underrun back-off and resume ramp are absolute sample counts. A
 * mix chunk short enough to be covered by a ramp never reaches unity gain
 * between refills, so playout is multiplied by a gain that repeats once per
 * chunk. That is amplitude modulation, and it is heard as a metallic ring. It
 * shipped once, as a 5 ms chunk, and was reverted after somebody heard it -
 * with the whole suite passing it unchanged.
 *
 * # Why this needs its own signal
 *
 * The ring only happens where the buffer re-primes, which is at the start of a
 * talkspurt, and measuring it needs onsets *and* a carrier clean enough to see
 * sidebands on. Neither existing signal has both, and both were tried:
 *
 * * `voice-latency`'s click train rides a continuous carrier that holds the
 *   gate and the buffer open, so the ramp never runs. Recordings at 20 ms and
 *   at 5 ms are identical to within 1-2 dB from 60 Hz to 1.2 kHz - the defect
 *   is not in them to find.
 * * `voice-fidelity`'s speech has onsets, but a voice is itself periodic: this
 *   fixture's glottal rate puts a strong 200 Hz component in the rectified
 *   envelope, which is also the 5 ms chunk rate. An envelope detector scores
 *   the talker. The source fixture reads 15.0 dB on that metric without ever
 *   having been near a mix chunk.
 *
 * So this drives a gated tone: bursts with silence between them, so the buffer
 * drains and primes and ramps repeatedly, on a carrier with no periodicity of
 * its own. See `scripts/make-gated-tone.mts`.
 *
 * # What this does NOT do, measured rather than assumed
 *
 * **It does not currently distinguish the 5 ms chunk from the 20 ms one.** Run
 * against both on a loopback rig, probed at the same frequency, they come back
 * the same to within half a decibel:
 *
 * | build | at 50 Hz | at 200 Hz | swing at 200 Hz |
 * | --- | --- | --- | --- |
 * | 20 ms (current) | -0.9 dB | 12.4 dB | 1.17% |
 * | 5 ms (reverted, rings audibly) | 1.0 dB | 12.9 dB | 1.37% |
 *
 * The 200 Hz component is in *both* builds because 200 Hz is the underrun
 * back-off period (`UNDERRUN_BACKOFF_SAMPLES` = 240 samples = 5 ms), which the
 * chunk size does not change. An assertion probing only at the build's own
 * chunk rate therefore passes 20 ms and fails 5 ms while measuring nothing
 * about ringing - it measures which frequency it was pointed at. Three
 * different detectors were built before that was noticed; see the write-up.
 *
 * The likely reason the fault does not appear: on loopback there is no jitter,
 * so the buffer never runs dry - `voice-latency` reports it sitting at its
 * 40 ms floor for entire runs - so the resume ramp that causes the ring
 * essentially never runs. Reproducing it needs induced jitter or loss, which
 * this harness cannot yet do. **Until that exists, treat a pass here as "no
 * gross modulation", not as "does not ring".**
 *
 * So the assertion below is deliberately weak and honest: it fails on a gain
 * swing far above anything either build produces, which would catch a coarse
 * regression, and it prints both rates every run so the numbers accumulate.
 */

/** Long enough for many burst onsets. */
const COLLECT_MS = 20_000;

const MIX_CHUNK_MS = Number(process.env.FANCY_MIX_CHUNK_MS ?? "20");

/**
 * Gain swing, as a fraction, that fails the run.
 *
 * Both builds measured here sit between 0.7% and 1.4% at either probe, so 5% is
 * roughly four times the observed spread: high enough that neither a healthy
 * build nor the reverted one trips it, which is the point - this threshold is
 * not pretending to separate them. It exists to catch a modulation an order of
 * magnitude worse than anything seen, and it is stated in the units the fault
 * is described in rather than in dB over a floor, because a floor that moves
 * with the probe frequency is exactly what made the earlier attempts wrong.
 */
const SWING_LIMIT = Number(process.env.E2E_RING_SWING_LIMIT ?? "0.05");

const skip = existsSync(config.appBin) ? false : `no client binary at ${config.appBin}`;

describe("voice ring: playout does not modulate at the mix-chunk rate", { concurrency: 1, skip }, () => {
  let alice: TauriApp;
  let bob: TauriApp;
  let dumpDir: string;
  let passed = false;

  const suffix = Date.now() % 1_000_000;
  const aliceName = `e2e-vrA-${suffix}`;
  const bobName = `e2e-vrB-${suffix}`;

  before(async () => {
    const fixture = ensureGatedTone();
    dumpDir = mkdtempSync(path.join(os.tmpdir(), "e2e-voice-ring-"));

    [alice, bob] = await TauriApp.launchAll(
      {
        instance: 0,
        extraEnv: { FANCY_E2E_VIRTUAL_MIC: `file:${fixture}:${GATED_RATE}` },
      },
      {
        instance: 1,
        extraEnv: {
          FANCY_E2E_PLAYOUT_DUMP_DIR: dumpDir,
          FANCY_E2E_MUTE_OUTPUT: process.env.E2E_UNMUTE === "1" ? "0" : "1",
          ...(process.env.FANCY_MIX_CHUNK_MS
            ? { FANCY_MIX_CHUNK_MS: process.env.FANCY_MIX_CHUNK_MS }
            : {}),
        },
      },
    );

    await Promise.all([
      alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);
    await Promise.all([
      alice.chat.waitLoaded(config.connectTimeout),
      bob.chat.waitLoaded(config.connectTimeout),
    ]);
    await alice.chat.roster.waitForMember(bobName);
    await bob.chat.roster.waitForMember(aliceName);
    await alice.chat.voice.tapMute();
    await bob.chat.voice.tapMute();
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
    if (dumpDir && passed && !process.env.E2E_KEEP_DUMPS) {
      rmSync(dumpDir, { recursive: true, force: true });
    } else if (dumpDir) {
      console.log(`voice-ring: playout kept in ${dumpDir}`);
    }
  });

  it("plays gated tone bursts back without a chunk-rate modulation", async () => {
    await delay(COLLECT_MS);
    await delay(1_500);

    const wav = path.join(dumpDir, "playout.wav");
    assert.ok(existsSync(wav), `no playout recording in ${dumpDir} - Bob played nothing`);

    const played = readWav(wav);
    const mod = chunkModulation(played, {
      carrierHz: GATED_CARRIER_HZ,
      chunkMs: MIX_CHUNK_MS,
    });

    // Both rates are reported every run, not just the one this build uses.
    // Tying the probe to the configuration is what made two earlier attempts at
    // this measurement report a difference that was only ever the difference
    // between where they had looked.
    const other = MIX_CHUNK_MS === 20 ? 5 : 20;
    const control = chunkModulation(played, {
      carrierHz: GATED_CARRIER_HZ,
      chunkMs: other,
    });

    console.log(
      `voice ring: ${1000 / MIX_CHUNK_MS} Hz (this build's chunk) swing ` +
        `${(mod.modulationDepth * 100).toFixed(2)}%, ` +
        `${(mod.sidebandDb - mod.floorDb).toFixed(1)} dB over floor; ` +
        `${1000 / other} Hz (control) swing ${(control.modulationDepth * 100).toFixed(2)}%, ` +
        `${(control.sidebandDb - control.floorDb).toFixed(1)} dB; ` +
        `${mod.analysedSeconds.toFixed(1)} s of carrier ` +
        `(fails over ${(SWING_LIMIT * 100).toFixed(0)}% swing)`,
    );

    assert.ok(
      mod.analysedSeconds >= 4,
      `only ${mod.analysedSeconds.toFixed(1)} s of carrier reached Bob - the bursts are not ` +
        `arriving, so nothing was measured`,
    );

    // Both probes, not just this build's: a modulation at a rate the build does
    // not use is still a modulation, and pointing the assertion only at the
    // configured rate is the mistake documented above.
    const worst = Math.max(mod.modulationDepth, control.modulationDepth);
    assert.ok(
      worst <= SWING_LIMIT,
      `playout carries a ${(worst * 100).toFixed(2)}% periodic gain swing ` +
        `(limit ${(SWING_LIMIT * 100).toFixed(0)}%) at ${1000 / MIX_CHUNK_MS} Hz or ` +
        `${1000 / other} Hz. Both builds measured so far sit near 1%, so this is a real ` +
        `change in the playout path. Recording: ${wav}`,
    );
    passed = true;
  });
});
