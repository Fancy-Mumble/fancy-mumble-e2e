import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";
import { ensureSpeechFixture, FIXTURE_RATE } from "../../scripts/make-speech-fixture.mts";
import { readWav, compare } from "../util/audio-fidelity";

/**
 * Does speech survive the trip, or merely *something*?
 *
 * # What this adds over the tone suites
 *
 * `audio.resample.test.ts` and `starling-voice.multiclient.test.ts` push a
 * 440 Hz sine through and check a Goertzel ratio at the far end. That proves
 * the transport carries audio and that odd sample rates do not desynchronise -
 * both worth having, neither the same as "a person could understand this".
 *
 * A tone is the easiest signal every stage will ever see:
 *
 * * Opus chooses its mode from the content, and a steady tone steers it toward
 *   CELT - SILK's path, which real speech goes through, may never execute.
 * * A tone never stops, so discontinuous transmission and every
 *   resume-after-silence path go untested.
 * * A noise gate is judged on onsets; a constant tone has none.
 * * A speech-tuned denoiser is being scored on a tone, the opposite of its
 *   design target.
 *
 * And the oracle is weak: a dominant-bin ratio survives clipping, wrong gain,
 * short dropouts and resampler aliasing. It says "something tonal arrived".
 *
 * # The oracle here
 *
 * Alice speaks a real recording; Bob's *decoded* audio is dumped and compared
 * against that recording by short-term energy envelope - the rhythm of speech.
 * It is robust to codec delay, jitter and phase, and destroyed by exactly the
 * faults that matter. Measured on this metric a 440 Hz tone scores ~0.01 against
 * speech, so the assertion cannot be satisfied by the old signal.
 *
 * # Requirements
 *
 * A client built from this working tree (the `file:` mic source and the decoded
 * dump are both new), and a server on `config.serverPort`.
 */

/** Envelope correlation below this is not the speech that was sent. */
const MIN_CORRELATION = 0.55;

const skip = existsSync(config.appBin)
  ? false
  : `no client binary at ${config.appBin} - build it with \`cargo tauri build\` in vendor/client`;

describe("voice fidelity: real speech survives the round trip", { concurrency: 1, skip }, () => {
  let alice: TauriApp;
  let bob: TauriApp;
  let dumpDir: string;
  let fixture: string;
  /** Cleared only on success, so a failure leaves its evidence behind. */
  let passed = false;

  const suffix = Date.now() % 1_000_000;
  const aliceName = `e2e-vfA-${suffix}`;
  const bobName = `e2e-vfB-${suffix}`;


  before(async () => {
    fixture = ensureSpeechFixture();
    dumpDir = mkdtempSync(path.join(os.tmpdir(), "e2e-voice-fidelity-"));

    [alice, bob] = await Promise.all([
      TauriApp.launch({
        instance: 0,
        // Alice speaks the fixture on a loop, declared at the rate it was
        // actually recorded at. The Harvard-sentence recordings are 8 kHz
        // telephone band, so the client's own `StreamResampler` upsamples 6× to
        // 48 kHz on the way out - the same resampler a real non-48 kHz device
        // goes through, driven by the same fixture.
        extraEnv: { FANCY_E2E_VIRTUAL_MIC: `file:${fixture}:${FIXTURE_RATE}` },
      }),
      TauriApp.launch({
        instance: 1,
        // Bob says nothing and records everything he is played.
        extraEnv: { FANCY_E2E_AUDIO_DUMP_DIR: dumpDir },
      }),
    ]);

    await Promise.all([
      alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);
    await Promise.all([
      alice.chat.waitLoaded(config.connectTimeout),
      bob.chat.waitLoaded(config.connectTimeout),
    ]);
    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);

    // A fresh profile connects deaf and muted on purpose
    // (`state/connection.rs:434`), so neither pipeline exists yet: Alice would
    // send nothing and Bob would decode nothing. The first tap of the mute
    // control brings them up - Alice needs outbound, Bob inbound.
    await alice.chat.tapMute();
    await bob.chat.tapMute();

    // Both stay in the root channel, as the other voice suites do. Anyone else
    // on the fixture server would land in Bob's dump as their own file, and the
    // assertion takes the best-correlating one - a stranger's audio scores near
    // zero against Alice's fixture, so it cannot be mistaken for hers.
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
    // Kept when the assertion failed. This test's whole output is a few seconds
    // of audio, and "the correlation was 0.2" is not something anyone can act
    // on without listening to what actually arrived - deleting it turns a
    // diagnosable failure into a mystery.
    if (dumpDir && passed) {
      rmSync(dumpDir, { recursive: true, force: true });
    } else if (dumpDir) {
      console.log(`voice-fidelity: decoded audio kept for inspection in ${dumpDir}`);
    }
  });

  it("Bob hears the speech Alice is speaking, not merely a signal", async () => {
    // Long enough to cover several sentences and the pauses between them: the
    // pauses are half of what makes this a speech assertion rather than a
    // loudness one.
    await delay(15_000);

    const dumps = readdirSync(dumpDir).filter((f) => f.endsWith(".wav"));
    assert.ok(
      dumps.length > 0,
      `no decoded audio was dumped to ${dumpDir} - Bob received nothing, or the ` +
        `client predates FANCY_E2E_AUDIO_DUMP_DIR`,
    );

    const source = readWav(fixture);
    // One file per speaker; the best match is Alice's, and asserting on the
    // best rather than on a session id keeps this independent of who got which
    // session number.
    const results = dumps.map((f) => compare(source, readWav(path.join(dumpDir, f))));
    const best = results.reduce((a, b) => (a.correlation > b.correlation ? a : b));

    // Printed on success as well as failure. The thresholds below are floors,
    // and a run that passes at 0.58 is telling a different story from one that
    // passes at 0.85 - without the numbers, a slow drift toward the floor is
    // invisible until the day it crosses.
    console.log(
      `voice fidelity: correlation ${best.correlation.toFixed(3)} (floor ${MIN_CORRELATION}), ` +
        `longest dropout over speech ${best.longestDropoutMs} ms (limit 200), ` +
        `far-end silence ${(best.receivedSilenceRatio * 100).toFixed(0)}% vs source ` +
        `${(best.sourceSilenceRatio * 100).toFixed(0)}% (the gate, expected)`,
    );

    assert.ok(
      best.correlation >= MIN_CORRELATION,
      `Bob's audio does not resemble what Alice spoke: envelope correlation ` +
        `${best.correlation.toFixed(3)} < ${MIN_CORRELATION}. A 440 Hz tone scores ~0.01 and ` +
        `silence 0.00 on this metric, so this is closer to "not the speech" than to ` +
        `"slightly degraded". Dumps: ${dumps.join(", ")} in ${dumpDir}`,
    );

    // And nothing went missing *while Alice was talking*.
    //
    // Deliberately not "the far end is as silent as the source". A real
    // recording has room tone at around -44 dBFS, the noise gate is supposed to
    // close over it, and the far end is consequently far more silent than the
    // source - 38% against 3% on a healthy run. Asserting those match would be
    // asserting the gate does not work. Silence over speech is the defect;
    // silence over room tone is the feature.
    //
    // 200 ms because Opus frames are 10-20 ms and a jitter buffer may conceal a
    // few: anything at or under that is a hiccup, and a fifth of a second of
    // missing speech is audible as a cut word.
    assert.ok(
      best.longestDropoutMs <= 200,
      `${best.longestDropoutMs} ms of silence arrived while Alice was audibly speaking - ` +
        `that is a dropout, not a pause. (Overall the far end is ` +
        `${(best.receivedSilenceRatio * 100).toFixed(0)}% silent against the source's ` +
        `${(best.sourceSilenceRatio * 100).toFixed(0)}%, which is the gate and is expected.)`,
    );
    passed = true;
  });
});
