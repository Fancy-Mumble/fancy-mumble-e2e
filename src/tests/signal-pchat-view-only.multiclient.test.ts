import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { bridgeMissing } from "../util/preconditions";

/**
 * Sending into a signal_v1 channel that is *selected but not joined*.
 *
 * Nebula separates the two gestures: one click selects a channel and shows its
 * chat, a double-click moves the user into it. The composer is live either way,
 * so a message can be typed into a room the sender never entered - and for a
 * signal_v1 room that is the only path in which our own sender key was never
 * created, because every `create_distribution` call site hangs off a *voice*
 * move (`user_state::handle_own_channel_change`, `handle_remote_channel_move`,
 * `server_sync::resolve_initial_channel`).
 *
 * The send then fails inside the bridge with "missing sender key state for
 * distribution ID ...", `send_message` returns `Err` before it sends anything,
 * and the UI shows nothing at all: no message, no error.
 */
describe("signal pchat: sending from a selected-but-not-joined channel", { skip: bridgeMissing() }, () => {
  let admin: TauriApp;
  const channelName = `e2e-sigview-${Date.now() % 1000000}`;

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

  it("a message typed into a viewed encrypted room reaches the chat", async () => {
    await admin.sidebar.createSubChannel(0, channelName, { pchatProtocol: "signal_v1" });
    await admin.sidebar.waitForChannel(channelName);

    // Select only - no double-click, so the local user stays in root.
    await admin.sidebar.selectChannel(channelName);
    assert.equal(
      await admin.sidebar.isJoinedChannel(channelName),
      false,
      "precondition: the user must be viewing the channel, not standing in it",
    );

    const token = `e2e-sigview-msg-${Date.now()}`;
    await admin.chat.composer.send(token);
    await admin.chat.messages.waitForText(token, 10000);
  });
});
