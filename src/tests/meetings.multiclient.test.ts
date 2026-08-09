import { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { bridgeMissing } from "../util/preconditions";
import { stepChain } from "../util/steps";

/**
 * Scheduled meeting rooms (server-provisioned, end-to-end-encrypted).
 *
 * Building on private hidden channels + the `fancy-calendar` relay, a meeting
 * gets an actual place to meet: a hidden, `signal_v1` (Signal sender-key E2E)
 * channel under the server's `__meetings` root, created server-authoritatively
 * by the calendar plugin - on first join here, or at the meeting's start time.
 * Rooms inherit an absolute expiry so they self-destruct ~1 week after the
 * meeting; organisers can mint a Teams-style invite link.
 *
 * What this exercises end-to-end:
 *   1. Admin (SuperUser organiser) registers Bob and invites him to a meeting.
 *   2. The relay delivers the meeting to Bob; Bob opens it and clicks
 *      "Join meeting" -> the server provisions the room and admits him, and his
 *      client moves into it (the room name is "<title> [<id8>]", so a membership
 *      check on the title substring confirms he landed in the right channel).
 *   3. The `__meetings` node stays hidden in the channel tree by default, even
 *      for the admin (UI-only hiding; the admin can still see it server-side).
 *   4. The organiser can mint an invite link (`fancy://meeting/<eventId>?t=...`).
 *
 * Requires the server build that exposes the meeting-channel host bridge and a
 * client build with the calendar Join / invite-link UI.
 */
describe("meetings: server-provisioned E2E rooms", { skip: bridgeMissing() }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-mtg-B-${sfx}`;
  const meetingTitle = `Standup ${sfx}`;

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

  // The invite link is minted for the meeting step 1 creates.
  const step = stepChain();

  step("provisions a hidden E2E room on first join and keeps __meetings out of the tree", async () => {
    // Register Bob so the relay can address the meeting to a stable user_id.
    await admin.chat.waitForMember(bobName);
    await admin.sidebar.registerUser(bobName);
    await admin.chat.waitForRegistered(bobName);

    // Admin (organiser) schedules a meeting and invites Bob.
    await admin.calendar.open();
    await admin.calendar.openMeetingDialog();
    await admin.calendar.setMeetingTitle(meetingTitle);
    await admin.calendar.addInvitees([bobName]);
    await admin.calendar.saveMeeting();

    // The `__meetings` root is bootstrapped on the server and the admin can see
    // it server-side (SuperUser bypasses ACLs), but the channel tree hides the
    // whole subtree by default - so it must NOT appear in the sidebar.
    assert.equal(
      await admin.sidebar.hasChannel("__meetings"),
      false,
      "__meetings should be hidden from the channel tree by default",
    );

    // The relay delivers the meeting to Bob; he opens it and joins.
    await bob.calendar.open();
    await bob.calendar.switchView("week");
    await bob.calendar.waitForEvent(meetingTitle);
    await bob.calendar.openEvent(meetingTitle);
    await bob.calendar.joinMeeting();

    // Joining provisions the room and moves Bob into it. The room is named
    // "<title> [<id8>]", so a membership check on the title confirms he landed
    // in the meeting's channel rather than staying at root.
    await bob.sidebar.waitForMembership(meetingTitle);

    // The room lives under the hidden `__meetings` node, so it surfaces in the
    // flat "Private rooms"/Meetings viewer by its meeting name - the server's
    // " [<id8>]" disambiguation suffix stripped for display. Finding it there by
    // the bare title asserts both the viewer and the display-name stripping. The
    // `__meetings` container itself stays out of the tree (asserted below).
    await bob.sidebar.waitForPrivateRoom(meetingTitle);
    assert.equal(
      await bob.sidebar.hasChannel("__meetings"),
      false,
      "the __meetings container must never appear in the channel tree",
    );
  });

  step("lets the organiser mint a Teams-style invite link", async () => {
    await admin.calendar.open();
    await admin.calendar.openEvent(meetingTitle);
    const link = await admin.calendar.copyInviteLink();
    assert.match(
      link,
      /^fancy:\/\/meeting\/.+\?t=.+/,
      `expected a fancy://meeting invite link, got: ${link}`,
    );
  });
});
