import { describe, it, before, after } from "node:test";
import { until } from "selenium-webdriver";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { byTid, TID } from "../selectors";

/**
 * A send the client cannot make must say so.
 *
 * `send_message` rejects before it sends anything when the channel's message
 * cannot be encrypted, and the frontend used to record that only for bodies
 * carrying an optimistic upload placeholder - inline media, or something large.
 * An ordinary line of text went to `console.error` and nowhere else: the
 * composer emptied, no message appeared, and the user was told nothing. That is
 * how a missing channel key read as "the server ate my message".
 *
 * The vehicle here is a full-archive room being *read* rather than joined,
 * which is a send with no key by construction: the key is minted on the way
 * into a room, and minting one for a room we are not in would invent a key
 * rival to whatever its members already hold. What is under test is not that
 * this particular send fails - it is that a failed send is visible and
 * retryable rather than silent.
 */
describe("chat: a send that cannot be made is reported", () => {
  let admin: TauriApp;
  const channelName = `e2e-sendfail-${Date.now() % 1000000}`;

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

  it("shows the reason instead of dropping the message", async () => {
    await admin.sidebar.createSubChannel(0, channelName, {
      pchatProtocol: "fancy_v1_full_archive",
    });
    await admin.sidebar.waitForChannel(channelName);
    await admin.sidebar.selectChannel(channelName);

    await admin.chat.composer.send(`e2e-sendfail-msg-${Date.now()}`);

    await admin.driver.wait(
      until.elementLocated(byTid(TID.chatSendFailed)),
      15000,
      "a failed send left no trace in the UI",
    );
  });
});
