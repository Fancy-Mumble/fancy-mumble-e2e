import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { StarlingServer } from "../util/starling";
import { setSuperUserPassword } from "../util/server";

/**
 * What survives Starling being stopped and started again on its own data
 * directory.
 *
 * Every other persistence test in this suite restarts the *client* and leaves
 * the server up, so all of them pass on a server that holds the whole tree in
 * memory and would lose it the moment it exits. This one asks the other
 * question - the one an operator actually has, before a deploy or a reboot:
 * does the server come back as itself?
 *
 * Four separate things are being asked, and they fail independently:
 *
 *  - the *channels* come back (the tree is on disk, not in memory);
 *  - each one's *persistence mode* comes back with it, because a persistent
 *    channel that returns as volatile is worse than one that does not return
 *    at all: it keeps working, and quietly stops keeping anything;
 *  - the *messages* stored under it are served again;
 *  - the at-rest key those rows are sealed with is the same key. Starling
 *    generates one on first run and warns that rows sealed with it cannot be
 *    read without it, so a restart that mints a fresh one leaves the rows in
 *    place and unreadable - a data loss that looks exactly like an empty
 *    channel.
 *
 * A temporary channel is created alongside as the control. It must *not* come
 * back: "nothing was lost" is only meaningful next to something that was
 * supposed to be.
 *
 * The client is restarted too, on a profile it keeps. Without that, a replayed
 * message proves nothing: the client that sent it is still holding it, and a
 * transcript rendered from its own memory looks exactly like one served by the
 * server. Ending the process empties it, while the kept profile leaves the
 * archive key on disk - so the message has to come back over the wire, and
 * there has to be something left to decrypt it with.
 *
 * The server is killed rather than asked to stop (`killTree` is `taskkill /F`
 * on Windows, SIGKILL after a grace period elsewhere), so nothing here depends
 * on a clean shutdown getting a chance to flush. What survives, survives an
 * ending the server did not see coming.
 *
 * This test owns its server, because restarting the shared one would pull the
 * floor out from under every other file in the run. `scripts/e2e.mts` keeps it
 * in the private pass for that reason.
 */

const PASSWORD = "testpassword";

/** The line Starling logs when it creates an at-rest key it did not have. */
const KEY_MINTED = "generated a data key";

const skip = !StarlingServer.available()
  ? `no Starling binary at ${StarlingServer.binary} - build it with ` +
    "cargo build -p starling --manifest-path vendor/starling/Cargo.toml"
  : false;

describe("Starling survives its own restart", { concurrency: 1, skip }, () => {
  let server: StarlingServer;
  let app: TauriApp;
  /** Kept across the relaunch: the same profile *is* the same user, and the
   *  persisted archive key is what makes the replay readable. */
  let profile: string;

  const suffix = String(Date.now() % 1_000_000);
  /** Client-sealed archive: the server stores ciphertext it cannot read. */
  const archiveChannel = `e2e-rs-archive-${suffix}`;
  /** Server-held history: the server holds the key, so it can serve the lot. */
  const managedChannel = `e2e-rs-managed-${suffix}`;
  /** An ordinary room: it must come back, with its protocol still "none". */
  const plainChannel = `e2e-rs-plain-${suffix}`;
  /** The control: a temporary channel must *not* come back. */
  const tempChannel = `e2e-rs-temp-${suffix}`;

  const archiveToken = `rs-archive-${Date.now()}`;
  const managedToken = `rs-managed-${Date.now()}`;

  before(async () => {
    server = await StarlingServer.start();
    setSuperUserPassword(PASSWORD, server.operatorApiUrl);
    profile = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-restart-"));
    await launch();
  });

  after(async () => {
    await app?.close();
    await server?.stop();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  async function launch(): Promise<void> {
    app = await TauriApp.launch({ instance: 0, dataDir: profile });
    await connect();
  }

  async function connect(): Promise<void> {
    await app.connect.waitReady(config.connectTimeout);
    await app.connect.connect(config.serverHost, "SuperUser", {
      port: server.port,
      password: PASSWORD,
    });
    await app.chat.waitLoaded(config.connectTimeout);
  }

  it("sets the tree up, then restarts the server and the client", async () => {
    await app.sidebar.createSubChannel(0, archiveChannel, {
      pchatProtocol: "fancy_v1_full_archive",
    });
    await app.sidebar.createSubChannel(0, managedChannel, { pchatProtocol: "server_managed" });
    await app.sidebar.createSubChannel(0, plainChannel);
    await app.sidebar.createSubChannel(0, tempChannel, { temporary: true });

    for (const name of [archiveChannel, managedChannel, plainChannel, tempChannel]) {
      await app.sidebar.waitForChannel(name);
    }

    // One message per persistent mode, because the two are stored by different
    // routes - one sealed by this client, one by the server - and a restart
    // could lose either without touching the other.
    await app.sidebar.joinChannel(archiveChannel);
    await app.chat.composer.send(archiveToken);
    await app.chat.messages.waitForText(archiveToken);

    await app.sidebar.joinChannel(managedChannel);
    await app.chat.composer.send(managedToken);
    await app.chat.messages.waitForText(managedToken);

    // Leave the temporary channel empty of occupants before the restart, so
    // its disappearance afterwards is about persistence and not about the
    // client having been the last one in it.
    await app.sidebar.joinChannel(plainChannel);

    // The control only controls for anything if it was still there when the
    // server went down: a temporary channel reaped beforehand would make the
    // assertion at the end pass on a server that persists everything.
    assert.ok(
      await app.sidebar.hasChannel(tempChannel),
      "the temporary channel was already gone before the restart, so its " +
        "absence afterwards would prove nothing",
    );

    // No disconnect: the process is ended, which is what empties the client's
    // message store and makes anything seen afterwards something the server
    // said.
    await app.close();
    await server.restart();
    await launch();
  });

  it("brings the channels back", async () => {
    for (const name of [archiveChannel, managedChannel, plainChannel]) {
      await app.sidebar.waitForChannel(name);
    }
    assert.ok(
      await app.sidebar.hasChannel(archiveChannel),
      "the archive channel did not survive the restart",
    );
  });

  it("brings each channel's persistence mode back with it", async () => {
    // The mode is the fact that decides whether anything said next is kept, so
    // a channel that returns with the wrong one is losing data from now on
    // rather than having lost some already.
    assert.equal(
      await app.sidebar.channelPchatProtocol(archiveChannel),
      "fancy_v1_full_archive",
      "a full-archive channel came back with a different persistence mode",
    );
    assert.equal(
      await app.sidebar.channelPchatProtocol(managedChannel),
      "server_managed",
      "a server-stored channel came back with a different persistence mode",
    );
    assert.equal(
      await app.sidebar.channelPchatProtocol(plainChannel),
      "none",
      "an ordinary channel came back claiming a persistence mode it never had",
    );
  });

  it("does not mint a new at-rest key", () => {
    // Once, on the first ever start. A second occurrence means the key file
    // was not found where the rows expect it, and every sealed row in the
    // database is now unreadable - which presents as channels that are simply
    // empty, with nothing in the log to say why.
    const minted = server.log.split(KEY_MINTED).length - 1;
    assert.equal(
      minted,
      1,
      `Starling generated a fresh at-rest key on restart (${minted} in total), ` +
        "so the messages stored before it can no longer be decrypted",
    );
  });

  it("serves a client-sealed archive again", async () => {
    await app.sidebar.joinChannel(archiveChannel);
    await app.chat.messages.waitForText(archiveToken, 20_000);
  });

  it("serves a server-held archive again", async () => {
    // The mode whose whole point is that the server keeps the history, and so
    // the one with the most to lose to a restart. It is also the only mode
    // here whose rows the server can read, which is what the at-rest key
    // assertion above is really about.
    await app.sidebar.joinChannel(managedChannel);
    await app.chat.messages.waitForText(managedToken, 20_000);
  });

  it("does not bring a temporary channel back", async () => {
    assert.equal(
      await app.sidebar.hasChannel(tempChannel),
      false,
      "a temporary channel outlived the server, so the tree is being persisted " +
        "wholesale rather than by what asked to be kept",
    );
  });
});
