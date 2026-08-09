import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Security regression: an anonymous (certificate-less) client must NOT be able
 * to join under a REGISTERED user's name.
 *
 * Background (server auth bug, vendor/server/src/murmur/Server.cpp
 * Server::authenticate): the 1.6 "new DB backend" rewrite made the
 * no-certificate exit return UNKNOWN_USER unconditionally
 *   `if (userID < 0 && certhash.isEmpty()) return UNKNOWN_USER;`
 * instead of `usedReservedName ? AUTHENTICATION_FAILED : UNKNOWN_USER`. So a
 * name that belongs to a *password-less, certificate-registered* account, when
 * presented with no password and no client certificate, was treated as a fresh
 * guest and admitted UNDER THAT NAME - impersonating the (offline) registered
 * user. Vanilla Mumble 1.5 is not affected (its old ServerDB::authenticate
 * defaults res = -1 the moment the name matches a registered row). The fix
 * restores the reserved-name guard; this test locks that behaviour in.
 *
 * Scenario: SuperUser registers `victim` (binding her certificate, no
 * password); `victim` then goes OFFLINE (so the online-duplicate check can't
 * mask the auth result); an anonymous attacker attempts to connect using
 * `victim`'s exact name. The server must reject it - ideally with
 * WrongUserPW (Reject.type 3), never UsernameInUse - and the attacker must
 * never reach a connected session.
 *
 * NB: this asserts SERVER behaviour, so it only passes against a server image
 * that includes the fix. Against an unpatched `ghcr.io/fancy-mumble/mumble-
 * server` it FAILS (the attacker connects) - which is precisely the regression
 * this guards. Point `E2E_SERVER_IMAGE` at a server built from the fixed source
 * to see it pass.
 */
describe("security: registered-name impersonation is rejected", () => {
  let admin: TauriApp;
  let victim: TauriApp;
  const sfx = Date.now() % 100000;
  const victimName = `e2e-imp-victim-${sfx}`;

  before(async () => {
    // The mumble-docker entrypoint doesn't reliably apply the SU password.
    setSuperUserPassword("testpassword");
    [admin, victim] = await TauriApp.launchAll({ instance: 0 }, { instance: 1 });
    await Promise.all([
      admin.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      }),
      // Victim connects WITH her default certificate, so registration binds that
      // cert hash to a registered user id (and no password).
      victim.connect.connect(config.serverHost, victimName, { port: config.serverPort }),
    ]);
    await Promise.all([admin.chat.waitLoaded(), victim.chat.waitLoaded()]);
  });

  after(async () => {
    await admin?.close();
    await victim?.close();
  });

  it("rejects an anonymous client using a registered user's name", async () => {
    // 1. Register the victim (SuperUser right-click -> Register). This stores
    //    her certificate hash against a new user id, with no password set.
    await admin.chat.waitForMember(victimName);
    await admin.sidebar.registerUser(victimName);
    await admin.chat.waitForRegistered(victimName);

    // 2. Take the victim OFFLINE. With no online holder of the name, a
    //    rejection can only come from the auth check (WrongUserPW), not from
    //    the "username already in use" duplicate guard - so a pass proves the
    //    auth fix, not an incidental collision.
    await victim.close();
    victim = undefined as unknown as TauriApp;

    // 3. Attacker connects ANONYMOUSLY (certLabel: null -> empty certhash) with
    //    the victim's exact name - the impersonation vector.
    const attacker = await TauriApp.launch({ instance: 2 });
    try {
      const outcome = await attacker.attemptRawConnect(
        config.serverHost,
        config.serverPort,
        victimName,
        { certLabel: null },
      );

      // Core regression assertion: the anonymous attacker must NOT be admitted
      // under the registered user's name.
      assert.equal(
        outcome.connected,
        false,
        "SECURITY: an anonymous client was admitted under a registered user's name " +
          "(server authenticate() returned UNKNOWN_USER for a reserved name)",
      );

      // Precision: when the server sets Reject.type it must be WrongUserPW (3),
      // i.e. an authentication failure - not UsernameInUse (5) or anything else.
      if (outcome.rejectType !== null) {
        assert.equal(
          outcome.rejectType,
          3,
          `expected WrongUserPW (3), got Reject.type ${outcome.rejectType} (reason: ${outcome.reason})`,
        );
      } else if (outcome.reason) {
        // Older servers may reject without a type; fall back to the reason text.
        assert.match(
          outcome.reason,
          /wrong (certificate|user)|password|existing user/i,
          `rejection reason didn't look like an auth failure: ${outcome.reason}`,
        );
      }
    } finally {
      await attacker.close();
    }
  });
});
