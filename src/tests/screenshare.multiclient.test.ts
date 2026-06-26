import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { CheckerboardWindow } from "../util/checkerboard";

/**
 * Screen-share fidelity across two clients, end-to-end, through the new
 * Rust-native capture + WebRTC broadcaster (no browser getDisplayMedia).
 *
 * Each client shares a deterministic green/purple checkerboard *window*
 * (a Tk helper, distinct phase per client) and we read the decoded stream
 * `<video>` pixels back on the receiving side. We assert the recovered frame
 * is a checkerboard whose cells fall into the right hue classes and whose
 * phase matches the source - never exact RGB, because VP8 is lossy.
 *
 * Covers the three things asked for:
 *   1. Screen sharing still works (a broadcast starts and decodes).
 *   2. Two clients see the SAME window (Alice's own loopback == Bob's remote
 *      view of Alice, both green-first).
 *   3. Each client sees its OWN window (Alice green-first, Bob purple-first).
 *
 * Requirements: a Fancy server with the WebRTC SFU enabled, and a real display
 * for OS window capture (headed Windows session, or Xvfb on Linux). The Tk
 * helper needs python + Tkinter (Linux: `apt-get install python3-tk`).
 */
describe("multi-client: screen sharing (checkerboard pixel fidelity)", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  let aliceBoard: CheckerboardWindow;
  let bobBoard: CheckerboardWindow;

  const suffix = String(Date.now() % 1000000);
  const aliceName = `e2e-Alice-${suffix}`;
  const bobName = `e2e-Bob-${suffix}`;
  // Unique titles so the picker's Window tab can match exactly, even with
  // leftover windows from a previous run on the same desktop.
  const aliceTitle = `fancy-e2e-checker-A-${suffix}`;
  const bobTitle = `fancy-e2e-checker-B-${suffix}`;

  before(async () => {
    // Distinct phase => inverted boards we can tell apart; distinct positions
    // so the two helper windows don't overlap on the shared desktop.
    [aliceBoard, bobBoard] = await Promise.all([
      CheckerboardWindow.launch({ title: aliceTitle, phase: 0, x: 80, y: 80 }),
      CheckerboardWindow.launch({ title: bobTitle, phase: 1, x: 560, y: 80 }),
    ]);

    // captureWindowTitle lets the *current* build's native getDisplayMedia
    // picker be auto-resolved to each client's own checkerboard window; the new
    // Rust picker ignores it and is driven through the DOM instead.
    alice = await TauriApp.launch({ instance: 0, captureWindowTitle: aliceTitle });
    bob = await TauriApp.launch({ instance: 1, captureWindowTitle: bobTitle });

    await alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });

    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);

    // Both in the same (root) channel and able to see each other before sharing.
    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);
  });

  after(async () => {
    aliceBoard?.close();
    bobBoard?.close();
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("Alice shares her window; her own preview decodes to her checkerboard", async () => {
    await alice.stream.shareWindow(aliceTitle);
    const own = await alice.stream.waitCheckerboard(true, aliceBoard.cols, aliceBoard.rows);
    assert.ok(own.checkerboard, `Alice's own preview is not a checkerboard: ${JSON.stringify(own)}`);
    assert.equal(own.phase, 0, "Alice's board must be green-first (phase 0)");
  });

  it("Bob sees Alice's shared window faithfully (same board)", async () => {
    await bob.stream.watchByName(aliceName);
    const remote = await bob.stream.waitCheckerboard(false, aliceBoard.cols, aliceBoard.rows);
    assert.ok(remote.checkerboard, `Bob's view of Alice is not a checkerboard: ${JSON.stringify(remote)}`);
    // Same window => same phase as Alice's own preview (green-first), proving
    // both clients see identical content, not their own.
    assert.equal(remote.phase, 0, "Bob must see Alice's green-first board");
    assert.ok(remote.greenCount > 0 && remote.purpleCount > 0, "both colours must be present");
  });

  it("each client sees its own window (distinct phases)", async () => {
    // Bob now shares his own (purple-first) board.
    await bob.stream.shareWindow(bobTitle);
    const bobOwn = await bob.stream.waitCheckerboard(true, bobBoard.cols, bobBoard.rows);
    assert.ok(bobOwn.checkerboard, `Bob's own preview is not a checkerboard: ${JSON.stringify(bobOwn)}`);
    assert.equal(bobOwn.phase, 1, "Bob's board must be purple-first (phase 1)");

    // Alice watches Bob and must see Bob's purple-first board - distinct from
    // her own green-first one, proving each client transmits its own window.
    await alice.stream.watchByName(bobName);
    const aliceViewOfBob = await alice.stream.waitCheckerboard(false, bobBoard.cols, bobBoard.rows);
    assert.ok(aliceViewOfBob.checkerboard, `Alice's view of Bob is not a checkerboard: ${JSON.stringify(aliceViewOfBob)}`);
    assert.equal(aliceViewOfBob.phase, 1, "Alice must see Bob's purple-first board");
  });
});
