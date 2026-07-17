import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { By, until } from "selenium-webdriver";
import { TauriApp } from "../app";
import { config } from "../config";
import { byTid, TID } from "../selectors";
import { setSuperUserPassword } from "../util/server";
import { totpCode } from "../util/totp";

/**
 * Self-service account settings (Settings -> Account, server 0.4.1):
 * a registered user manages their own registration over the wire.
 *
 * Locked-in behaviour:
 *   - The Account tab exists for a registered user and mirrors the server's
 *     account snapshot (auth mode, 2FA state).
 *   - Enabling password auth makes the password REQUIRED on the next connect
 *     (certificate alone no longer authenticates) - the password dialog
 *     appears and the stored password signs the user in.
 *   - TOTP 2FA enrolment hands out a base32 secret; after confirming with a
 *     generated code, the next login additionally demands a 6-digit code
 *     (TOTPRequired reject -> dedicated code dialog).
 *   - Self-unregister is guarded by a type-your-name confirm and removes the
 *     registration server-side (admin Users list agrees).
 */
describe("account: self-service settings (password auth, 2FA, unregister)", () => {
  let admin: TauriApp;
  let user: TauriApp;
  const sfx = Date.now() % 100000;
  const userName = `e2e-acct-${sfx}`;
  const password = `e2e-pw-${sfx}!x`;
  let totpSecret: string | null = null;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    user = await TauriApp.launch({ instance: 1 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await user.connect.connect(config.serverHost, userName, { port: config.serverPort });
    await admin.chat.waitLoaded();
    await user.chat.waitLoaded();

    // The account panel manages a *registered* account - register the user
    // (binds their client certificate's hash) via the admin flow first.
    await admin.chat.waitForMember(userName);
    await admin.sidebar.registerUser(userName);
    await admin.chat.waitForRegistered(userName);
  });

  after(async () => {
    await admin?.close();
    await user?.close();
  });

  it("offers the Account tab and reports certificate sign-in", async () => {
    await user.settings.open();
    assert.ok(
      await user.settings.hasAccountTab(),
      "a registered user on a Fancy >= 0.4.1 server must see the Account tab",
    );
    await user.settings.openAccountTab();
    // Freshly registered via cert hash: cert auth, no password, no 2FA.
    await user.settings.waitForOverviewContains("Sign-in: certificate");
    await user.settings.waitForOverviewContains("Two-factor authentication: off");
  });

  it("enables password auth and requires the password on reconnect", async () => {
    // Still on the Account tab from the previous case.
    await user.settings.setPassword(password);
    // The server re-sends the snapshot after a successful update.
    await user.settings.waitForOverviewContains("Sign-in: password");

    // Reconnect: the certificate alone must no longer authenticate. The
    // connect helper expects (and fills) the password dialog when a password
    // is passed - it would time out if the server let the cert through.
    await user.settings.back();
    await user.chat.disconnect();
    await user.connect.waitReady(config.connectTimeout);
    await user.connect.connect(config.serverHost, userName, {
      port: config.serverPort,
      password,
    });
    await user.chat.waitLoaded();
  });

  it("enrols TOTP 2FA and demands a code at the next login", async () => {
    await user.settings.open();
    await user.settings.openAccountTab();

    totpSecret = await user.settings.beginTotpEnrollment();
    await user.settings.verifyTotp(totpCode(totpSecret));
    await user.settings.waitForOverviewContains("Two-factor authentication: on");

    // Reconnect: after the password is accepted the server must now reject
    // with TOTPRequired, surfacing the dedicated 6-digit-code dialog.
    await user.settings.back();
    await user.chat.disconnect();
    await user.connect.waitReady(config.connectTimeout);
    await user.connect.connect(config.serverHost, userName, {
      port: config.serverPort,
      password,
    });

    const codeInput = await user.driver.wait(
      until.elementLocated(byTid(TID.connectTotpInput)),
      20000,
      "the 2FA code dialog never appeared after password sign-in",
    );
    await codeInput.clear();
    await codeInput.sendKeys(totpCode(totpSecret));
    const submit = await user.driver.wait(
      until.elementLocated(byTid(TID.connectTotpSubmit)),
      10000,
    );
    await user.driver.wait(until.elementIsEnabled(submit), 10000);
    await submit.click();

    await user.chat.waitLoaded();
  });

  it("unregisters itself behind a type-your-name confirm", async () => {
    await user.settings.open();
    await user.settings.openAccountTab();
    await user.settings.unregister(userName);

    // The panel flips to the "no registered account" notice once the server
    // confirms (snapshot with registered = false).
    await user.driver.wait(
      async () =>
        (await user.driver.findElements(
          By.xpath("//*[contains(normalize-space(.), 'No registered account')]"),
        )).length > 0,
      15000,
      "the Account panel never reported the registration as removed",
    );

    // The admin's Users directory must agree.
    await admin.admin.open();
    await admin.admin.openUsersTab();
    await admin.admin.waitForRegisteredUserGone(userName);
  });
});
