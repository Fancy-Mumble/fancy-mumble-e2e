import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { pluginMissing } from "../util/preconditions";
import { featureMissing } from "../ui-flavour";

/**
 * Exercises the `fancy-calendar` plugin end-to-end:
 *
 *  1. Plugin gating - the calendar header action only renders when the client
 *     has received the plugin's `fancy-plugin-info` from the server, so its
 *     presence proves the server built/loaded the plugin and the client gates
 *     correctly on it.
 *  2. Invite sync - a meeting the organiser schedules, inviting a registered
 *     participant, is relayed over the control channel and shows up in the
 *     participant's calendar. The relay routes by registered `user_id`, so the
 *     invitee is registered first (SuperUser, via the user context menu).
 *
 * The organiser is SuperUser (already admin in the harness); only the invitee
 * needs a registered id for the relay to target it.
 */
describe("calendar: plugin gating + invite sync", { skip: featureMissing("calendar") || pluginMissing("fancy-calendar") }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const bobName = `e2e-cal-B-${Date.now() % 100000}`;
  const meetingTitle = `E2E Sync Meeting ${Date.now() % 100000}`;

  before(async () => {
    // Work around the mumble-docker entrypoint not applying the SU password.
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

  it("exposes the calendar action when the server runs the fancy-calendar plugin", async () => {
    assert.equal(
      await admin.calendar.headerButtonPresent(),
      true,
      "organiser should see the calendar header button (fancy-calendar plugin loaded + gated on)",
    );
    assert.equal(
      await bob.calendar.headerButtonPresent(),
      true,
      "participant should see the calendar header button too",
    );
  });

  it("relays a scheduled meeting from the organiser to the invited participant", async () => {
    // The `member-item` rows (with a context menu) live in the Members tab;
    // waitForMember switches to it and waits for the peer to be present.
    await admin.chat.waitForMember(bobName);
    // The relay routes by registered user_id, so register the invitee first.
    //
    // Regression guard for the mid-session registration bug: a server-side
    // plugin only learns a user's registered user_id from the connect
    // handshake, so the calendar relay caches it in on_client_connected. When
    // `bob` joins as a guest (user_id -1) and is registered *while connected*,
    // the relay kept that stale -1 and silently dropped meetings invited to
    // `bob` - it could not map his new user_id back to his session, so the
    // event below would never arrive (the test timed out on waitForEvent).
    //
    // Fixed in mumble-server `PluginHostManager::onUserStateChanged`: when a
    // user's registration changes, the client is re-announced to the plugin
    // host, refreshing its session->user_id (and the calendar plugin's routing
    // table). So this test deliberately does NOT reconnect `bob` after
    // registering him - if the meeting still reaches his calendar, the
    // mid-session mapping works end-to-end.
    await admin.sidebar.registerUser(bobName);

    await admin.calendar.open();
    await admin.calendar.createMeeting(meetingTitle, bobName);

    await bob.calendar.open();
    await bob.calendar.switchView("month");
    await bob.calendar.waitForEvent(meetingTitle);
  });
});
