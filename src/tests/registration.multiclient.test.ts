import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";
import { setSuperUserPassword } from "../util/server";

/**
 * Registering a user, end to end, including the confirmation step.
 *
 * # Why this exists separately from the tests that already register people
 *
 * Eleven files call `sidebar.registerUser()`, and none of them cover the act of
 * registering: they need a registered account as a *precondition* for something
 * else (an invitee ACL, an E2E chat, a calendar invite). So the registration
 * path itself was never asserted — which is how it went unnoticed that the menu
 * item labelled "Register" only opens a confirmation dialog, and that the page
 * object stopped there, registering nobody in any of those eleven files.
 *
 * # What each assertion here would catch
 *
 * | Assertion | The bug it catches |
 * |---|---|
 * | the badge appears for the target | the request never left the client, or the server dropped it |
 * | and not for the other guest | registration hitting the wrong session |
 * | the badge survives a reconnect | registered in memory only, never persisted |
 * | the account is reusable by name | the account exists but nothing can be keyed to it |
 * | a guest cannot register anyone | `Register` not enforced — anyone could mint accounts |
 *
 * The last one matters most and is the easiest to lose: a server that registers
 * on request without checking the permission passes every other assertion here.
 */
describe("registration: register a user, confirm it, and use the account", () => {
  let admin: TauriApp;
  let bob: TauriApp;
  let carol: TauriApp;

  const sfx = Date.now() % 100000;
  const bobName = `e2e-reg-bob-${sfx}`;
  const carolName = `e2e-reg-carol-${sfx}`;

  before(async () => {
    // Set the SuperUser password rather than assuming an earlier suite did: the
    // shared server generates a random one at boot, so run on its own the admin
    // login below is refused without this.
    setSuperUserPassword("testpassword");
    [admin, bob, carol] = await TauriApp.launchAll(
      { instance: 0 },
      { instance: 1 },
      { instance: 2 },
    );

    // SuperUser holds `Register`; bob and carol are guests, which is what makes
    // them registerable and makes carol's attempt below a real refusal.
    await Promise.all([
      admin.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
      carol.connect.connect(config.serverHost, carolName, { port: config.serverPort }),
    ]);

    await Promise.all([
      admin.chat.waitLoaded(config.connectTimeout),
      bob.chat.waitLoaded(config.connectTimeout),
      carol.chat.waitLoaded(config.connectTimeout),
    ]);

    // Serial on purpose: both waits drive the SAME admin session (tab click +
    // element polls), and WebKitWebDriver resets the connection under
    // concurrent commands on one session (ECONNRESET, 3/3 reproducible).
    // Parallelism across DIFFERENT sessions is fine; within one it is not.
    await admin.chat.waitForMember(bobName);
    await admin.chat.waitForMember(carolName);
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close(), carol?.close()]);
  });

  it("registers a user only once the confirmation is accepted", async () => {
    // Before: a guest, so the registered badge must be absent. Asserted rather
    // than assumed, or the test would pass against a server that marks
    // everybody registered.
    assert.equal(
      await admin.chat.isRegistered(bobName),
      false,
      "a guest must not already carry the registered badge",
    );

    await admin.sidebar.registerUser(bobName);
    await admin.chat.waitForRegistered(bobName);
  });

  it("registers only the user it was asked about", async () => {
    // The request carries a session id, and the server overwrites nothing else.
    // A handler that read the wrong session would register whoever happened to
    // be first in the list, which the assertion above cannot see.
    await delay(1000);
    assert.equal(
      await admin.chat.isRegistered(carolName),
      false,
      "registering bob must not register carol",
    );
  });

  it("keeps the registration across a reconnect", async () => {
    // The point of registering: it outlives the session. An account held only
    // in the connection's memory looks identical until the user comes back.
    await bob.chat.disconnect();
    await bob.connect.waitReady(config.connectTimeout);
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await bob.chat.waitLoaded(config.connectTimeout);

    await admin.chat.waitForMember(bobName);
    await admin.chat.waitForRegistered(bobName);
  });

  it("lets the registered user act as themselves", async () => {
    // An account nothing can be attributed to is not much of an account. A
    // message from the reconnected user must still arrive attributed to the
    // name the registration is keyed to.
    const token = `e2e-reg-msg-${sfx}`;
    await bob.chat.sendMessage(token);
    await admin.chat.waitForText(token);
    await admin.chat.waitForMessageFrom(bobName);
  });

  it("refuses to register a user when the caller lacks the permission", async () => {
    // carol is a guest and holds no `Register`, so the client must not offer it
    // — and if it ever does, the server must refuse. Either way the outcome is
    // the same and is what this asserts: carol cannot mint an account.
    await carol.chat.waitForMember(carolName);
    await carol.sidebar.registerUser(carolName).catch(() => undefined);
    await delay(2000);
    assert.equal(
      await admin.chat.isRegistered(carolName),
      false,
      "a guest without Register must not be able to register anyone, including themselves",
    );
  });
});
