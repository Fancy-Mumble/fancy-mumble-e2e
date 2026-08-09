import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";
import { CheckerboardWindow } from "../util/checkerboard";
import { tkinterMissing } from "../util/preconditions";

/**
 * Screen-share delivery health: the decoded stream must not accumulate
 * FREEZES (receiver-side inter-frame stalls) while the shared content has
 * continuous motion.
 *
 * Regression guard for the "Freezes 36 (8.9 s total)" report: the
 * broadcaster used to force an unsolicited IDR on every track every 4 s
 * ("lost PLI" safety net). A desktop-resolution IDR is a multi-hundred-KB
 * burst whose transmission stalls delivery by ~100-400 ms on a real uplink -
 * one freeze every 4 s, matching the report. The SFU already requests an
 * initial keyframe per new viewer and forwards rate-limited PLIs, so the
 * periodic IDR is a rarely-needed fallback.
 *
 * Motion comes from an ANIMATED, always-on-top checkerboard window (a Tk
 * `after()` loop flipping the board at 20 fps): guaranteed OS-level screen
 * changes. In-page rAF animation is useless here - browsers throttle it to
 * ~1 fps in occluded windows, which itself produces freeze-like gaps (that
 * mistake produced a 29-freeze false baseline). NOTE: loopback transmission
 * is ~instant, so this primarily guards sender-side stalls; the network-side
 * effect of IDR bursts shows in real (srflx) sessions.
 */
describe("screen share: delivery health (freezes)", { skip: tkinterMissing() }, () => {
  let app: TauriApp;
  let board: CheckerboardWindow;
  const name = `e2e-Frz-${Date.now() % 1000000}`;
  /** Observation window; long enough for several 4s-cadence IDRs. */
  const WINDOW_MS = 24_000;

  before(async () => {
    // 20 fps OS-level motion, topmost so it stays visible on the shared
    // screen. E2E_BOARD=big makes it 1280x960 - a high-bitrate window share
    // WITHOUT the self-view feedback loop, for load-vs-feedback bisection.
    // E2E_BOARD=big: 1280x960 flip board (compresses well, ~1 Mbps).
    // E2E_BOARD=noise: 1280x960 with random cells per tick - incompressible,
    // drives multi-Mbit/s WITHOUT the self-view feedback loop.
    const big = process.env.E2E_BOARD === "big" || process.env.E2E_BOARD === "noise";
    const noise = process.env.E2E_BOARD === "noise";
    board = await CheckerboardWindow.launch({
      title: `fancy-e2e-motion-${Date.now() % 1000000}`,
      phase: 0,
      animateMs: noise ? 100 : 50,
      cols: noise ? 64 : big ? 20 : 8,
      rows: noise ? 48 : big ? 15 : 6,
      cell: noise ? 20 : 64,
      noise,
      x: 80,
      y: 80,
    });
    app = await TauriApp.launch({ instance: 0 });
    await app.connect.connect(config.serverHost, name, { port: config.serverPort });
    await app.chat.waitLoaded(config.connectTimeout);
    // Backend tracing (send-leg + pipeline timings) for post-run analysis.
    await app.enableFileLogging();
  });

  after(async () => {
    board?.close();
    await Promise.allSettled([app?.close()]);
  });

  afterEach(async () => {
    if (app) await app.stream.stopBroadcastIfActive();
  });

  it("a moving screen share decodes without accumulating freezes", async () => {
    // Freeze stats are measured at the RENDER sink: an occluded/background
    // window gets throttled by WebView2 and fakes freezes. Maximize to keep
    // the viewer visible for the whole observation window.
    await app.driver.manage().window().maximize();

    await app.stream.openPicker();
    // Share the animated checkerboard WINDOW, not the screen: sharing a
    // screen that also displays the own preview creates a delayed feedback
    // loop (preview repaint -> capture -> encode -> preview...) that
    // self-oscillates and pollutes delivery measurements. E2E_SHARE=screen
    // opts back in for comparison runs.
    if (process.env.E2E_SHARE === "screen") {
      await app.stream.pickSource("screens");
    } else {
      await app.stream.pickSource("windows", board.title);
    }
    // E2E_QUALITY lets bisection runs compare presets (default HD).
    const quality = process.env.E2E_QUALITY;
    if (quality === "SD" || quality === "Source") {
      await app.stream.setQuality(quality);
    }
    await app.stream.confirmPicker();
    await app.stream.waitOwnPreview();
    await app.stream.assertOwnPreviewFlowing(2000);

    // Observe the share with the stats panel OPEN, sampling the decoded fps
    // and the freeze counter each second: the series' SHAPE localises a
    // problem (steady fps + climbing freezes = render-side; sawtooth fps
    // with 0-dips = bursty delivery).
    const rows = await app.stream.statsResolutionCount(); // opens the stats panel
    assert.ok(rows >= 1, "stats panel shows no video track");
    const fpsSeries: number[] = [];
    const freezeSeries: number[] = [];
    const kbpsSeries: number[] = [];
    const bufferSeries: number[] = [];
    const ticks = Math.floor(WINDOW_MS / 1000);
    for (let i = 0; i < ticks; i++) {
      await delay(1000);
      fpsSeries.push((await app.stream.readStatsFps())[0] ?? Number.NaN);
      freezeSeries.push((await app.stream.readStatsFreezes())[0]?.[0] ?? Number.NaN);
      kbpsSeries.push(await app.stream.readStatsNumber("Connection Speed"));
      bufferSeries.push(await app.stream.readStatsNumber("Buffer Health"));
    }
    console.log(`fps series:    [${fpsSeries.join(", ")}]`);
    console.log(`freeze series: [${freezeSeries.join(", ")}]`);
    console.log(`kbps series:   [${kbpsSeries.join(", ")}]`);
    console.log(`buffer series: [${bufferSeries.join(", ")}]`);

    const freezes = await app.stream.readStatsFreezes();
    assert.ok(freezes.length >= 1, "stats panel shows no freeze row");
    const [count, totalS] = freezes[0]!;
    console.log(`screen-share freezes over ${WINDOW_MS / 1000}s of motion: ${count} (${totalS}s)`);

    // With the 4s periodic-IDR cadence this window saw ~5-6 freezes on a
    // real uplink; allow a small budget for genuine scheduling hiccups.
    assert.ok(
      count <= 2,
      `decoded stream froze ${count} times (${totalS}s) in ${WINDOW_MS / 1000}s of continuous motion`,
    );

    await app.stream.closeStats();
    await app.stream.stopBroadcast();
  });
});
