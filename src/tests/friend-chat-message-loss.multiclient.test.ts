import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * 1:1 friend chat in the Friends list must not lose messages - regression guard.
 *
 * A friend chat between two registered users is a detached, E2E (signal_v1),
 * persisted channel that the client now *peeks* (reads without joining). A
 * peeking client is not a channel member, so it no longer receives the dual-path
 * plaintext `TextMessage` broadcast that channel membership used to provide - it
 * relies solely on the E2E pchat delivery, which only reaches key-verified
 * sessions. Any gap in that path drops the message outright.
 *
 * Driven entirely through the Friends list (FriendsPage embedded chat), which is
 * where the user hit the loss: both peers open each other's chat there and
 * exchange messages, and we assert every message reaches BOTH sides - including
 * after re-opening the chat (re-peek must not drop already-delivered history).
 *
 * Requires the `mumble-friends` plugin (mumble-server:dev).
 */
describe("friend chat (friends list) 1:1: no pchat message loss", () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-bob-${sfx}`;
  const ROUNDS = 4;
  const fromAdmin = (i: number) => `from-admin-${i}-${sfx}`;
  const fromBob = (i: number) => `from-bob-${i}-${sfx}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    bob = await TauriApp.launch({ instance: 1 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await admin.chat.waitLoaded();
    await bob.chat.waitLoaded();
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close()]);
  });

  it("delivers every message exchanged through the Friends list to both sides", async () => {
    // bob must be registered for an E2E friend channel; both add each other so
    // each can open the chat from their own Friends list.
    await admin.chat.waitForMember(bobName);
    await admin.sidebar.registerUser(bobName);
    await admin.chat.waitForRegistered(bobName);
    await admin.chat.addFriend(bobName);
    await bob.chat.waitForMember("SuperUser");
    await bob.chat.addFriend("SuperUser");

    // Both open the 1:1 friend chat from the Friends list (peek, not join).
    await admin.friends.open();
    await admin.friends.clickFriend(bobName);
    await admin.chat.waitForE2EBadge();
    await bob.friends.open();
    await bob.friends.clickFriend("SuperUser");
    await bob.chat.waitForE2EBadge();

    // Bidirectional exchange: each message must reach the other side. A drop in
    // the peek/verify gap surfaces here as a wait timeout.
    for (let i = 0; i < ROUNDS; i++) {
      await admin.chat.sendMessage(fromAdmin(i));
      await bob.chat.waitForText(fromAdmin(i));

      await bob.chat.sendMessage(fromBob(i));
      await admin.chat.waitForText(fromBob(i));
    }

    // Re-open admin's chat (leave to the channel view, back to Friends, reselect):
    // re-peeking an already-fetched channel must not drop the delivered history.
    await admin.sidebar.goToChannels();
    await admin.friends.open();
    await admin.friends.clickFriend(bobName);
    await admin.chat.waitForE2EBadge();

    // The whole exchange must still be present on BOTH sides (nothing lost).
    for (let i = 0; i < ROUNDS; i++) {
      for (const app of [admin, bob]) {
        await app.chat.waitForText(fromAdmin(i));
        await app.chat.waitForText(fromBob(i));
      }
    }
  });
});
