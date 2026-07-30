import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/** Persistent-chat control messages: pin state and read-watermark delivery. */
describe("persistent chat control messages", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  const channelName = `e2e-pchat-controls-${Date.now() % 1000000}`;
  const bobName = `e2e-pchat-reader-${Date.now() % 100000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    alice = await TauriApp.launch({ instance: 0 });
    bob = await TauriApp.launch({ instance: 1 });
    await alice.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);
    await alice.sidebar.createSubChannel(0, channelName, { pchatProtocol: "fancy_v1_full_archive" });
    await alice.sidebar.waitForChannel(channelName);
    await bob.sidebar.waitForChannel(channelName);
    await alice.sidebar.joinChannel(channelName);
    await bob.sidebar.joinChannel(channelName);
    await alice.chat.waitForMember(bobName);
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("pins and unpins a persisted message and exposes it in the pin panel", async () => {
    const token = `pinned-control-${Date.now()}`;
    await alice.chat.sendMessage(token);
    await alice.chat.waitForText(token);
    await alice.chat.togglePin(token);
    await alice.chat.openPinnedMessages();
    await alice.chat.waitForText(token);
    await alice.chat.togglePin(token);
  });

  it("delivers a read watermark back to the message author", async () => {
    const token = `receipt-control-${Date.now()}`;
    await alice.chat.sendMessage(token);
    await bob.chat.waitForText(token);
    await alice.chat.waitForReadReceipt(token, "Read");
  });
});
