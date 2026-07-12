import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";

/**
 * Regression test for the "non-48 kHz capture devices sound laggy /
 * out-of-sync on official Mumble clients" bug.
 *
 * A kernel-level virtual audio device cannot be created in CI (driver
 * install + admin), so the client ships an env-gated virtual microphone
 * (`FANCY_E2E_VIRTUAL_MIC=sine:<rate>:<freq>`): a wall-clock-paced sine
 * generator at an arbitrary device rate that feeds the exact same
 * resampler -> 10 ms framing -> Opus -> wire pipeline the hardware
 * backends feed. Alice speaks through it at 44.1 kHz and 192 kHz; Bob
 * (receiving through a real server) tallies wire-level stats into a JSON
 * file (`FANCY_E2E_AUDIO_STATS_FILE`).
 *
 * The assertions encode the two contracts the original Mumble client
 * relies on (vendor/server AudioInput.cpp / AudioOutputSpeech.cpp):
 *
 * 1. REAL-TIME RATE: the Opus stream must carry ~48 000 samples per
 *    wall-clock second no matter the capture rate. A sender that
 *    mislabels or mis-resamples its device rate fails this - that IS the
 *    laggy/out-of-sync bug, receiver-agnostic.
 * 2. FRAME-NUMBER UNITS: Mumble's `frame_number` counts 10 ms frames
 *    (480 samples @48 kHz), not packets. Official receivers time their
 *    jitter buffer as `frame_number * 480`, so the frame-number delta
 *    must match the carried samples exactly.
 * 3. TONE INTEGRITY: Bob's decoded audio must actually contain Alice's
 *    440 Hz tone (Goertzel ratio), proving the pipeline carries real
 *    audio rather than silence or garbage.
 */

/** Device rates under test: the common mismatch (44.1 kHz) + an extreme (192 kHz). */
const RATES = [44_100, 192_000] as const;

/** Observation window for the rate measurement. */
const MEASURE_MS = 8_000;

/** Acceptable deviation of the carried-samples rate from 48 kHz. */
const RATE_TOLERANCE = 0.04; // 4 %

interface SessionStats {
  packets: number;
  terminators: number;
  first_frame_number: number;
  last_frame_number: number;
  nominal_samples: number;
  buffered: number;
  tone_ratio: number;
}

interface StatsDoc {
  wall_ms: number;
  sessions: Record<string, SessionStats>;
}

function readStats(file: string): StatsDoc | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StatsDoc;
  } catch {
    return null; // not written yet / mid-write
  }
}

/** The talking session with the most packets (Alice, from Bob's viewpoint). */
function speaker(doc: StatsDoc | null): SessionStats | null {
  if (!doc) return null;
  let best: SessionStats | null = null;
  for (const s of Object.values(doc.sessions)) {
    if (!best || s.packets > best.packets) best = s;
  }
  return best;
}

for (const rate of RATES) {
  describe(`audio resampling: ${rate} Hz virtual mic -> 48 kHz wire`, () => {
    let alice: TauriApp;
    let bob: TauriApp;
    let statsDir: string;
    let statsFile: string;

    const suffix = String(Date.now() % 1000000);
    const aliceName = `e2e-Res${rate / 1000}A-${suffix}`;
    const bobName = `e2e-Res${rate / 1000}B-${suffix}`;

    before(async () => {
      statsDir = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-audio-"));
      statsFile = path.join(statsDir, "stats.json");

      // Alice: virtual mic at the rate under test. Bob: virtual mic too
      // (48 kHz passthrough) so the suite never depends on real capture
      // hardware, plus the stats file for the assertions.
      alice = await TauriApp.launch({
        instance: 0,
        extraEnv: { FANCY_E2E_VIRTUAL_MIC: `sine:${rate}:440` },
      });
      bob = await TauriApp.launch({
        instance: 1,
        extraEnv: {
          FANCY_E2E_VIRTUAL_MIC: "sine:48000:300",
          FANCY_E2E_AUDIO_STATS_FILE: statsFile,
        },
      });

      await alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort });
      await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
      await alice.chat.waitLoaded(config.connectTimeout);
      await bob.chat.waitLoaded(config.connectTimeout);
      await alice.chat.waitForMember(bobName);
      await bob.chat.waitForMember(aliceName);

      // Fresh profiles start with voice INACTIVE; the first tap of the
      // mute control activates the audio pipelines (inactive -> active).
      // Alice needs outbound (the virtual mic starts talking on its own);
      // Bob needs inbound so his mixer decodes the tone for the Goertzel
      // assertion.
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

    it("carries the tone at 48 kHz real-time with 10 ms frame numbering", async () => {
      // Wait for Alice's voice to reach Bob (voice starts with the
      // connection; the sine opens the noise gate).
      const deadline = Date.now() + 20_000;
      let s1: SessionStats | null = null;
      let w1 = 0;
      while (Date.now() < deadline) {
        const doc = readStats(statsFile);
        const sp = speaker(doc);
        if (doc && sp && sp.packets >= 25) {
          s1 = sp;
          w1 = doc.wall_ms;
          break;
        }
        await delay(500);
      }
      assert.ok(s1, "Bob never received Alice's voice packets (no stats after 20 s)");

      // Observation window; track the best tone ratio seen along the way
      // (the speaker buffer is a rolling window, so sample it repeatedly).
      let bestTone = 0;
      const polls = Math.floor(MEASURE_MS / 1000);
      for (let i = 0; i < polls; i++) {
        await delay(1000);
        const sp = speaker(readStats(statsFile));
        if (sp) bestTone = Math.max(bestTone, sp.tone_ratio);
      }
      const doc2 = readStats(statsFile);
      const s2 = speaker(doc2);
      assert.ok(doc2 && s2, "stats file disappeared mid-test");

      const wallSecs = (doc2.wall_ms - w1) / 1000;
      const samples = s2.nominal_samples - s1.nominal_samples;
      const seqUnits = s2.last_frame_number - s1.last_frame_number;

      // 1. Real-time rate: ~48 000 carried samples per wall second.
      const carriedRate = samples / wallSecs;
      assert.ok(
        Math.abs(carriedRate / 48_000 - 1) <= RATE_TOLERANCE,
        `stream is not real-time 48 kHz: carried ${carriedRate.toFixed(0)} samples/s ` +
          `over ${wallSecs.toFixed(1)} s (device rate ${rate} Hz mis-resampled?)`,
      );

      // 2. Mumble frame_number contract: 1 unit per 480 samples.
      const expectedUnits = samples / 480;
      assert.ok(
        Math.abs(seqUnits - expectedUnits) <= 4,
        `frame_number units broken: seq advanced ${seqUnits} 10ms-units but ` +
          `${samples} samples (${expectedUnits.toFixed(1)} units) were carried - ` +
          `official receivers time their jitter buffer by these`,
      );

      // 3. The decoded audio is actually Alice's 440 Hz tone.
      assert.ok(
        bestTone > 0.4,
        `Alice's 440 Hz tone not found in Bob's decoded audio (best Goertzel ratio ${bestTone.toFixed(3)})`,
      );
    });
  });
}
