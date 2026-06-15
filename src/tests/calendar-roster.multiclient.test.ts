import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { delay } from "../util/wait";

/**
 * Fans the `fancy-calendar` relay out across THREE clients and several invite
 * constellations, then asserts each user's calendar shows exactly the meetings
 * they organise or are invited to - nothing more, nothing less.
 *
 * Users: admin (SuperUser), bob, carol. The relay routes by registered
 * `user_id`, so bob and carol are registered up front; the invitee autocomplete
 * then doubles as the sync point for that registration reaching each organiser's
 * client. SuperUser has `user_id 0`, which the invitee picker treats as
 * "unregistered" (it only lists candidates with `user_id > 0`), so admin can
 * ORGANISE meetings but is never itself an invitee.
 *
 * Meetings (creation order matters for the negative checks below):
 *   1. allHands  - admin invites bob + carol  -> admin, bob, carol
 *   2. adminBob  - admin invites bob          -> admin, bob          (not carol)
 *   3. adminCarol- admin invites carol        -> admin, carol        (not bob)
 *   4. bobCarol  - bob invites carol          -> bob, carol          (not admin)
 *   5. carolBob  - carol invites bob          -> carol, bob          (not admin)
 *   6. allSync   - admin invites bob + carol  -> admin, bob, carol   (barrier)
 *
 * This covers multi-invitee meetings, both peer-to-peer directions (bob and
 * carol each organising), and per-user exclusion. `allSync` is created last and
 * relayed to BOTH bob and carol, so once they have rendered it the relay has
 * delivered everything it ever will - a clean barrier for the absence checks
 * (admin receives no relay at all, so its exclusions are confirmed once the
 * relay has demonstrably drained to bob and carol).
 *
 * All meetings default to "today" at the next whole hour; the WEEK view renders
 * every same-day occurrence (unlike the month view, which caps at 3 chips/day),
 * so events are asserted there by their unique titles.
 */
describe("calendar: 3-user meeting constellations", () => {
  let admin: TauriApp;
  let bob: TauriApp;
  let carol: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-cal3-B-${sfx}`;
  const carolName = `e2e-cal3-C-${sfx}`;
  const title = {
    allHands: `All Hands ${sfx}`,
    adminBob: `Admin x Bob ${sfx}`,
    adminCarol: `Admin x Carol ${sfx}`,
    bobCarol: `Bob x Carol ${sfx}`,
    carolBob: `Carol x Bob ${sfx}`,
    allSync: `Team Sync ${sfx}`,
  };

  before(async () => {
    // Work around the mumble-docker entrypoint not applying the SU password.
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    bob = await TauriApp.launch({ instance: 1 });
    carol = await TauriApp.launch({ instance: 2 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await carol.connect.connect(config.serverHost, carolName, { port: config.serverPort });
    await admin.chat.waitLoaded();
    await bob.chat.waitLoaded();
    await carol.chat.waitLoaded();
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close(), carol?.close()]);
  });

  it("relays every meeting to exactly its organiser + invitees", async () => {
    // Register the two guests so the relay can target them by user_id.
    await admin.chat.waitForMember(bobName);
    await admin.chat.waitForMember(carolName);
    await admin.sidebar.registerUser(bobName);
    await admin.sidebar.registerUser(carolName);

    // --- organiser: admin -------------------------------------------------
    await admin.calendar.open();
    await admin.calendar.createMeeting(title.allHands, [bobName, carolName]);
    await admin.calendar.createMeeting(title.adminBob, [bobName]);
    await admin.calendar.createMeeting(title.adminCarol, [carolName]);

    // --- organiser: bob (non-admin relaying to carol) ---------------------
    await bob.calendar.open();
    await bob.calendar.createMeeting(title.bobCarol, [carolName]);

    // --- organiser: carol (non-admin relaying to bob) ---------------------
    await carol.calendar.open();
    await carol.calendar.createMeeting(title.carolBob, [bobName]);

    // --- barrier: admin invites both, created last ------------------------
    await admin.calendar.createMeeting(title.allSync, [bobName, carolName]);

    // Verify in the week view, which renders all of today's occurrences.
    await admin.calendar.switchView("week");
    await bob.calendar.switchView("week");
    await carol.calendar.switchView("week");

    // admin sees only what it organises: all-hands, both 1:1s, and the sync.
    await admin.calendar.waitForEvent(title.allHands);
    await admin.calendar.waitForEvent(title.adminBob);
    await admin.calendar.waitForEvent(title.adminCarol);
    await admin.calendar.waitForEvent(title.allSync);

    // bob sees: all-hands, admin 1:1, bob->carol, carol->bob, and the sync.
    await bob.calendar.waitForEvent(title.allHands);
    await bob.calendar.waitForEvent(title.adminBob);
    await bob.calendar.waitForEvent(title.bobCarol);
    await bob.calendar.waitForEvent(title.carolBob);
    await bob.calendar.waitForEvent(title.allSync);

    // carol sees: all-hands, admin 1:1, bob->carol, carol->bob, and the sync.
    await carol.calendar.waitForEvent(title.allHands);
    await carol.calendar.waitForEvent(title.adminCarol);
    await carol.calendar.waitForEvent(title.bobCarol);
    await carol.calendar.waitForEvent(title.carolBob);
    await carol.calendar.waitForEvent(title.allSync);

    // Negative checks. `allSync` (created last, relayed to bob AND carol) has
    // been rendered by both above, so the relay has flushed everything it will
    // ever send - any meeting still absent is correctly excluded. The settle is
    // belt-and-braces against a late render.
    await delay(1500);
    assert.equal(
      await admin.calendar.hasEvent(title.bobCarol),
      false,
      "admin was not invited to the Bob x Carol meeting and must not see it",
    );
    assert.equal(
      await admin.calendar.hasEvent(title.carolBob),
      false,
      "admin was not invited to the Carol x Bob meeting and must not see it",
    );
    assert.equal(
      await bob.calendar.hasEvent(title.adminCarol),
      false,
      "bob was not invited to the Admin x Carol meeting and must not see it",
    );
    assert.equal(
      await carol.calendar.hasEvent(title.adminBob),
      false,
      "carol was not invited to the Admin x Bob meeting and must not see it",
    );
  });
});
