import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { UserManager, type ManagedAccount } from "../util/user-manager";

/** Absolute, because the backend reads it and the test never opens a picker. */
const avatarPath = path.resolve("fixtures/avatar-sample.png");

/**
 * The signup happy path, from the website to the other person's member list.
 *
 * A new user registers on mumble-user-manager, clicks the link in the
 * confirmation email, claims their Mumble account and uploads a profile
 * picture — all before ever starting a Mumble client. Then they connect, and
 * the picture is already there for everyone.
 *
 * # Why the avatar is set on the website and not in the client
 *
 * Because that is where it is set. The user manager owns accounts and
 * profiles; it pushes the picture to Starling over the operator API, and the
 * client is a consumer of the result. Driving the client's settings panel here
 * would exercise a path real users do not take and would skip the whole chain
 * this is meant to cover:
 *
 *     website upload → backend → operator API → account texture
 *                    → UserState on connect → the observer's member list
 *
 * # What each assertion catches
 *
 * | Assertion | The bug it catches |
 * |---|---|
 * | the account can log in with its web password | `mumble/create` linked a name but set no password, or set it on the wrong account |
 * | the observer sees them as registered | the account exists on the website only — Starling never got a registration |
 * | the observer sees their picture | the texture never left the backend, or Starling drops textures set out of band |
 * | they see their own picture | the texture reaches its owner, not just observers |
 * | it survives a reconnect | the texture lives on the account and not in the session |
 */
const backend = await UserManager.discover();

/**
 * Skip rather than fail when the stack is not up.
 *
 * Same reasoning as the Starling suite: on a machine that only runs the client
 * tests, a missing backend is a configuration fact, not a defect. Decided at
 * module load so the reason lands in the runner's output rather than as a
 * throw inside `before`, where it would read as five broken tests.
 */
const skip = backend
  ? false
  : `needs ${UserManager.requirement} — bring it up with ` +
    "`docker compose --env-file <env> up -d --wait` in " +
    "vendor/mumble-user-manager-backend";

describe("user manager: sign up, confirm, set a picture, and be seen", { skip }, () => {
  let account: ManagedAccount;

  let member: TauriApp;
  let observer: TauriApp;

  const sfx = Date.now() % 1000000;
  const memberName = `e2eumm${sfx}`;
  const observerName = `e2e-umm-obs-${sfx}`;

  before(async () => {
    // The whole website-side flow, finished before any client starts: this is
    // a user who signed up, confirmed, and set their picture, and is now
    // connecting for the first time.
    account = await backend!.provision(memberName, avatarPath);

    member = await TauriApp.launch({ instance: 0 });
    observer = await TauriApp.launch({ instance: 1 });

    await member.connect.connect(config.serverHost, account.username, {
      port: config.serverPort,
      password: account.password,
    });
    await observer.connect.connect(config.serverHost, observerName, { port: config.serverPort });

    await member.chat.waitLoaded(config.connectTimeout);
    await observer.chat.waitLoaded(config.connectTimeout);
  });

  after(async () => {
    await Promise.allSettled([member?.close(), observer?.close()]);
  });

  it("lets the account created on the website log in to Mumble", async () => {
    // Reaching the chat view at all means the password the backend set on the
    // Mumble account matched the one the client sent. A wrong password is a
    // rejected connection, not a degraded one.
    await observer.chat.waitForMember(account.username);
  });

  it("shows the website account as registered", async () => {
    // The badge is the observable half of `mumble/create`: it means Starling
    // holds a real account for this name, not that the website does.
    await observer.chat.waitForRegistered(account.username);
  });

  it("shows the picture that was uploaded on the website", async () => {
    // The observer never uploaded anything and has no local copy — the image
    // can only have come down the wire, fetched by the hash in `UserState`.
    await observer.chat.waitForAvatar(account.username);
  });

  it("shows the picture to its owner too", async () => {
    // A texture broadcast to others but not to its owner is a real asymmetry,
    // and it is invisible from the observer's side alone.
    await member.chat.waitForAvatar(account.username);
  });

  it("keeps the picture across a reconnect", async () => {
    // The point of setting it on the account rather than the session: it is
    // still there next time, without the client re-sending anything.
    await member.chat.disconnect();
    await member.connect.waitReady(config.connectTimeout);
    await member.connect.connect(config.serverHost, account.username, {
      port: config.serverPort,
      password: account.password,
    });
    await member.chat.waitLoaded(config.connectTimeout);

    await observer.chat.waitForMember(account.username);
    await observer.chat.waitForAvatar(account.username);
    assert.equal(
      await observer.chat.isRegistered(account.username),
      true,
      "the account must still be registered after reconnecting",
    );
  });
});
