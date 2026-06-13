import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Persistent chat: a message sent in a pchat-enabled channel must survive a
 * disconnect + reconnect (the server stores and replays channel history).
 *
 * Persistence is per-channel (the root channel has no pchat protocol), so the
 * admin (SuperUser) first creates a full-archive channel. Disconnect resets the
 * client store, so finding the message again after rejoining proves the server
 * replayed it. Same-user reconnect keeps the isolated profile/keys, so the
 * replayed history is decryptable.
 */
describe("persistent chat: history replay in a pchat channel", () => {
  let admin: TauriApp;
  const channelName = `e2e-pchat-${Date.now() % 1000000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();
  });

  after(async () => {
    await admin?.close();
  });

  it("replays a message after disconnect + reconnect", async () => {
    await admin.sidebar.createSubChannel(0, channelName, {
      pchatProtocol: "fancy_v1_full_archive",
    });
    await admin.sidebar.waitForChannel(channelName);
    await admin.sidebar.joinChannel(channelName);

    const token = `e2e-pchat-msg-${Date.now()}`;
    await admin.chat.sendMessage(token);
    await admin.chat.waitForText(token);

    await admin.chat.disconnect();
    await admin.connect.waitReady(config.connectTimeout);
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();

    // The store was reset on disconnect; rejoin the channel and the message must
    // be replayed from the server's persisted history.
    await admin.sidebar.waitForChannel(channelName);
    await admin.sidebar.joinChannel(channelName);
    await admin.chat.waitForText(token, 20000);
  });
});
