import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { CheckerboardWindow } from "../util/checkerboard";
import { delay } from "../util/wait";
import { tkinterMissing } from "../util/preconditions";
import { captureEnv } from "../util/capture-env";

/**
 * Screen-share PERFORMANCE floor, end-to-end through the Rust capture +
 * H.264 encoder + server SFU + browser decoder:
 *
 *   1. Decoded frame rate on the receiving side must be >= 30 fps.
 *   2. Glass-to-glass latency must be <= 500 ms.
 *
 * The shared source is a full-HD (1920x1080) checkerboard that CHANGES ON
 * EVERY FRAME (~60 Hz shade cycling) and additionally inverts its phase once
 * a second, reporting each flip with a wall-clock timestamp:
 *
 *   - fps: the viewer's decoded-frame counter over a fixed window. The
 *     per-frame animation is what makes this honest - identical frames
 *     still re-encode and tick the counter, so a static source would let a
 *     sub-fps pipeline "pass". Every counted frame here is a distinct one
 *     that travelled the whole pipeline at full-HD load.
 *   - latency: poll the decoded pixels and record when each reported phase
 *     flip becomes visible. Both clients run on one machine, so the
 *     helper's clock and the poller's clock are the same clock.
 *
 * Regressions that historically broke these numbers: re-enumerating every
 * OS window per captured frame, stamping samples with nominal instead of
 * real durations (latency grew without bound), scalar full-frame resizing,
 * and an encoder fps cap below 30.
 */
const FPS_FLOOR = 30;
const LATENCY_CEILING_MS = 500;
const BLINK_MS = 1000;
/** How long the fps/latency observation window runs. */
const MEASURE_MS = 10_000;
/** Full-HD board: 16x9 cells of 120 px = 1920x1080. */
const BOARD = { cols: 16, rows: 9, cell: 120 } as const;

describe("multi-client: screen sharing performance (fps + latency)", { skip: tkinterMissing() }, () => {
  let alice: TauriApp;
  let bob: TauriApp;
  let board: CheckerboardWindow;

  const suffix = String(Date.now() % 1000000);
  const aliceName = `e2e-PerfA-${suffix}`;
  const bobName = `e2e-PerfB-${suffix}`;
  const title = `fancy-e2e-perf-${suffix}`;

  before(async () => {
    board = await CheckerboardWindow.launch({
      title,
      phase: 0,
      x: 80,
      y: 80,
      cols: BOARD.cols,
      rows: BOARD.rows,
      cell: BOARD.cell,
      blinkMs: BLINK_MS,
      animate: true,
    });

    [alice, bob] = await TauriApp.launchAll(
      { instance: 0, extraEnv: captureEnv() },
      { instance: 1, extraEnv: captureEnv() },
    );

    await alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });

    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);

    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);

    await alice.stream.shareWindow(title);
    await bob.stream.watchByName(aliceName);
  });

  after(async () => {
    board?.close();
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it(`decodes at >= ${FPS_FLOOR} fps on the viewer`, async () => {
    const start = await bob.stream.readPlaybackStats(false);
    assert.ok(start.totalVideoFrames >= 0, "viewer <video> exposes no decoded-frame counter");
    await delay(MEASURE_MS);
    const end = await bob.stream.readPlaybackStats(false);

    const fps = ((end.totalVideoFrames - start.totalVideoFrames) * 1000) / (end.tMs - start.tMs);
    assert.ok(
      fps >= FPS_FLOOR,
      `viewer decoded only ${fps.toFixed(1)} fps (< ${FPS_FLOOR}); ` +
        `frames ${start.totalVideoFrames} -> ${end.totalVideoFrames} over ${end.tMs - start.tMs}ms`,
    );
  });

  it(`shows source changes within ${LATENCY_CEILING_MS} ms on the viewer`, async () => {
    // Sample the decoded board's phase as fast as the driver allows and
    // record when it changes; each observed change is then matched to the
    // most recent reported source flip.
    const observed: { phase: number; tMs: number }[] = [];
    const deadline = Date.now() + MEASURE_MS;
    let lastPhase = -1;
    while (Date.now() < deadline) {
      const read = await bob.stream.readCheckerboard(false, board.cols, board.rows);
      if (read.ok && read.checkerboard && read.phase !== lastPhase) {
        observed.push({ phase: read.phase, tMs: Date.now() });
        lastPhase = read.phase;
      }
    }

    // Match each observed phase change to the flip that caused it: the
    // latest source flip TO that phase at or before the observation.
    const latencies: number[] = [];
    for (const obs of observed) {
      const flip = [...board.flips]
        .reverse()
        .find((f) => f.phase === obs.phase && f.atMs <= obs.tMs);
      if (flip) latencies.push(obs.tMs - flip.atMs);
    }

    assert.ok(
      latencies.length >= 3,
      `too few phase changes observed to measure latency ` +
        `(observed=${observed.length}, sourceFlips=${board.flips.length})`,
    );

    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)];
    assert.ok(
      median <= LATENCY_CEILING_MS,
      `median glass-to-glass latency ${median}ms exceeds ${LATENCY_CEILING_MS}ms ` +
        `(samples: ${latencies.join(", ")}ms)`,
    );
  });
});
