import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Root-channel visibility - regression guard.
 *
 * The server omits `channel_id` for users sitting in the root channel (id 0):
 * `serializeUserState` / the sync loop only set it when `cChannel->iId != 0`. So
 * a user in root arrives at the client channel-less. A presence-hiding mitigation
 * once inferred "channel-less => presence-hidden" and parked every such user in
 * the invisible sentinel channel - which swept *all* root occupants (and the
 * local user) out of the channel tree, making the root channel read as empty.
 *
 * Crucially this must be asserted against the CHANNEL TREE, not the members
 * roster: the roster lists a user as online regardless of channel, so it would
 * have stayed green through the bug. `waitForChannelViewMember` requires the row
 * to render *under a channel*.
 *
 * Pure client behaviour - passes against any server image with the fixed client.
 */
describe("root channel: occupants stay visible in the tree", () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-bob-${sfx}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    [admin, bob] = await TauriApp.launchAll({ instance: 0 }, { instance: 1 });
    await Promise.all([
      admin.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);
    await Promise.all([admin.chat.waitLoaded(), bob.chat.waitLoaded()]);
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close()]);
  });

  it("shows each user under the root channel to the other (root not emptied)", async () => {
    // Neither user has moved channels, so both sit in root. Each must render the
    // other *under a channel* in the tree - not merely online in the roster.
    await admin.sidebar.waitForChannelViewMember(bobName);
    await bob.sidebar.waitForChannelViewMember("SuperUser");
  });
});
