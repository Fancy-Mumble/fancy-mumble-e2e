import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";

/** 👍 - the first QUICK_REACTIONS emoji (single code point, stable to match). */
const LIKE = "👍";

/**
 * Reactions round-trip through the server: Alice reacts to a message and the
 * pill must appear on Bob's copy of that message too.
 */
describe("reactions: cross-client", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  const aliceName = `e2e-A-${Date.now() % 100000}`;
  const bobName = `e2e-B-${Date.now() % 100000}`;

  before(async () => {
    [alice, bob] = await TauriApp.launchAll({ instance: 0 }, { instance: 1 });
    await Promise.all([
      alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);
    await Promise.all([alice.chat.waitLoaded(), bob.chat.waitLoaded()]);
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("a reaction Alice adds appears on Bob's copy of the message", async () => {
    const token = `e2e-react-${Date.now()}`;
    await alice.chat.sendMessage(token);
    await alice.chat.waitForText(token);
    await bob.chat.waitForText(token);

    await alice.chat.reactToMessage(token, LIKE);
    await alice.chat.waitForReaction(LIKE);
    await bob.chat.waitForReaction(LIKE);
  });
});
