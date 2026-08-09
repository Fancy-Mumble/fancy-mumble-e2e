import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";

/**
 * Source-driven coverage for Fancy handlers that were previously represented
 * only by client unit tests. These assertions intentionally use two real
 * clients and the live server connection: delivery, actor stamping, channel
 * routing and the client reducer all have to work together.
 */
describe("Fancy control-plane fan-out", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  const aliceName = `e2e-control-a-${Date.now() % 100000}`;
  const bobName = `e2e-control-b-${Date.now() % 100000}`;

  before(async () => {
    [alice, bob] = await TauriApp.launchAll({ instance: 0 }, { instance: 1 });
    await Promise.all([
      alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);
    await Promise.all([
      alice.chat.waitLoaded(config.connectTimeout),
      bob.chat.waitLoaded(config.connectTimeout),
    ]);
    await Promise.all([
      alice.chat.waitForMember(bobName),
      bob.chat.waitForMember(aliceName),
    ]);
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("relays typing indicators with the correct actor and channel", async () => {
    await alice.chat.typeMessage(`typing-${Date.now()}`);
    await bob.chat.waitForText(`${aliceName} is typing`, 10000);
  });

  it("creates and delivers a poll through FancyPoll", async () => {
    const question = `control-poll-${Date.now()}`;
    await alice.chat.createPoll(question, ["first", "second"], true);
    await bob.chat.waitForText(question, 15000);
    await bob.chat.waitForText("first", 15000);
    await bob.chat.waitForText("second", 15000);
    await bob.chat.votePoll(question, "first");
    await alice.chat.waitForText("1 vote", 15000);
  });
});
