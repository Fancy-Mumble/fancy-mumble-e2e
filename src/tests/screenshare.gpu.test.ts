import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { CheckerboardWindow } from "../util/checkerboard";
import { delay } from "../util/wait";

/**
 * ENTIRE-SCREEN sharing performance - the path that engages the platform
 * GPU pipeline (Windows: WGC -> D3D11 video processor -> hardware H.264;
 * Linux: VA-API once implemented; CPU pipeline as automatic fallback).
 *
 * A full-HD checkerboard animating at ~60 Hz runs on the shared screen so
 * the change-driven capture actually produces frames (an idle desktop
 * legitimately captures at ~0 fps) and every decoded frame on the viewer is
 * a distinct one. The floor is the same as the window-share perf test:
 * >= 30 fps decoded on the receiving side.
 *
 * No pixel-classification here: the shared surface is the whole desktop,
 * so the checkerboard grid mapping of the fidelity suite does not apply.
 */
const FPS_FLOOR = 30;
const MEASURE_MS = 10_000;

describe("multi-client: entire-screen sharing (GPU pipeline) fps", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  let board: CheckerboardWindow;

  const suffix = String(Date.now() % 1000000);
  const aliceName = `e2e-GpuA-${suffix}`;
  const bobName = `e2e-GpuB-${suffix}`;
  const title = `fancy-e2e-gpu-motion-${suffix}`;

  before(async () => {
    // Motion source for the change-driven screen capture: full-HD, animated
    // every frame, phase-flipping once a second.
    board = await CheckerboardWindow.launch({
      title,
      phase: 0,
      x: 80,
      y: 80,
      cols: 16,
      rows: 9,
      cell: 120,
      blinkMs: 1000,
      animate: true,
    });

    alice = await TauriApp.launch({ instance: 0 });
    bob = await TauriApp.launch({ instance: 1 });

    await alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });

    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);

    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);

    await alice.stream.shareScreen();
    await bob.stream.watchByName(aliceName);
  });

  after(async () => {
    board?.close();
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it(`decodes the shared screen at >= ${FPS_FLOOR} fps on the viewer`, async () => {
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
});
