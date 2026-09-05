import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { pluginMissing } from "../util/preconditions";
import { featureMissing } from "../ui-flavour";

/**
 * Desktop-notification flows for `fancy-calendar`. Both are delivered through the
 * Tauri notification plugin's Rust IPC (`plugin:notification|notify`), which the
 * test intercepts in the webview (OS notifications are invisible to Selenium).
 *
 *  1. Reminder - a meeting with a reminder offset whose trigger time has arrived
 *     fires a "<title> / Starts at ..." notification (useCalendarReminders).
 *  2. Invitation - when a meeting invite arrives over the relay, the invited
 *     participant gets a "Meeting invitation / You've been invited to ..."
 *     notification (applyCalendarInbound).
 */
describe("calendar: meeting notifications", { skip: featureMissing("calendar") || pluginMissing("fancy-calendar") }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-cal-notify-B-${sfx}`;
  const reminderTitle = `Reminder Standup ${sfx}`;
  const inviteTitle = `Invite Kickoff ${sfx}`;

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

  it("fires a reminder notification when a meeting's reminder time arrives", async () => {
    // Capture notifications before anything can fire.
    await admin.chat.installNotificationCapture();

    // A meeting starting in 3 minutes with a 15-minute reminder: the reminder
    // time (start - 15m) is already past, and the start is within the reminder
    // look-ahead window, so the next reminder tick fires immediately.
    await admin.calendar.open();
    await admin.calendar.openMeetingDialog();
    await admin.calendar.setMeetingTitle(reminderTitle);
    await admin.calendar.setStartInMinutes(3);
    await admin.calendar.setReminder(15);
    await admin.calendar.saveMeeting();

    // The reminder tick runs on an interval; allow a generous window.
    const note = await admin.chat.waitForNotification(reminderTitle, 40000);
    assert.equal(note.title, reminderTitle, "reminder notification title is the meeting title");
    assert.match(note.body, /Starts at/, "reminder body states the start time");
  });

  it("notifies an invited participant when a meeting invite arrives", async () => {
    // Register Bob so the relay can route the invite to him.
    await admin.chat.waitForMember(bobName);
    await admin.sidebar.registerUser(bobName);
    await admin.chat.waitForRegistered(bobName);

    // Capture on Bob's client before the invite is sent.
    await bob.chat.installNotificationCapture();

    // Admin schedules a meeting inviting Bob (who is online); the relay delivers
    // it and Bob's client raises an invitation notification.
    await admin.calendar.open();
    await admin.calendar.createMeeting(inviteTitle, [bobName]);

    const note = await bob.chat.waitForNotification("Meeting invitation", 25000);
    assert.equal(note.title, "Meeting invitation");
    assert.ok(
      note.body.includes(inviteTitle),
      `invitation body should name the meeting; got "${note.body}"`,
    );
  });
});
