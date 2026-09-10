import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { bridgeMissing } from "../util/preconditions";

/**
 * Turning encryption ON for a channel the sender is already standing in.
 *
 * Our own signal_v1 sender key is created by `create_distribution`, and every
 * call site of it used to hang off a channel *move*: the join path, the remote
 * move path, and the landing channel at connect. A room that became encrypted
 * while we were already in it is never moved into, so no sender key was ever
 * minted - `group_encrypt` then failed with "missing sender key state for
 * distribution ID ...", `send_message` returned that error before sending
 * anything, and Nebula showed neither the message nor the reason.
 *
 * Reconnecting cleared it, because reconnecting is a join. This test is the
 * form the bug was reported in: change the mode, keep the connection, send.
 */
describe("signal pchat: encryption turned on under a sitting member", { skip: bridgeMissing() }, () => {
  let admin: TauriApp;
  const channelName = `e2e-sigmode-${Date.now() % 1000000}`;

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

  it("sends without a reconnect after the channel is switched to signal_v1", async () => {
    // A plain channel, joined while it is still plain.
    await admin.sidebar.createSubChannel(0, channelName);
    await admin.sidebar.waitForChannel(channelName);
    await admin.sidebar.joinChannel(channelName);

    const plain = `e2e-sigmode-plain-${Date.now()}`;
    await admin.chat.composer.send(plain);
    await admin.chat.messages.waitForText(plain);

    // Now turn encryption on underneath ourselves, without leaving.
    await admin.sidebar.setChannelPchatProtocol(channelName, "signal_v1");
    await admin.chat.header.waitForE2EBadge();
    assert.equal(
      await admin.sidebar.isJoinedChannel(channelName),
      true,
      "precondition: the mode change must happen without leaving the channel",
    );

    const token = `e2e-sigmode-msg-${Date.now()}`;
    await admin.chat.composer.send(token);
    await admin.chat.messages.waitForText(token, 15000);
  });
});
