import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword, isServerRunning } from "../util/server";
import { delay } from "../util/wait";

/**
 * Admin "Channels / ACL" tab: deleting a detached (parentless) channel.
 *
 * Detached channels - meeting rooms, friend DM channels - have no parent, like
 * the root.  Removing one used to crash the server: `Server::removeChannel` fell
 * back to the (null) parent as the destination for displaced users and then
 * dereferenced it.  The ACL tree now lists these private channels and lets an
 * admin delete them, so this guards that the server survives it.
 *
 * Requires a server image with the `fancy-friends` plugin (to mint a detached
 * `__dm:` channel) + the crash fix (mumble-server:dev).
 */
describe("admin: deleting a detached channel does not crash the server", () => {
  let admin: TauriApp;
  // SuperUser is uid 0, so the self-chat channel is named `__dm:0`.
  const selfChannel = "__dm:0";

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

  it("deletes a detached __dm channel from the ACL tree without taking the server down", async () => {
    // Mint a detached, E2E channel by opening our own self-chat from Friends.
    // Retry: right after connect the friends plugin may not have mapped our
    // freshly-connected session yet, so the first open can no-op.
    await admin.friends.open();
    for (let attempt = 1; ; attempt++) {
      await admin.friends.clickFriend("SuperUser");
      try {
        await admin.chat.waitForE2EBadge(6000);
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await delay(2000);
      }
    }

    // It shows up in the admin ACL tree as a private channel; delete it there.
    await admin.admin.open();
    await admin.admin.openAclTab();
    await admin.admin.waitForAclChannel(selfChannel);
    await admin.admin.deleteAclChannel(selfChannel);

    // The channel disappearing means the server processed the removal + broadcast
    // it - i.e. it did not crash partway through removeChannel.
    await admin.admin.waitForAclChannelGone(selfChannel);

    // And the container's main process is still up (definitive no-crash check).
    assert.equal(isServerRunning(), true, "server crashed while deleting a detached channel");
  });
});
