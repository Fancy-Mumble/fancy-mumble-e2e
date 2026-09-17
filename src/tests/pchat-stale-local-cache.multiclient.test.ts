import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Turning a channel's persistence off has to reach the client, and has to
 * stop the history coming back.
 *
 * Reported from the live client: a channel whose messages are replayed on
 * reconnect, while its editor says "None (standard volatile chat)". Both
 * halves are here, because between them they are that report:
 *
 *  - the *switch off* is invisible on the wire. `ChannelState` carries
 *    `pchat_protocol` only when it is non-zero, and the client treats an
 *    absent field as "unchanged" - so the client that turned persistence off
 *    goes on showing the old protocol, while a client connecting afterwards
 *    is told nothing and shows "none". One channel, two answers.
 *  - the *history* comes back anyway. The client keeps an encrypted local
 *    cache of every Signal channel's plaintext and pours all of it into the
 *    message store on `ServerSync`, without asking what protocol those
 *    channels run now.
 *
 * So the client that reads "none" is the one that was told the truth, and the
 * restored messages are what makes it look like a lie.
 */
describe("persistent chat: turning a channel volatile", () => {
  let admin: TauriApp;
  const channelName = `e2e-stale-cache-${Date.now() % 1000000}`;
  const token = `e2e-stale-cache-msg-${Date.now()}`;
  /** What the editor showed in the session that performed the switch. */
  let liveProtocol = "";

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

  it("tells the client that turned it off", async () => {
    await admin.sidebar.createSubChannel(0, channelName, { pchatProtocol: "signal_v1" });
    await admin.sidebar.waitForChannel(channelName);
    await admin.sidebar.joinChannel(channelName);

    await admin.chat.composer.send(token);
    await admin.chat.messages.waitForText(token);

    await admin.sidebar.setChannelPchatProtocol(channelName, "none");
    liveProtocol = await admin.sidebar.channelPchatProtocol(channelName);

    await admin.chat.disconnect();
    await reconnect();
    await admin.sidebar.waitForChannel(channelName);
    await admin.sidebar.joinChannel(channelName);

    // A fresh login is the one moment the server states the protocol from
    // scratch, so this is what the server actually holds. Comparing the two
    // separates a refused write from an applied one nobody was told about.
    const freshProtocol = await admin.sidebar.channelPchatProtocol(channelName);
    assert.equal(freshProtocol, "none", "the server did not apply the switch to none");
    assert.equal(
      liveProtocol,
      freshProtocol,
      "the server applied the switch to none but the client that made it still " +
        "shows the old protocol, so one channel reads two different ways",
    );
  });

  it("stops replaying the cached history", async () => {
    // Runs against the state the previous test left: reconnected, rejoined,
    // and - by the server's account - volatile.
    assert.equal(
      await admin.sidebar.channelPchatProtocol(channelName),
      "none",
      "precondition: the channel is volatile as far as this session is told",
    );

    // Given time to arrive rather than sampled once: the cache is poured back
    // in on sync, so "it never showed up" has to outlast the window in which
    // it would have.
    let replayed = true;
    try {
      await admin.chat.messages.waitForText(token, 8000);
    } catch {
      replayed = false;
    }
    assert.equal(
      replayed,
      false,
      "a volatile channel replayed its old history out of the client's local cache, " +
        "so the chat says persistent while the editor says volatile",
    );
  });
});
