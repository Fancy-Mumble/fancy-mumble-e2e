import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";
import { CheckerboardWindow } from "../util/checkerboard";
import { captureEnv } from "../util/capture-env";
import { desktopAudioShareUnavailable } from "../util/preconditions";
import { TID } from "../selectors";
import { By, until } from "selenium-webdriver";

/**
 * Desktop audio: what the sharer's speakers play must reach a viewer.
 *
 * The capture is the default sink's MONITOR, so the suite plays a tone into
 * that sink for the duration - silence would pass against a pipeline that
 * captures nothing (or, worse, captures the microphone, which is what the
 * `stream.capture.sink` property exists to prevent).
 *
 * What it proves, in order: the broadcaster negotiates a PipeWire capture,
 * Opus reaches the SFU and is forwarded on the audio mid, the viewer decodes
 * it, and the decoded frames land in the voice mixer's playout buffer - the
 * last step needs voice enabled on the viewer, since that mixer is what
 * plays a stream out.
 */
describe("multi-client: shared desktop audio", { skip: desktopAudioShareUnavailable() }, () => {
  let alice: TauriApp; let bob: TauriApp; let board: CheckerboardWindow;
  let tone: ReturnType<typeof spawn> | undefined;
  const suffix = String(Date.now() % 1000000);
  const aliceName = `e2e-AudA-${suffix}`; const bobName = `e2e-AudB-${suffix}`;
  const title = `fancy-e2e-aud-${suffix}`;

  before(async () => {
    board = await CheckerboardWindow.launch({ title, phase: 0, animateMs: 50, cols: 8, rows: 6, cell: 64, x: 80, y: 80 });
    [alice, bob] = await TauriApp.launchAll({ instance: 0, extraEnv: captureEnv() }, { instance: 1, extraEnv: captureEnv() });
    await alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);
    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);
    await alice.enableFileLogging();
  });

  after(async () => {
    tone?.kill();
    board?.close();
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("carries the sink monitor's audio to a viewer and into its playout buffer", async () => {
    // A tone on the default sink for the whole run: the capture is that
    // sink's monitor, so silence would prove nothing.
    tone = spawn("pw-play", ["--volume", "0.2", process.env.FANCY_TEST_TONE ?? "/tmp/claude-1000/tone.wav"], { stdio: "ignore" });
    await alice.stream.shareWindow(title);

    // Turn desktop audio on the way a user does: the live config menu.
    const menu = await alice.driver.wait(until.elementLocated(By.css(`[data-testid="${TID.streamConfigMenu}"]`)), 10000);
    await menu.click();
    const toggle = await alice.driver.wait(until.elementLocated(By.css(`[data-testid="${TID.streamShareAudioToggle}"]`)), 10000);
    await toggle.click();
    await delay(1500);

    // The mixer only exists once voice is on: that is what plays stream
    // audio out, so without it the decode path has nowhere to put frames.
    await bob.invoke("enable_voice_muted").catch(() => {});
    await bob.stream.watchByName(aliceName);
    const session = await bob.driver.executeScript<number>(
      `const el = document.querySelector('[data-testid="stream-native-view"][data-own="false"]');
       return el ? Number(el.getAttribute('data-session')) : -1;`,
    );
    assert.ok(session > 0, `no remote surface to read a session from (got ${session})`);

    let packets = 0; let playout: unknown = null;
    for (let i = 0; i < 20; i++) {
      await delay(1000);
      const stats = await bob.invoke<{ audio: { packetsReceived: number } | null }>("native_stream_view_stats", { session });
      packets = stats?.audio?.packetsReceived ?? 0;
      playout = await bob.invoke("native_stream_audio_playout", { session });
      if (packets > 0 && playout !== null) break;
    }
    console.log(`AUDIO packets=${packets} playout=${JSON.stringify(playout)}`);
    assert.ok(packets > 0, "the viewer received no Opus packets from the SFU");
    assert.ok(
      playout !== null,
      "the decoded audio never reached the viewer's playout buffer " +
        "(the mixer had nothing for this stream)",
    );
    await alice.stream.stopBroadcastIfActive();
  });
});
