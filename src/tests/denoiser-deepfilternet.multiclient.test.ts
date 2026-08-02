import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";

/**
 * Is DeepFilterNet actually enabled, and does it actually clean the audio?
 *
 * The backend has existed in the tree behind the `deepfilternet-denoiser`
 * cargo feature since the denoiser rework, switched on for no build. Two
 * separate things have to be true before that is worth anything, and each
 * fails silently on its own:
 *
 * 1. **The feature is compiled into this binary.** Without it
 *    `NoiseSuppressionAlgorithm::DeepFilterNet` still exists, is still
 *    selectable in the settings type, and `make_deepfilter_backend` quietly
 *    falls back to RNNoise. Nothing logs, nothing errors, and the settings
 *    screen shows the user an algorithm the build cannot run.
 * 2. **Selecting it changes the audio.** A denoiser that loads and then
 *    passes everything through is indistinguishable from a working one by
 *    every other assertion in this suite.
 *
 * # Why this file measures `rms` and not `tone_ratio`
 *
 * `tone_ratio` is a Goertzel power ratio **normalised by total power**, so
 * it reads ~1.0 for a clean tone whether that tone arrives at full scale or
 * 24 dB down. A denoiser is a change in *level*. Measured with `tone_ratio`
 * alone, "the model crushed the audio" and "the model is working" are the
 * same number — which is why the stats file now also reports `rms`.
 *
 * # Why the microphone emits noise
 *
 * DeepFilterNet3 is a speech enhancer. Measured against the suite's usual
 * 440 Hz sine it applies its full configured attenuation — around 24 dB —
 * because a pure tone is, correctly, not speech. So this file drives the
 * mic with `sine:48000:440+noise:0.10`: the noise is the thing the denoiser
 * is supposed to remove, and removing it is what the assertion below
 * measures. Perceptual quality on real speech is measured where it can be
 * measured properly, in
 * `vendor/client/crates/mumble-protocol/tests/denoiser_quality.rs`.
 */

/** How long to wait for the first voice packets to reach Bob. */
const VOICE_TIMEOUT_MS = 25_000;

/** How long to let a level settle before sampling it. */
const SETTLE_MS = 6_000;

interface SessionStats {
  packets: number;
  tone_ratio: number;
  rms: number;
}

interface StatsDoc {
  wall_ms: number;
  sessions: Record<string, SessionStats>;
}

function readStats(file: string): StatsDoc | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StatsDoc;
  } catch {
    return null; // not written yet, or caught mid-write
  }
}

/** The session sending the most packets — Alice, from Bob's viewpoint. */
function speaker(doc: StatsDoc | null): SessionStats | null {
  if (!doc) return null;
  let best: SessionStats | null = null;
  for (const stats of Object.values(doc.sessions)) {
    if (!best || stats.packets > best.packets) best = stats;
  }
  return best;
}

async function waitForVoice(file: string, packets: number, timeout: number) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = speaker(readStats(file));
    if (found && found.packets >= packets) return found;
    await delay(500);
  }
  return null;
}

/**
 * The median `rms` over `ms`, sampled once a second.
 *
 * Median rather than mean or peak: the level is measured over a rolling
 * 100 ms window, so any single reading can land on a gap between packets
 * and report near-silence. One such sample would swing a mean and would
 * make a comparison between two settings meaningless.
 */
async function medianRms(file: string, ms: number): Promise<number> {
  const seen: number[] = [];
  const polls = Math.max(3, Math.floor(ms / 1000));
  for (let i = 0; i < polls; i++) {
    await delay(1000);
    const found = speaker(readStats(file));
    if (found && found.packets > 0) seen.push(found.rms);
  }
  if (seen.length === 0) return 0;
  seen.sort((a, b) => a - b);
  return seen[Math.floor(seen.length / 2)];
}

/** Change one audio setting, leaving the rest of the struct as it is. */
async function setDenoiser(app: TauriApp, algorithm: string): Promise<void> {
  const settings = await app.invoke<Record<string, unknown>>("get_audio_settings");
  await app.invoke("set_audio_settings", {
    settings: {
      ...settings,
      // `none` means the whole stage is off, not "an algorithm that does
      // nothing" — the UI couples the two the same way.
      noise_suppression: algorithm !== "none",
      denoiser_algorithm: algorithm,
    },
  });
}

describe("DeepFilterNet noise suppression", { concurrency: 1 }, () => {
  let alice: TauriApp;
  let bob: TauriApp;
  let statsDir: string;
  /** What Bob's decoder received — Alice's noisy microphone. */
  let bobStats: string;

  const suffix = String(Date.now() % 1_000_000);
  const aliceName = `e2e-DfA-${suffix}`;
  const bobName = `e2e-DfB-${suffix}`;

  before(async () => {
    statsDir = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-denoise-"));
    bobStats = path.join(statsDir, "bob.json");

    // Alice transmits a tone with broadband noise mixed under it. The
    // noise is the signal under test; the tone is only there so the far
    // end has something recognisable to lock onto.
    alice = await TauriApp.launch({
      instance: 0,
      extraEnv: { FANCY_E2E_VIRTUAL_MIC: "sine:48000:440+noise:0.10" },
    });
    bob = await TauriApp.launch({
      instance: 1,
      extraEnv: { FANCY_E2E_AUDIO_STATS_FILE: bobStats },
    });

    await alice.connect.connect(config.serverHost, aliceName);
    await bob.connect.connect(config.serverHost, bobName);
    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);
    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);

    // Fresh profiles start with voice inactive; the first tap brings the
    // pipelines up. Alice needs outbound, Bob inbound.
    await alice.chat.tapMute();
    await bob.chat.tapMute();
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
    try {
      rmSync(statsDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("offers DeepFilterNet in this build", async () => {
    // The assertion that catches the actual bug this work fixes: the
    // backend existed and no shipped build had it. `is_available` is
    // computed from `cfg!(feature = ...)`, so this is a direct read of
    // whether the binary under test was compiled with it.
    const algorithms = await alice.invoke<string[]>("get_available_denoiser_algorithms");
    assert.ok(
      algorithms.includes("deepfilternet"),
      `this build does not offer DeepFilterNet (got ${JSON.stringify(algorithms)}). ` +
        `The backend then silently falls back to RNNoise while the settings screen still ` +
        `lists it, so the user selects a model that is not there.`,
    );
  });

  it("keeps the setting it was given", async () => {
    // Round-trips through the backend, so a setting the UI can express and
    // the state layer drops would fail here rather than three assertions
    // later as "the denoiser did nothing".
    await setDenoiser(alice, "deepfilternet");
    const settings = await alice.invoke<{ denoiser_algorithm: string; noise_suppression: boolean }>(
      "get_audio_settings",
    );
    assert.equal(settings.denoiser_algorithm, "deepfilternet");
    assert.equal(settings.noise_suppression, true);
  });

  it("relays Alice's noisy microphone to Bob at all", async () => {
    // Before measuring how much quieter the noise got, prove there is
    // audio to measure. A denoiser that broke the pipeline outright would
    // otherwise score a perfect noise reduction.
    const first = await waitForVoice(bobStats, 25, VOICE_TIMEOUT_MS);
    assert.ok(first, `Bob received no voice packets from Alice within ${VOICE_TIMEOUT_MS / 1000} s`);
  });

  it("makes the noise measurably quieter than with the denoiser off", async () => {
    // The measurement, run twice against the same microphone: the only
    // thing that changes between the two windows is the algorithm.
    await setDenoiser(alice, "none");
    const off = await medianRms(bobStats, SETTLE_MS);
    assert.ok(off > 0, "no level was recorded with the denoiser off");

    await setDenoiser(alice, "deepfilternet");
    const on = await medianRms(bobStats, SETTLE_MS);

    const dropDb = 20 * Math.log10(Math.max(on, 1e-9) / Math.max(off, 1e-9));
    // Reported on success too, not just in the failure message. A threshold
    // test that only speaks when it fails hides the margin it is passing by,
    // so a model that quietly degrades from 24 dB to 7 looks identical to a
    // healthy one right up until the day it crosses the line.
    console.log(
      `    denoiser off: rms ${off.toFixed(5)}  ->  DeepFilterNet: rms ${on.toFixed(5)}  ` +
        `(${dropDb.toFixed(1)} dB)`,
    );
    assert.ok(
      dropDb < -6,
      `DeepFilterNet only changed the received level by ${dropDb.toFixed(1)} dB ` +
        `(off ${off.toFixed(5)} -> on ${on.toFixed(5)}). The model is loaded but is not ` +
        `suppressing anything, or the setting never reached the capture pipeline.`,
    );
  });

  // There is deliberately no "and the speaker is still audible" assertion
  // here, tempting as its symmetry is.
  //
  // The over-suppression guard is the necessary other half of the level
  // drop above — a backend that outputs zeroes scores an infinite noise
  // reduction and makes the speaker inaudible. But it cannot be asserted
  // *on this input*: the microphone is emitting a tone and hiss, and
  // DeepFilterNet deciding that none of that is speech and gating it away
  // is the model working, not failing. An assertion that the audio keeps
  // flowing would fail against a correct model, which is worse than no
  // assertion at all.
  //
  // It is measured where it can be measured honestly, against the
  // recorded speech sample:
  // `vendor/client/crates/mumble-protocol/tests/denoiser_quality.rs`
  // asserts speech survives within 6 dB while the noise floor drops by
  // more than 12.

  it("leaves both clients alive", async () => {
    // The model runs on the capture thread through a `!Send` wrapper that
    // is manually asserted safe. A panic there takes the audio thread with
    // it, so "both windows still answer" is the assertion that catches it.
    assert.ok(await alice.invoke<unknown>("get_audio_settings"), "Alice's backend stopped");
    assert.ok(await bob.invoke<unknown>("get_audio_settings"), "Bob's backend stopped");
  });
});
