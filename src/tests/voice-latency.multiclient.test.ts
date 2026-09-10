import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";
import { readWav } from "../util/audio-fidelity";

/**
 * How long is it between Alice speaking and Bob hearing it?
 *
 * # Why this exists
 *
 * Every latency figure on the voice work so far was derived from buffer sizes -
 * a 40 ms jitter floor plus a 10 ms output buffer plus a mix chunk - and none of
 * it had ever been timed. Derived numbers cannot notice a stage nobody thought
 * of, and they cannot tell you when a change made things worse: a 5 ms mix chunk
 * that shipped on that reasoning turned out to ring audibly, and the suite that
 * was supposed to be watching passed it unchanged.
 *
 * `voice-fidelity` cannot answer this. Its oracle is an envelope correlation
 * against a dump taken from the mixer's *decoded* tap, which sits before the
 * jitter buffer and before the playout ramps - so it sees neither the delay
 * those add nor any artefact they introduce.
 *
 * # The measurement
 *
 * Alice's virtual mic plays a click train: a 5 ms 2 kHz burst every period, over
 * a continuous 440 Hz carrier. The carrier matters - it holds the noise gate
 * open, so the gate is never the thing deciding when a burst gets through, which
 * would otherwise land in the number as if it were buffering. Each burst's
 * **due** time is logged from the generator, which is paced by wall clock, so
 * "when it was spoken" is known exactly rather than observed late.
 *
 * Bob records what his output device is handed, with a wall clock against the
 * sample index at each hand-over. Finding the bursts in that recording and
 * pairing each with the injection that caused it gives mouth-to-ear directly.
 *
 * # What the number does and does not include
 *
 * It spans capture pacing, the outbound filter chain, Opus, the network, the
 * jitter buffer, decode and the mixer - everything the client controls. It stops
 * at the point samples are handed to the device, so it excludes the output
 * device's own ring buffer (~10 ms as configured, plus whatever the driver keeps)
 * and the DAC. Those are a roughly constant addition, not something a change to
 * this codebase moves; if that stops being true this test will not notice.
 */

/** Milliseconds between click onsets. Must exceed the latency being measured. */
const CLICK_PERIOD_MS = 250;

/** How long to let clicks flow before reading the recording. */
const COLLECT_MS = 14_000;

/**
 * Ceiling for the median, in milliseconds.
 *
 * Deliberately loose: this test's job is to produce a number and to catch a
 * change that doubles it, not to encode today's value as a requirement. The
 * measured figure is printed on every run, so tightening it is a decision
 * somebody can make from evidence.
 */
const MEDIAN_CEILING_MS = 250;

const skip = existsSync(config.appBin)
  ? false
  : `no client binary at ${config.appBin} - build it with \`cargo build --release -p mumble-tauri --features custom-protocol\``;

/** One Goertzel magnitude for `freq` over `samples`. */
function goertzel(samples: Float32Array, from: number, len: number, freq: number, rate: number) {
  const k = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = samples[from + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / len;
}

/**
 * Sample indices where a 2 kHz burst starts.
 *
 * A hop of 1 ms bounds the error well under the millisecond, which is far below
 * anything the result is quoted to. The refractory window stops the tail of one
 * burst being counted as the start of another.
 */
function burstOnsets(samples: Float32Array, rate: number): number[] {
  const win = Math.round(rate * 0.005);
  const hop = Math.round(rate * 0.001);
  const refractory = Math.round(rate * 0.2);

  const mags: { at: number; mag: number }[] = [];
  for (let at = 0; at + win <= samples.length; at += hop) {
    mags.push({ at, mag: goertzel(samples, at, win, 2_000, rate) });
  }
  if (mags.length === 0) return [];

  // Threshold from the data rather than an absolute level: the carrier sets the
  // floor and the bursts the peak, and both scale with output volume.
  const peak = mags.reduce((m, x) => Math.max(m, x.mag), 0);
  const floor = [...mags].sort((a, b) => a.mag - b.mag)[Math.floor(mags.length / 2)].mag;
  const threshold = floor + (peak - floor) * 0.5;

  // A rising edge, not merely "loud": a window that is above the threshold
  // while the one before it also was is somewhere inside a burst, not at its
  // start. Without this a run occasionally reported an arrival 0.1 ms after an
  // injection - physically impossible, and a sign the detector was picking a
  // point that was not an onset at all.
  const onsets: number[] = [];
  let last = -Infinity;
  let wasAbove = false;
  for (const { at, mag } of mags) {
    const above = mag >= threshold;
    if (above && !wasAbove && at - last >= refractory) {
      onsets.push(at);
      last = at;
    }
    wasAbove = above;
  }
  return onsets;
}

/** `(unix_us, sample_index)` pairs, ascending, from the anchors CSV. */
function readAnchors(file: string): { us: number; idx: number }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .slice(1)
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [us, idx] = l.split(",");
      return { us: Number(us), idx: Number(idx) };
    })
    .sort((a, b) => a.idx - b.idx);
}

/**
 * Wall-clock microsecond at which playout sample `idx` left for the device.
 *
 * Each anchor timestamps the last sample of its batch, so a sample inside that
 * batch is interpolated back at the sample rate. Before the first anchor there
 * is nothing to interpolate from, and such a sample is not used.
 */
function playoutTime(anchors: { us: number; idx: number }[], idx: number, rate: number) {
  const at = anchors.find((a) => a.idx >= idx);
  if (!at) return undefined;
  return at.us - ((at.idx - idx) / rate) * 1_000_000;
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

describe("voice latency: mouth to ear", { concurrency: 1, skip }, () => {
  let alice: TauriApp;
  let bob: TauriApp;
  let workDir: string;
  let clickLog: string;
  let playoutDir: string;
  let statsFile: string;
  let passed = false;

  const suffix = Date.now() % 1_000_000;
  const aliceName = `e2e-vlA-${suffix}`;
  const bobName = `e2e-vlB-${suffix}`;

  before(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), "e2e-voice-latency-"));
    clickLog = path.join(workDir, "clicks.txt");
    playoutDir = path.join(workDir, "playout");
    statsFile = path.join(workDir, "bob-audio-stats.json");

    [alice, bob] = await TauriApp.launchAll(
      {
        instance: 0,
        extraEnv: {
          FANCY_E2E_VIRTUAL_MIC: `click:48000:${CLICK_PERIOD_MS}`,
          FANCY_E2E_CLICK_LOG: clickLog,
        },
      },
      {
        instance: 1,
        extraEnv: {
          FANCY_E2E_PLAYOUT_DUMP_DIR: playoutDir,
          // The jitter buffer is the largest single term in the result, and
          // the only one that moves on its own: it adapts. Reporting the depth
          // beside the latency is what separates "the buffer is holding 40 ms"
          // from "something else grew", which a bare number cannot.
          FANCY_E2E_AUDIO_STATS_FILE: statsFile,
          // A continuous carrier for 15 s out of the machine's speakers is
          // unpleasant to sit next to, and this measurement gets run in a loop.
          // The tap is taken before the volume control, so muting costs the
          // measurement nothing.
          // E2E_UNMUTE=1 turns the speakers back on, which is how the claim
          // that muting does not move the measurement gets checked.
          FANCY_E2E_MUTE_OUTPUT: process.env.E2E_UNMUTE === "1" ? "0" : "1",
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

    // Deaf and muted on a fresh profile, so neither pipeline exists yet: the
    // first tap brings Alice's outbound and Bob's inbound up.
    await alice.chat.voice.tapMute();
    await bob.chat.voice.tapMute();
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
    if (workDir && passed) {
      rmSync(workDir, { recursive: true, force: true });
    } else if (workDir) {
      console.log(`voice-latency: recording and click log kept in ${workDir}`);
    }
  });

  it("measures the delay from Alice speaking to Bob's device being handed it", async () => {
    await delay(COLLECT_MS);
    // The client flushes the dump once a second; give the last one room.
    await delay(1_500);

    const wav = path.join(playoutDir, "playout.wav");
    const anchorFile = path.join(playoutDir, "playout-anchors.csv");
    assert.ok(
      existsSync(wav) && existsSync(anchorFile),
      `no playout recording in ${playoutDir} - Bob played nothing, or the client ` +
        `predates FANCY_E2E_PLAYOUT_DUMP_DIR`,
    );
    assert.ok(existsSync(clickLog), `no click log at ${clickLog} - Alice sent nothing`);

    const played = readWav(wav);
    const anchors = readAnchors(anchorFile);
    const injections = readFileSync(clickLog, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map(Number)
      .sort((a, b) => a - b);

    const onsets = burstOnsets(played.samples, played.rate);
    assert.ok(
      onsets.length >= 10,
      `only ${onsets.length} clicks found in ${(played.samples.length / played.rate).toFixed(1)} s ` +
        `of playout - the bursts are not arriving, or the detector cannot see them`,
    );

    const latencies: number[] = [];
    let unpaired = 0;
    for (const onset of onsets) {
      const arrivedUs = playoutTime(anchors, onset, played.rate);
      if (arrivedUs === undefined) continue;
      // The injection that caused it is the last one before it arrived.
      let injected: number | undefined;
      for (const t of injections) {
        if (t <= arrivedUs) injected = t;
        else break;
      }
      if (injected === undefined) continue;
      const ms = (arrivedUs - injected) / 1000;
      // Longer than a period means the pairing is guesswork, not a measurement.
      if (ms < 0 || ms > CLICK_PERIOD_MS) {
        unpaired += 1;
        continue;
      }
      latencies.push(ms);
    }

    assert.ok(
      latencies.length >= 10,
      `only ${latencies.length} clicks could be paired with an injection ` +
        `(${unpaired} fell outside one ${CLICK_PERIOD_MS} ms period) - if the real ` +
        `latency exceeds the period, raise CLICK_PERIOD_MS rather than trusting this`,
    );

    latencies.sort((a, b) => a - b);
    const median = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    // Mouth-to-ear cannot be near zero: a frame has to be filled, encoded and
    // played out. A sub-10 ms pairing is a detector artefact, and one in the
    // set means the rest of the set is not trustworthy either.
    assert.ok(
      latencies[0] >= 10,
      `a click appeared to arrive in ${latencies[0].toFixed(1)} ms, which is not ` +
        `possible - the burst detector is finding something that is not an onset`,
    );
    console.log(
      `voice latency: median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms ` +
        `over ${latencies.length} clicks (min ${latencies[0].toFixed(1)}, ` +
        `max ${latencies[latencies.length - 1].toFixed(1)}); excludes the output ` +
        `device ring and the DAC`,
    );

    // How much of it the jitter buffer was holding, when that is observable.
    let heldMs: number | undefined;
    if (existsSync(statsFile)) {
      try {
        const stats = JSON.parse(readFileSync(statsFile, "utf8")) as {
          sessions?: Record<string, { buffered?: number }>;
        };
        const buffered = Object.values(stats.sessions ?? {})
          .map((s) => s.buffered ?? 0)
          .filter((n) => n > 0);
        if (buffered.length > 0) heldMs = Math.max(...buffered) / 48;
      } catch {
        // A snapshot written mid-tick is not worth failing a measurement over.
      }
    }
    console.log(
      heldMs === undefined
        ? "voice latency: jitter-buffer depth unavailable"
        : `voice latency: jitter buffer was holding ${heldMs.toFixed(1)} ms of that`,
    );

    assert.ok(
      median <= MEDIAN_CEILING_MS,
      `median mouth-to-ear ${median.toFixed(1)} ms is over the ${MEDIAN_CEILING_MS} ms ceiling`,
    );
    passed = true;
  });
});
