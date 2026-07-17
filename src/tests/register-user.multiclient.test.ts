import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Ticket regression: "register users ... does not work".
 *
 * Reported steps (v0.4.0, Windows):
 *   1. Connect to server as SuperUser.
 *   2. Right click on a user's user name and navigate to the "register" button.
 *   3. Based on directions it should ask to verify their user name -
 *      "Nothing pops up".
 *   4. "if you check the list of users in the admin sections, there is no
 *      listed users."
 *
 * Expected behaviour (locked in here):
 *   - Clicking Register opens a verification popup that names the user
 *     (sidebar.registerUser asserts the popup appears and mentions the name,
 *     failing the test if nothing pops up).
 *   - After confirming, the user appears in the admin section's Users list.
 *
 * A second case covers the inverse flow added alongside the fix: Admin
 * Settings / Users / Actions -> Unregister, guarded by a confirmation dialog
 * warning that all of the user's data is deleted.
 */
describe("admin: register user via right-click (verification popup + admin list)", () => {
  let admin: TauriApp;
  let peer: TauriApp;
  const sfx = Date.now() % 100000;
  const peerName = `e2e-reg-${sfx}`;

  before(async () => {
    // The mumble-docker entrypoint doesn't reliably apply the SU password.
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    peer = await TauriApp.launch({ instance: 1 });
    // Step 1: connect as SuperUser; the peer connects with its default
    // certificate so registration has a cert hash to bind.
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await peer.connect.connect(config.serverHost, peerName, { port: config.serverPort });
    await admin.chat.waitLoaded();
    await peer.chat.waitLoaded();
  });

  after(async () => {
    await admin?.close();
    await peer?.close();
  });

  it("pops up a verification dialog and then lists the user in Admin / Users", async () => {
    // Step 2 + 3: right-click the user's name -> Register. registerUser()
    // fails if the verification popup never appears or doesn't name the user -
    // exactly the "Nothing pops up" symptom from the ticket - and confirms it.
    await admin.chat.waitForMember(peerName);
    await admin.sidebar.registerUser(peerName);

    // The server must commit the registration (the member row gains the
    // "Registered" badge once the new user_id is broadcast).
    await admin.chat.waitForRegistered(peerName);

    // Step 4: the admin section's Users list must now list the user.
    await admin.admin.open();
    await admin.admin.openUsersTab();
    await admin.admin.waitForRegisteredUser(peerName);
    assert.ok(
      await admin.admin.hasRegisteredUser(peerName),
      `"${peerName}" is not listed in the admin Users list after registering`,
    );
  });

  it("unregisters the user via Admin / Users / Actions with a data-loss confirm", async () => {
    // Still on the Users tab from the previous case. unregisterUser() clicks
    // the row's Actions kebab -> Unregister, asserts the confirmation dialog
    // names the user, and confirms.
    await admin.admin.unregisterUser(peerName);
    await admin.admin.waitForRegisteredUserGone(peerName);

    // The sidebar must agree: the (still-connected) peer's registration is
    // gone server-side, so their row loses the "Registered" badge on the
    // next UserState broadcast. We only assert the admin list here - the
    // badge removal needs a fresh UserState which the server may not push
    // for an unchanged session.
    assert.equal(await admin.admin.hasRegisteredUser(peerName), false);
  });
});
