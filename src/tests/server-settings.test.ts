import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Admin "Server settings" tab, against a server that speaks wire epoch 1.
 *
 * The surface existed on both ends and connected to neither. Epoch 0 broadcast
 * `FancyServerSettings` (152) to every root-Write admin after ServerSync, so
 * the client never had to ask; Starling answers a `ConfigQuery` on the
 * server-config service (1013) instead and broadcasts nothing. The client had
 * no query to send and no arm for the answer - `canon.rs` decoded the reply
 * and dropped it one match arm short of the store - so the pane reported
 * "Server settings aren't available. This server may not support runtime
 * settings" to an admin of a server that supports all of them.
 *
 * The write half was the same shape from the other side: an update from a
 * client was refused outright by `ServerConfigService::frame`, so a save would
 * have shown "Saved" and changed nothing.
 *
 * Both halves are asserted here through the surface an operator actually uses,
 * because the unit tests on either side can only prove their own half: the
 * client's canon test proves it emits the envelope, and Starling's proves it
 * answers one. Nothing but this proves they are the same envelope.
 */
describe("admin: server settings over the connected session", () => {
  let admin: TauriApp;
  const welcome = `e2e welcome ${Date.now() % 100000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();
  });

  after(async () => {
    await admin?.close();
  });

  it("shows the schema the server advertises rather than an empty pane", async () => {
    await admin.admin.open();
    await admin.admin.openServerSettingsTab();

    assert.equal(
      await admin.admin.serverSettingsUnavailable(),
      false,
      "the pane told an admin the server has no runtime settings",
    );

    // The form is built from the server's schema, not from anything the client
    // ships, so this asserts the schema arrived - not that it has any
    // particular shape.
    const labels = await admin.admin.serverSettingLabels();
    assert.ok(
      labels.includes("Welcome text"),
      `no settings were rendered; the pane offered: ${labels.join(", ") || "nothing"}`,
    );
  });

  it("edits the welcome text as formatted text rather than as markup", async () => {
    // The server declares this one `html`, and every client renders it through
    // an HTML allow-list, so the operator writing it gets a WYSIWYG field. That
    // makes the control a `contenteditable` rather than an input - which is the
    // half of this the page object has to know about.
    await admin.admin.setServerSetting("Welcome text", welcome);
    await admin.admin.saveServerSettings();

    // Read back from the snapshot the *server* sent in answer to the save,
    // rather than from what was typed: a save that was accepted and dropped
    // leaves the typed value on screen and nothing on the server. Compared as
    // text, because the editor stores `<p>...</p>` for a typed line.
    assert.equal(await admin.admin.serverSettingValue("Welcome text"), welcome);
  });

  it("still has it after the pane is reopened", async () => {
    // Reopening re-queries, so this is the round trip through the server's
    // store rather than through the pane's own state.
    await admin.admin.clickTopBack();
    await admin.admin.open();
    await admin.admin.openServerSettingsTab();

    assert.equal(await admin.admin.serverSettingValue("Welcome text"), welcome);
  });
});
