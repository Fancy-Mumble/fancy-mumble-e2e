import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { delay } from "../util/wait";
import { pluginMissing } from "../util/preconditions";

/**
 * Friend chats backed by E2E persisted channels.
 *
 * A direct message between two *registered* users is upgraded by the server-side
 * `fancy-friends` plugin into a detached, end-to-end-encrypted (`signal_v1`),
 * persisted channel (`__dm:<lo>-<hi>`): the client requests it on opening the
 * chat (`friends.open`) and switches into it on `friends.room`. The chat header's
 * E2E badge is the user-visible signal that the upgrade happened. When the peer
 * isn't registered, no channel is provisioned and the chat stays a classic DM
 * (no badge).
 *
 * Requires a server image with the `mumble-friends` plugin + a client with the
 * friend-chat routing (mumble-server:dev).
 */
describe("friend chats: E2E persisted channels for registered users", { skip: pluginMissing("fancy-friends") }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-bob-${sfx}`;
  const guestName = `e2e-guest-${sfx}`;
  let guest: TauriApp;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    bob = await TauriApp.launch({ instance: 1 });
    guest = await TauriApp.launch({ instance: 2 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await guest.connect.connect(config.serverHost, guestName, { port: config.serverPort });
    await admin.chat.waitLoaded();
    await bob.chat.waitLoaded();
    await guest.chat.waitLoaded();
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close(), guest?.close()]);
  });

  it("upgrades a DM between two registered users to an E2E persisted channel", async () => {
    // admin (SuperUser, registered) needs bob registered too for an E2E channel.
    await admin.chat.waitForMember(bobName);
    await admin.sidebar.registerUser(bobName);
    await admin.chat.waitForRegistered(bobName);

    // Opening the DM triggers the fancy-friends plugin to provision (and admit
    // both to) the detached signal_v1 channel; the client switches into it.
    await admin.chat.openDirectMessage(bobName);
    await admin.chat.waitForE2EBadge();

    // Add bob as a friend now (while we're in the main view + he's online) so a
    // later subtest can open his chat from the Friends page after he goes offline.
    await admin.chat.addFriend(bobName);
  });

  it("keeps a DM with an unregistered user as a classic (non-E2E) chat", async () => {
    // The guest is never registered, so no channel can be provisioned; the chat
    // stays a classic direct message - no E2E badge.
    await admin.chat.waitForMember(guestName);
    await admin.chat.openDirectMessage(guestName);
    // Settle so any (incorrect) upgrade would have landed, then assert no badge.
    await delay(2500);
    assert.equal(
      await admin.chat.hasE2EBadge(),
      false,
      "a DM with an unregistered user must stay a classic (non-E2E) chat",
    );
  });

  it("opens a self-chat (yourself in the friends list) as an E2E persisted channel", async () => {
    // admin (SuperUser) is registered + the plugin is present, so "yourself"
    // appears in the friends list under your own name; clicking it opens our own
    // detached signal channel - a private notepad that behaves like any friend.
    await admin.friends.open();
    await admin.friends.clickFriend("SuperUser");
    // The embedded chat shows the self channel - the E2E badge confirms it is an
    // end-to-end-encrypted persisted channel (not a classic note store).
    await admin.chat.waitForE2EBadge();
    // The self-chat is labelled with our own name (it behaves like any friend),
    // not a special "Notepad" header.
    const title = await admin.chat.headerTitle();
    assert.ok(
      title.includes("SuperUser") && !/notepad/i.test(title),
      `self-chat header should show the own name, got "${title}"`,
    );
  });

  it("starts a persisted E2E chat with an OFFLINE friend on a connected server", async () => {
    // bob is a registered friend (added in subtest 1, capturing his uid + server
    // target while online).  Take him offline.
    await bob.close();
    // On the Friends page bob now shows offline...
    await admin.friends.open();
    await admin.friends.waitForFriendOffline(bobName);
    // ...yet we can still open the chat - it's a persisted, end-to-end-encrypted
    // channel - and write to it; the server holds the messages for bob until he
    // reconnects (when the history is replayed to him).
    await admin.friends.clickFriend(bobName);
    await admin.chat.waitForE2EBadge();
    await admin.chat.sendMessage("hi while you were away");
    await admin.chat.waitForMessageFrom("SuperUser");
  });
});
