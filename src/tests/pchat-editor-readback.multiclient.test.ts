import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * The channel editor must open on the persistence protocol the channel
 * actually runs.
 *
 * Reported from the live client: a channel whose history is replayed on
 * rejoin - so it is demonstrably persistent - still opens its editor on
 * "None (standard volatile chat)". That is not only a wrong label. The editor
 * diffs every other field against the channel but sends `pchat_protocol`
 * unconditionally, so saving an unrelated edit (a rename, a description) on a
 * channel the dialog mis-read writes persistence *off*.
 *
 * Every mode is covered because they reach the channel record by different
 * routes (a client-set protocol, a server-held one), and both ways of turning
 * a channel persistent are: at creation, and on an existing channel - the
 * second is the one a user actually performs, and it is a different code path
 * on the server (a field delta, not a fresh record).
 *
 * Each case also checks after a disconnect + reconnect, in the same breath as
 * the replayed message, which is what catches the login announcement dropping
 * `pchat_protocol` while history still works.
 */
const PROTOCOLS = ["fancy_v1_full_archive", "server_managed", "signal_v1"] as const;

describe("persistent chat: the editor opens on the channel's real protocol", () => {
  let admin: TauriApp;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    await reconnect();
  });

  after(async () => {
    await admin?.close();
  });

  async function reconnect(): Promise<void> {
    await admin.connect.waitReady(config.connectTimeout);
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();
  }

  for (const protocol of PROTOCOLS) {
    it(`reads back ${protocol} on a channel created with it`, async () => {
      const name = `e2e-rb-new-${protocol.slice(0, 6)}-${Date.now() % 1000000}`;
      await admin.sidebar.createSubChannel(0, name, { pchatProtocol: protocol });
      await admin.sidebar.waitForChannel(name);
      await admin.sidebar.joinChannel(name);

      assert.equal(
        await admin.sidebar.channelPchatProtocol(name),
        protocol,
        "the editor opened on the wrong protocol for a channel just created with it",
      );

      const token = `e2e-rb-new-msg-${Date.now()}`;
      await admin.chat.composer.send(token);
      await admin.chat.messages.waitForText(token);

      await admin.chat.disconnect();
      await reconnect();

      await admin.sidebar.waitForChannel(name);
      await admin.sidebar.joinChannel(name);
      // Replayed history is the proof the channel *is* persistent; whatever the
      // editor says next has to agree with it.
      await admin.chat.messages.waitForText(token, 20000);

      assert.equal(
        await admin.sidebar.channelPchatProtocol(name),
        protocol,
        "history replayed, so the channel is persistent - but the editor says otherwise",
      );
    });

    it(`reads back ${protocol} on a channel switched to it afterwards`, async () => {
      const name = `e2e-rb-set-${protocol.slice(0, 6)}-${Date.now() % 1000000}`;
      await admin.sidebar.createSubChannel(0, name);
      await admin.sidebar.waitForChannel(name);
      await admin.sidebar.joinChannel(name);

      await admin.sidebar.setChannelPchatProtocol(name, protocol);

      assert.equal(
        await admin.sidebar.channelPchatProtocol(name),
        protocol,
        "the editor opened on the wrong protocol right after the switch was saved",
      );

      const token = `e2e-rb-set-msg-${Date.now()}`;
      await admin.chat.composer.send(token);
      await admin.chat.messages.waitForText(token);

      await admin.chat.disconnect();
      await reconnect();

      await admin.sidebar.waitForChannel(name);
      await admin.sidebar.joinChannel(name);
      await admin.chat.messages.waitForText(token, 20000);

      assert.equal(
        await admin.sidebar.channelPchatProtocol(name),
        protocol,
        "history replayed, so the channel is persistent - but the editor says otherwise",
      );
    });
  }
});
