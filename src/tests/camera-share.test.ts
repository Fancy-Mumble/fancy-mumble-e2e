import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";

/**
 * Virtual-camera share, end-to-end through the Rust-native picker and the
 * DirectShow camera backend.
 *
 * Virtual cameras (OBS Virtual Camera above all) register only as DirectShow
 * devices, invisible to Media Foundation - the client reaches them through
 * `fancy-screenshare`'s DirectShow backend. This test drives that whole path
 * in the real app: enumerate devices in the picker, select the virtual
 * camera, confirm, and require the broadcaster's own preview to decode
 * frames.
 *
 * Regression guard: selecting a virtual camera used to CRASH the app
 * (release builds are panic=abort, so any Rust panic in the capture path
 * aborts the process). The app-liveness assertions after each step turn that
 * abort into a precise test failure instead of a generic session error.
 *
 * Requirements: a Fancy server (the Docker fixture) and at least one camera
 * device. The test targets a *virtual* camera when present (title contains
 * "virtual", e.g. OBS Virtual Camera started via OBS' "Start Virtual
 * Camera"), else falls back to the first listed device; with no devices at
 * all it skips.
 */
describe("camera share: virtual camera (DirectShow backend)", () => {
  let app: TauriApp;
  const name = `e2e-Cam-${Date.now() % 1000000}`;

  before(async () => {
    app = await TauriApp.launch({ instance: 0 });
    await app.connect.connect(config.serverHost, name, { port: config.serverPort });
    await app.chat.waitLoaded(config.connectTimeout);
    // The dev server bundles plugins; their trust prompt is a modal that
    // would click-intercept the share toggle.
    await app.chat.allowServerPlugins();
  });

  after(async () => {
    await Promise.allSettled([app?.close()]);
  });

  // Never leak a running broadcast into the next test (a failing assertion
  // before stopBroadcast() would otherwise leave the share up).
  afterEach(async () => {
    if (app) await app.stream.stopBroadcastIfActive();
  });

  it("every listed camera streams at real fps (even in screenshare mode) without crashing", async (t) => {
    const titles = await app.stream.openPickerDevices();
    assert.ok(
      await app.stream.appAlive(),
      "app crashed while enumerating/thumbnailing camera devices",
    );
    if (titles.length === 0) {
      t.skip("no camera devices on this machine (start OBS Virtual Camera to cover it)");
      return;
    }

    const passed: string[] = [];
    const unavailable: string[] = [];
    for (const [i, title] of titles.entries()) {
      // The picker is already open on the first pass (device enumeration
      // above); later passes re-open it after the previous share stopped.
      if (i > 0) {
        await app.stream.openPickerDevices();
      }

      // Deliberately pick the WORST stream mode for cameras: "Screenshare"
      // caps at 5 fps for crisp text. Camera tracks must NOT inherit that
      // cap (broadcast floors them at 30 fps) - this reproduces the "camera
      // stuck at 4-5 fps" regression.
      await app.stream.setStreamMode("screenshare");
      await app.stream.confirmDevice(title);

      // The crash class reproduced here: the capture thread opens the
      // device right after confirm; with panic=abort a capture-path panic
      // (or an access violation in a third-party DirectShow codec) kills
      // the whole app.
      await delay(2000);
      assert.ok(
        await app.stream.appAlive(),
        `app crashed after selecting camera "${title}" (capture-path panic/abort)`,
      );

      // A camera-only share renders in the main stream video (data-own=true).
      // A device can be listed yet UNAVAILABLE (virtual cams whose source app
      // is not streaming, or a camera held exclusively by another app) - the
      // broadcast then fails cleanly and no preview appears: skip it, the
      // liveness assertions above/below still apply.
      try {
        await app.stream.waitOwnPreview(12000);
      } catch {
        assert.ok(
          await app.stream.appAlive(),
          `app crashed while failing to open camera "${title}"`,
        );
        unavailable.push(title);
        continue;
      }

      // ... and it must KEEP decoding (guards the freeze/stall class where
      // the capture graph wedges after the first frame) ...
      await app.stream.assertOwnPreviewFlowing(2000);

      // ... at a real frame rate, not a slideshow: despite the 5 fps
      // screenshare mode chosen above, the camera track must decode at its
      // own rate. OBS's virtual camera emits a deterministic 30 fps (require
      // >= 15); network-fed cameras (DroidCam over WiFi) rate-limit
      // themselves, so only require clearly-above-the-5fps-cap for them.
      const fps = await app.stream.measureOwnPreviewFps(3000);
      const floor = /virtual/i.test(title) ? 15 : 8;
      assert.ok(
        fps >= floor,
        `camera "${title}" decoded at ${fps.toFixed(1)} fps (floor ${floor}) - ` +
          "inherited the screenshare text-mode cap?",
      );
      passed.push(`${title} @ ${fps.toFixed(1)} fps`);

      await app.stream.stopBroadcast();
      assert.ok(await app.stream.appAlive(), `app crashed while stopping camera "${title}"`);
    }

    console.log(
      `cameras streamed: [${passed.join(", ")}]; unavailable: [${unavailable.join(", ")}]`,
    );
    // At least one camera must have streamed end-to-end, otherwise the suite
    // silently degrades to only testing enumeration.
    assert.ok(
      passed.length > 0,
      `no listed camera actually streamed (unavailable: ${unavailable.join(", ")})`,
    );
  });

  it("screen AND camera share together (one broadcast, both tracks decode)", async (t) => {
    // Pick a screen and a camera in one picker session ("Share both").
    const titles = await app.stream.openPickerDevices();
    if (titles.length === 0) {
      t.skip("no camera devices on this machine");
      return;
    }
    const camera = titles.find((x) => /virtual/i.test(x)) ?? titles[0]!;
    await app.stream.pickSource("screens");
    await app.stream.pickSource("devices", camera);

    // The selection summary must make the cross-tab combination visible:
    // one chip per pick (screen + camera) before confirming.
    const chipKinds = await app.stream.selectionChipKinds();
    assert.deepEqual(
      chipKinds.toSorted(),
      ["device", "screen"],
      `picker selection chips should show both picks, got [${chipKinds.join(", ")}]`,
    );

    await app.stream.confirmPicker();

    await delay(2000);
    assert.ok(
      await app.stream.appAlive(),
      "app crashed starting the combined screen+camera broadcast",
    );

    // Both pictures must arrive in the own loopback preview: the screen in
    // the main stream video, the camera in the picture-in-picture tile. Each
    // wait requires videoWidth > 0, i.e. that track actually decoded a frame -
    // proving BOTH tracks flow (a static desktop screen decodes too few
    // frames for a meaningful fps assertion, so presence is the guard).
    await app.stream.waitOwnPreview();
    await app.stream.waitCameraPip(true);

    // The share must also show its stats for BOTH tracks (screen + camera).
    const rows = await app.stream.statsResolutionCount();
    assert.equal(rows, 2, `stats panel should report both tracks, saw ${rows} resolution row(s)`);

    await app.stream.stopBroadcast();
    assert.ok(await app.stream.appAlive(), "app crashed stopping the combined share");
  });

  it("a running camera share can be EXTENDED with the screen from the viewer controls", async (t) => {
    // Start a camera-only share.
    const titles = await app.stream.openPickerDevices();
    if (titles.length === 0) {
      t.skip("no camera devices on this machine");
      return;
    }
    const camera = titles.find((x) => /virtual/i.test(x)) ?? titles[0]!;
    await app.stream.confirmDevice(camera);
    await app.stream.waitOwnPreview();

    // The own-stream control bar (stats / popout row) must offer an "add
    // screen" shortcut; it reopens the picker SEEDED with the live camera.
    await app.stream.clickAddSource();
    const seeded = await app.stream.selectionChipKinds();
    assert.deepEqual(
      seeded,
      ["device"],
      `picker should open pre-seeded with the live camera, got [${seeded.join(", ")}]`,
    );

    // Add a screen and confirm: the share must now carry BOTH tracks
    // (screen in the main video, the camera moved to the PiP tile).
    await app.stream.pickSource("screens");
    await app.stream.confirmPicker();
    await app.stream.waitOwnPreview();
    await app.stream.waitCameraPip(true);

    // The header share button stays visible while broadcasting (so sources
    // can be changed/added mid-share) - it must NOT be hidden.
    assert.ok(
      await app.stream.headerShareTogglePresent(),
      "header share button must stay visible while broadcasting",
    );

    // The camera PiP × ends just the camera track: the screen keeps sharing,
    // the PiP disappears.
    await app.stream.endCameraViaPip();
    assert.ok(await app.stream.appAlive(), "app crashed ending the camera track");
    await app.stream.waitOwnPreview();

    await app.stream.stopBroadcast();
    assert.ok(await app.stream.appAlive(), "app crashed stopping the extended share");
  });

  it("the panel stop button ends only the screen while the camera keeps streaming", async (t) => {
    const titles = await app.stream.openPickerDevices();
    if (titles.length === 0) {
      t.skip("no camera devices on this machine");
      return;
    }
    const camera = titles.find((x) => /virtual/i.test(x)) ?? titles[0]!;

    // Share screen + camera together.
    await app.stream.pickSource("screens");
    await app.stream.pickSource("devices", camera);
    await app.stream.confirmPicker();
    await app.stream.waitOwnPreview();
    await app.stream.waitCameraPip(true);

    // One click of the panel × drops the SCREEN only: the broadcast stays
    // live (the camera is promoted from the PiP to the main video), so the
    // own preview is still mounted and the PiP is gone.
    await app.stream.clickPanelStopOnce();
    await delay(2000);
    assert.ok(await app.stream.appAlive(), "app crashed ending the screen track");
    assert.ok(
      await app.stream.ownPreviewPresent(),
      "one stop-click ended the WHOLE broadcast - it should have kept the camera",
    );
    await app.stream.waitOwnPreview(); // camera now the main video
    await app.stream.waitForCameraPipGone();

    // The stats panel must drop the ended screen track: only the (camera)
    // track remains, not a stale screen entry with its old resolution.
    const rowsAfter = await app.stream.statsResolutionCount();
    assert.equal(
      rowsAfter,
      1,
      `stats should list only the remaining camera track, saw ${rowsAfter} resolution row(s)`,
    );
    await app.stream.closeStats();

    // A second click now stops the remaining (camera-only) broadcast entirely.
    await app.stream.clickPanelStopOnce();
    await delay(1500);
    assert.ok(
      !(await app.stream.ownPreviewPresent()),
      "second stop-click should end the camera-only broadcast",
    );
    assert.ok(await app.stream.appAlive(), "app crashed stopping the camera-only share");
  });
});
