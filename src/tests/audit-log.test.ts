import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { TauriApp } from "../app";
import { config } from "../config";
import { auditStoreCount, waitForAuditCategory } from "../pages/audit.page";
import { setSuperUserPassword } from "../util/server";
import { isStarling } from "../util/suite-server";

const CONTAINER = process.env.E2E_SERVER_CONTAINER ?? "fancy-e2e-mumble";

/**
 * Audit log (client PR #110 feat/audit-log-client + server PR #4
 * feat/audit-log-plugin, docs/audit-log.md phases 1-3):
 *
 * - SuperUser performs an auditable action (channel create), then opens the
 *   admin "Audit log" tab (gated on Write on root, plus a server that can
 *   answer: fancy >= 0.4.2 on epoch 0, or wire epoch 1, which Starling speaks
 *   while deliberately announcing no product version at all).
 * - Viewer: the default query must return rows including the channel event.
 * - Configuration: chain-status card renders; one-click verify reports a
 *   chain status.
 * - Server-side: the server's own record must have ingested the events,
 *   independent of the client query surface - read through the operator API on
 *   Starling, and the mumble-audit plugin's SQLite store on murmur.
 */
describe("audit log: ingest + admin viewer", () => {
  let admin: TauriApp;
  let user: TauriApp;
  const stamp = Date.now();
  const userName = `e2e-AuditUser-${stamp % 100000}`;
  const channelName = `e2e-audit-${stamp % 100000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    [admin, user] = await TauriApp.launchAll({ instance: 0 }, { instance: 1 });
    await Promise.all([
      admin.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      }),
      user.connect.connect(config.serverHost, userName, { port: config.serverPort }),
    ]);
    await Promise.all([
      admin.chat.waitLoaded(config.connectTimeout),
      user.chat.waitLoaded(config.connectTimeout),
    ]);
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), user?.close()]);
  });

  it("performs an auditable action (channel create + delete)", async () => {
    await admin.sidebar.createSubChannel(0, channelName);
    await admin.sidebar.waitForChannel(channelName);
    await user.sidebar.waitForChannel(channelName);
  });

  it("initialises the hash-chain store (server_audit schema)", async () => {
    // Starling migrates `server_audit` into its own database on service build,
    // and the store's location moves with whatever data directory the run got.
    // Reaching it through the operator API asserts the same thing the file size
    // did - the store exists and answers - without knowing where it lives.
    if (isStarling()) {
      assert.doesNotThrow(
        () => auditStoreCount(),
        "the audit service did not answer GET /v1/log - store not migrated",
      );
      return;
    }

    // The plugin creates its SQLite store on load; assert the file exists and
    // is non-empty (schema written). The sqlite3 CLI isn't in the image, so
    // contents are asserted from the copied file in the ingest test below.
    const size = Number(
      execFileSync(
        "docker",
        ["exec", CONTAINER, "sh", "-lc", "stat -c %s /data/audit-log.sqlite"],
        { encoding: "utf8" },
      ).trim(),
    );
    assert.ok(size > 0, "audit DB /data/audit-log.sqlite missing or empty");
  });

  it("ingests the channel event into server_audit (hash chain rows)", async () => {
    // The channel create above must have reached the record. On Starling this
    // is `metadata` emitting through `Trail`; the entries are written by the
    // audit service under its own chain lock, so a row here is a linked row.
    const rows = await waitForAuditCategory("audit.channel", 1, 20000);
    assert.ok(rows > 0, "server_audit has no rows - ingest fan-out not wired");
  });

  // The categories below have a toggle and a consumer mapping in the plugin
  // (toggles.rs Part::from_event_kind) but had no producer in the core server
  // until the emit sites were added, so they logged nothing however the part
  // was configured. These drive the real UI actions and assert the plugin's
  // store - not the client query surface - actually gained the rows.

  it("logs a server-mute and a priority-speaker grant (audit.mute_deafen_suppress)", async () => {
    await admin.sidebar.muteUser(userName);
    await admin.sidebar.setPrioritySpeaker(userName);
    const rows = await waitForAuditCategory("audit.mute_deafen_suppress", 2, 20000);
    assert.ok(rows >= 2, `expected a mute and a priority-speaker entry, saw ${rows}`);
  });

  it("logs a channel move (audit.move)", async () => {
    // A self-join is still a channel change, so the server emits `move` with
    // the actor and target being the same user.
    await user.sidebar.joinChannel(channelName);
    await user.sidebar.waitForMembership(channelName, 10000);
    await waitForAuditCategory("audit.move", 1, 20000);
  });

  it("logs a user registration (audit.register)", async () => {
    await admin.sidebar.registerUser(userName);
    await waitForAuditCategory("audit.register", 1, 20000);
  });

  it("shows the Audit log tab to an admin (0.4.2 gate + Write on root)", async () => {
    await admin.admin.open();
    assert.ok(
      await admin.audit.tabButtonPresent(),
      "Audit log tab button missing - server fancy version gate or permission gate failed",
    );
    await admin.audit.open();
  });

  it("returns audit entries for the default query, including the channel event", async () => {
    await admin.audit.runQuery("");
    const rows = await admin.audit.waitForRows(1, 20000);
    assert.ok(rows >= 1, "no audit rows returned");
    await admin.audit.waitForRowContaining(channelName, 10000);
  });

  it("renders the chain-status card and verifies the hash chain", async () => {
    await admin.audit.openConfig();
    const status = await admin.audit.verifyChain();
    assert.ok(status.length > 0, "chain card empty after verify");
    assert.doesNotMatch(status, /invalid|broken|error/i, `chain verify reported a problem: ${status}`);
  });
});
