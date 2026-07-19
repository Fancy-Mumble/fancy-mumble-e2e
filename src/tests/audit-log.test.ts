import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

const CONTAINER = process.env.E2E_SERVER_CONTAINER ?? "fancy-e2e-mumble";

/**
 * Audit log (client PR #110 feat/audit-log-client + server PR #4
 * feat/audit-log-plugin, docs/audit-log.md phases 1-3):
 *
 * - SuperUser performs an auditable action (channel create), then opens the
 *   admin "Audit log" tab (gated at server fancy >= 0.4.2 + Write on root).
 * - Viewer: the default query must return rows including the channel event.
 * - Configuration: chain-status card renders; one-click verify reports a
 *   chain status.
 * - Server-side: the mumble-audit plugin's SQLite store inside the container
 *   must have ingested the events (checked via docker exec), independent of
 *   the client query surface.
 */
describe("audit log: ingest + admin viewer", () => {
  let admin: TauriApp;
  let user: TauriApp;
  const stamp = Date.now();
  const userName = `e2e-AuditUser-${stamp % 100000}`;
  const channelName = `e2e-audit-${stamp % 100000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    user = await TauriApp.launch({ instance: 1 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await user.connect.connect(config.serverHost, userName, { port: config.serverPort });
    await admin.chat.waitLoaded(config.connectTimeout);
    await user.chat.waitLoaded(config.connectTimeout);
    await admin.chat.allowServerPlugins();
    await user.chat.allowServerPlugins();
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), user?.close()]);
  });

  it("performs an auditable action (channel create + delete)", async () => {
    await admin.sidebar.createSubChannel(0, channelName);
    await admin.sidebar.waitForChannel(channelName);
    await user.sidebar.waitForChannel(channelName);
  });

  it("initialises the plugin's hash-chain store (server_audit schema)", async () => {
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
    // Poll the store for the channel-create event. This is the phase 1-2
    // ingest pipeline; it activates only once the host gains the
    // on_server_event fan-out (ABI bump + murmur emitServerEvent calls) -
    // red until that lands.
    const tmp = `${process.env.TEMP ?? "/tmp"}/e2e-audit-${stamp}.sqlite`;
    const deadline = Date.now() + 15000;
    let rows = 0;
    while (Date.now() < deadline && rows === 0) {
      execFileSync("docker", ["cp", `${CONTAINER}:/data/audit-log.sqlite`, tmp]);
      rows = Number(
        execFileSync(
          process.env.E2E_PYTHON ?? "py",
          ["-c",
            `import sqlite3;print(sqlite3.connect(r'${tmp}').execute("SELECT count(*) FROM server_audit").fetchone()[0])`],
          { encoding: "utf8" },
        ).trim(),
      );
      if (rows === 0) await new Promise((r) => setTimeout(r, 1500));
    }
    assert.ok(rows > 0, "server_audit has no rows - ingest fan-out not wired");
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
