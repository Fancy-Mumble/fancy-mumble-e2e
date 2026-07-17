import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, globSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { until } from "selenium-webdriver";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { byTid, TID } from "../selectors";
import { delay } from "../util/wait";

/**
 * Regression for Fancy-Mumble/FancyMumble#107 ("Chat's Break - Key
 * challenge failed"): a fancy/Signal channel became permanently unusable
 * after a later login - "Key challenge failed - your encryption key was
 * rejected by the server. All local keying material ... has been purged."
 *
 * Root cause: the server's per-channel challenge reference HMAC lives in
 * memory forever, so when a returning client's archive key differs from
 * the one the reference was established with (a deterministic per-identity
 * derivation - it changes whenever the identity seed does, e.g. after an
 * app-data loss), every challenge fails, the client purges its keys, and
 * with no other key holder the channel can never be recovered.
 *
 * Two recovery paths are locked in here:
 *
 *  1. Sole holder, seed lost: the server now detects that the failing
 *     session is the channel's ONLY recorded holder, drops the stale
 *     reference, and re-challenges - the channel heals automatically on
 *     the same login, no user action needed.
 *
 *  2. Another identity is (still) a recorded holder, so the strict reject
 *     stands: the failure banner now offers KeyOwner admins a "Reset
 *     channel key" takeover action instead of being a dead end.
 */
describe("pchat: key-challenge failure is recoverable (#107)", () => {
  let admin: TauriApp | undefined;
  const channelName = `e2e-keychal-${Date.now() % 1000000}`;
  // Fixed app-data dir reused across relaunches so the certificate (and
  // thus the recorded holder identity) survives while we tamper with the
  // pchat seed underneath it.
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-keychal-"));

  before(() => {
    setSuperUserPassword("testpassword");
  });

  after(async () => {
    await admin?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Connect the current `admin` instance as SuperUser and wait for chat. */
  async function connectAdmin(): Promise<void> {
    if (!admin) throw new Error("admin not launched");
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();
  }

  /**
   * Send `token` and wait for it to render. The composer is disabled
   * while the key challenge is unresolved (sendBlocked), so retry until
   * the pipeline is usable or the deadline passes.
   */
  async function sendUntilDelivered(app: TauriApp, token: string, timeout = 30000): Promise<void> {
    const deadline = Date.now() + timeout;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        await app.chat.sendMessage(token);
        await app.chat.waitForText(token, 5000);
        return;
      } catch (e) {
        lastErr = e;
        await delay(1000);
      }
    }
    throw new Error(`message "${token}" never delivered: ${lastErr}`);
  }

  it("sets up a fancy channel and chats normally (session 1)", async () => {
    admin = await TauriApp.launch({
      instance: 0,
      extraEnv: { FANCY_E2E_DATA_DIR: dataDir },
    });
    await connectAdmin();

    await admin.sidebar.createSubChannel(0, channelName, {
      pchatProtocol: "fancy_v1_full_archive",
    });
    await admin.sidebar.waitForChannel(channelName);
    await admin.sidebar.joinChannel(channelName);

    const token = `e2e-keychal-s1-${Date.now()}`;
    await sendUntilDelivered(admin, token);
  });

  it("recovers automatically when the sole holder's seed was lost", async () => {
    // Simulate the ticket's "some time later" identity loss: close the
    // app and delete ONLY the pchat seed, keeping the TLS certificate.
    // The relaunched client derives a different archive key for the same
    // cert - the exact sole-holder mismatch that used to brick the
    // channel with "Key challenge failed" forever.
    await admin?.close();
    const seeds = globSync(path.join(dataDir, "identities", "*", "pchat_seed.bin"));
    assert.ok(seeds.length > 0, `no pchat_seed.bin found under ${dataDir}`);
    for (const seed of seeds) rmSync(seed);

    admin = await TauriApp.launch({
      instance: 0,
      extraEnv: { FANCY_E2E_DATA_DIR: dataDir },
    });
    await connectAdmin();
    await admin.sidebar.waitForChannel(channelName);
    await admin.sidebar.joinChannel(channelName);

    // The fixed server resets the stale challenge reference for a sole
    // recorded holder and re-challenges; the channel must become usable
    // in the same login, with no revoked banner blocking the composer.
    const token = `e2e-keychal-s2-${Date.now()}`;
    await sendUntilDelivered(admin, token);
  });

  it("offers a KeyOwner admin the banner takeover when another holder is recorded", async () => {
    if (!admin) throw new Error("admin not launched");
    // A second, fresh identity (default isolated data dir -> new cert +
    // new seed) connects as SuperUser. The previous identity is still a
    // recorded holder, so this client's challenge legitimately fails and
    // it lands on the revoked banner - which must now offer the KeyOwner
    // "Reset channel key" takeover instead of a dead end.
    const second = await TauriApp.launch({ instance: 1 });
    try {
      await second.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      });
      await second.chat.waitLoaded();
      await second.sidebar.waitForChannel(channelName);
      await second.sidebar.joinChannel(channelName);

      const resetBtn = await second.driver.wait(
        until.elementLocated(byTid(TID.pchatResetKey)),
        30000,
        "the challenge-failed banner never offered the Reset channel key action",
      );
      await resetBtn.click();

      const dialog = await second.driver.wait(
        until.elementLocated(byTid(TID.confirmDialog)),
        8000,
        "reset-key confirmation dialog never appeared",
      );
      await second.driver.wait(
        async () => (await dialog.getText()).includes(channelName),
        5000,
        "reset-key confirmation never named the channel",
      );
      await dialog.findElement(byTid(TID.confirmDialogConfirm)).click();

      // Takeover re-establishes this client as sole key authority; the
      // banner clears once its fresh proof verifies and chat works again.
      const token = `e2e-keychal-s3-${Date.now()}`;
      await sendUntilDelivered(second, token);
    } finally {
      await second.close();
    }
  });
});
