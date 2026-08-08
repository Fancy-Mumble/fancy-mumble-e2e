import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { delay } from "../util/wait";
import { pluginMissing } from "../util/preconditions";

/**
 * Offline-invite catch-up for the `fancy-calendar` relay - the *real* offline
 * case: Bob is genuinely disconnected at the moment he is invited.
 *
 * The invitee picker resolves candidates from the server's registered-user
 * directory (`request_user_list`), not just the online roster, so an organiser
 * can pick a registered user who is currently offline. That directory query is
 * gated on the read-only `ReadRegister` permission (or the read/write
 * `Register`, which the organiser SuperUser holds here). Delivery then rides the
 * relay's connect-time catch-up: `calendar.upsert` stores the meeting and
 * replays it on the invitee's next connect.
 *
 * Flow:
 *   1. Bob connects once so the admin can register him (the relay routes by a
 *      registered `user_id`; registration persists server-side by certificate).
 *   2. Bob DISCONNECTS - he is offline and no longer in anyone's online roster.
 *   3. The admin opens the meeting dialog and invites Bob anyway: he is resolved
 *      purely from the registered-user directory while offline. Saving stores the
 *      meeting on the relay with no live session to deliver to.
 *   4. Bob RECONNECTS (same certificate -> same registered `user_id`) and the
 *      relay's catch-up replays the meeting into his calendar.
 *
 * Requires the server build that exposes the directory to the organiser
 * (`ReadRegister`/`Register`) and a client build whose EventDialog merges that
 * directory into the invitee candidates.
 */
describe("calendar: invite an offline registered user", { skip: pluginMissing("fancy-calendar") }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-cal-off-B-${sfx}`;
  const meetingTitle = `Offline Invite ${sfx}`;

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

  it("resolves the offline invitee from the registered-user directory and delivers on reconnect", async () => {
    // Register Bob so he has a stable, persistent user_id (the member-item rows
    // with a context menu live in the Members tab, which waitForMember opens).
    await admin.chat.waitForMember(bobName);
    await admin.sidebar.registerUser(bobName);
    // Registration is keyed by Bob's live session - wait until the server has
    // committed it and broadcast his user_id (the "Registered" badge) BEFORE he
    // disconnects, otherwise the registration would be lost and he'd never make
    // it into the directory.
    await admin.chat.waitForRegistered(bobName);

    // Bob goes offline. Wait for his client to return to the connect screen and
    // give the server a moment to drop his session, so when we invite him below
    // he exists ONLY in the registered directory - not in the admin's online
    // roster.
    await bob.chat.disconnect();
    await bob.connect.waitReady();
    await delay(2000);

    // Invite the offline Bob. The dialog fetches the registered-user directory,
    // so his name resolves to a candidate even though he is not connected.
    await admin.calendar.open();
    await admin.calendar.openMeetingDialog();
    await admin.calendar.setMeetingTitle(meetingTitle);
    await admin.calendar.addInvitees([bobName]);
    await admin.calendar.saveMeeting();

    // Bob reconnects with the same identity/certificate -> same registered
    // user_id the meeting was addressed to. The relay's connect-time catch-up
    // replays the stored meeting into his calendar.
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await bob.chat.waitLoaded();

    await bob.calendar.open();
    await bob.calendar.switchView("week");
    await bob.calendar.waitForEvent(meetingTitle);
  });
});
