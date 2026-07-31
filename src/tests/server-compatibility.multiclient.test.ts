import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";

/**
 * Server rewrite contract tests.
 *
 * These deliberately exercise the boring-but-dangerous edges of the core
 * control path: three-way fan-out, unusual UTF-8 payloads, a large payload,
 * and reconnecting one member while the channel remains active. They are kept
 * at the UI/E2E boundary so a replacement server is tested through the same
 * client protocol and event ordering as the current implementation.
 */
describe("server compatibility: control-path boundaries", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  let carol: TauriApp;

  const suffix = Date.now() % 1_000_000;
  const aliceName = `e2e-compat-A-${suffix}`;
  const bobName = `e2e-compat-B-${suffix}`;
  const carolName = `e2e-compat-C-${suffix}`;

  before(async () => {
    [alice, bob, carol] = await Promise.all([
      TauriApp.launch({ instance: 0 }),
      TauriApp.launch({ instance: 1 }),
      TauriApp.launch({ instance: 2 }),
    ]);

    await Promise.all([
      alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
      carol.connect.connect(config.serverHost, carolName, { port: config.serverPort }),
    ]);
    await Promise.all([
      alice.chat.waitLoaded(),
      bob.chat.waitLoaded(),
      carol.chat.waitLoaded(),
    ]);
    await Promise.all([
      alice.chat.waitForMember(bobName),
      alice.chat.waitForMember(carolName),
      bob.chat.waitForMember(aliceName),
      carol.chat.waitForMember(aliceName),
    ]);
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close(), carol?.close()]);
  });

  it("fans out every message exactly once to all three connected clients", async () => {
    const messages = Array.from({ length: 8 }, (_, i) => `e2e-fanout-${suffix}-${i}`);

    for (const message of messages) {
      await alice.chat.sendMessage(message);
      await Promise.all([
        alice.chat.waitForText(message),
        bob.chat.waitForText(message),
        carol.chat.waitForText(message),
      ]);
    }

    // "Exactly once" is per message, not per sender label. The label is
    // rendered only for the first message of a consecutive same-sender group
    // (`MessageItem`'s `isFirstInGroup`, documented on `chatMessageSender` in
    // the client's testids), so eight messages in a row from Alice produce one
    // label and counting them measured grouping rather than fan-out.
    for (const message of messages) {
      await Promise.all([
        bob.chat.waitForExactlyOnce(message),
        carol.chat.waitForExactlyOnce(message),
      ]);
    }
  });

  it("preserves UTF-8, line breaks, markup-looking text, and a large message", async () => {
    const corpus = [
      `e2e-utf8-${suffix}-\u00e4\u00f6\u00fc-\u4f60\u597d-\u041f\u0440\u0438\u0432\u0435\u0442-\u0645\u0631\u062d\u0628\u0627-\u05e9\u05dc\u05d5\u05dd-\u{1f469}\u{1f3fd}\u200d\u{1f4bb}`,
      `e2e-lines-${suffix}-first\nsecond\nthird`,
      `e2e-markup-${suffix}-<b>not html</b> & <script>not code</script>`,
      `e2e-large-${suffix}-` + "x".repeat(4096),
    ];

    for (const message of corpus) {
      const marker = message.slice(0, Math.min(message.length, 48));
      await alice.chat.sendMessage(message);
      await Promise.all([
        alice.chat.waitForText(marker),
        bob.chat.waitForText(marker),
        carol.chat.waitForText(marker),
      ]);
    }
  });

  it("lets one member reconnect without losing the remaining channel fan-out", async () => {
    await bob.chat.disconnect();
    await bob.connect.waitReady(config.connectTimeout);

    await alice.chat.waitForMemberGone(bobName);
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await bob.chat.waitLoaded();
    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);

    const beforeReconnect = `e2e-reconnect-before-${suffix}`;
    await alice.chat.sendMessage(beforeReconnect);
    await Promise.all([
      alice.chat.waitForText(beforeReconnect),
      carol.chat.waitForText(beforeReconnect),
      bob.chat.waitForText(beforeReconnect),
    ]);

    // Exercise the opposite direction after the reconnect as well. This
    // catches servers that restore presence but fail to restore the session's
    // outbound message path.
    const afterReconnect = `e2e-reconnect-after-${suffix}`;
    await bob.chat.sendMessage(afterReconnect);
    await Promise.all([
      alice.chat.waitForText(afterReconnect),
      carol.chat.waitForText(afterReconnect),
      bob.chat.waitForText(afterReconnect),
    ]);

    // Give delayed UserRemove/UserState events time to settle; the assertions
    // above must not pass because a stale row was retained indefinitely.
    await delay(300);
    assert.equal(
      await alice.chat.messageCountFrom(bobName),
      1,
      "reconnected sender's message was duplicated or delivered out-of-band",
    );
  });
});
