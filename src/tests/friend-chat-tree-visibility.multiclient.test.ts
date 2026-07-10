import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Friend-chat self-notepad must not hide you from the channel list - regression
 * guard.
 *
 * A friend chat / self-notepad is a detached, Fancy-only `__dm:` channel (E2E +
 * persisted) that the tree *and* the meetings viewer omit. Opening it must NOT
 * pull you out of your current channel into that hidden room: the client now
 * *peeks* (reads history + passes the key challenge without joining), so you stay
 * in root and visible. As a backstop, any user still sitting in a `__dm:` room is
 * re-attributed to root for the tree. Either way, opening your self-notepad must
 * never make you vanish from the channel list (the vanilla client, which can't
 * see the detached room, simply roots you).
 *
 * Asserted against the CHANNEL TREE (`waitForChannelViewMember`), not the
 * members roster: the roster lists you online regardless of channel, so it stays
 * green through the bug. Only a row rendered *under a channel* proves visibility.
 *
 * Needs the `mumble-friends` plugin to provision the self channel
 * (mumble-server:dev).
 */
describe("friend chat: opening your self-notepad keeps you in the channel list", () => {
  let admin: TauriApp;

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
    await Promise.allSettled([admin?.close()]);
  });

  it("still shows the local user under the root channel after joining the self-notepad", async () => {
    // Baseline: sitting in root, the user renders under a channel in the tree.
    await admin.sidebar.waitForChannelViewMember("SuperUser");

    // Open the self-chat: "yourself" is listed in the friends list under your own
    // name; the fancy-friends plugin provisions + joins us into our detached
    // __dm: self-notepad channel (the E2E badge confirms the upgrade landed).
    await admin.friends.open();
    await admin.friends.clickFriend("SuperUser");
    await admin.chat.waitForE2EBadge();

    // Back on the channel view, we must NOT have vanished: a user sitting in
    // their __dm: room is re-attributed to root for the tree. This times out
    // (the row never renders under a channel) when the bug is present.
    await admin.sidebar.goToChannels();
    await admin.sidebar.waitForChannelViewMember("SuperUser");
  });
});
