import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

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
describe("calendar: plugin gating + invite sync", () => {
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
    // The relay targets registered users, so register the invitee first.
    await admin.sidebar.registerUser(bobName);

    await admin.calendar.open();
    await admin.calendar.createMeeting(meetingTitle, bobName);

    await bob.calendar.open();
    await bob.calendar.switchView("month");
    await bob.calendar.waitForEvent(meetingTitle);
  });
});
