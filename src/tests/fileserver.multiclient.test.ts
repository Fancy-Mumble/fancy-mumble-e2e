import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * End-to-end file-server (HTTP plugin on :64739) upload across two real clients.
 *
 * SuperUser (admin) has the SHARE_FILES permission, so the composer exposes the
 * "File" attach option that uploads via the file-server plugin. The upload
 * round-trips through the plugin's HTTP server and posts a file message to the
 * channel, which the second client (bob) receives and renders as a file card.
 *
 * The native file picker is mocked in the webview (see ChatPage.uploadFileViaAttach)
 * so the flow runs unattended. Requires the file-server plugin enabled in the
 * server fixture (fixtures/mumble-server.ini).
 */

const FIXTURE = fileURLToPath(new URL("../../fixtures/upload-sample.txt", import.meta.url));
const FIXTURE_NAME = "upload-sample.txt";

// SKIPPED - blocked on file-server config discovery, not on this test.
// The file-server plugin is up and the client reaches it (its GET /capabilities
// probe returns 200, populating `fileServerCapabilities`). But the composer's
// attach->File flow (handleAttachFile) gates on the SEPARATE `fileServerConfig`,
// which only arrives via the server's on-connect `announce_to_client`
// (`fancy-file-server-config`) plugin-data message carrying `canShareFiles`.
// That plugin-data is not surfacing in the client under the e2e harness, so
// handleAttachFile early-returns and the upload dialog never opens. The client's
// `sendPluginData` is bricked, so it cannot request the config either. Needs
// diagnosis of the plugin-data delivery path (does on_client_connected fire and
// does the Fancy client negotiate/receive plugin-data in e2e?) before this can
// pass. The fixture + ChatPage.uploadFileViaAttach helper below are ready.
describe("file-server: upload via composer is delivered to other clients", { skip: "blocked: client does not receive fancy-file-server-config plugin-data in e2e" }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const channelName = `e2e-files-${Date.now() % 1000000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    // admin = SuperUser (has SHARE_FILES). Joining a channel also selects it,
    // which handleAttachFile requires (it early-returns when no channel is
    // selected).
    admin = await TauriApp.launch({ instance: 0 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();
    await admin.sidebar.createSubChannel(0, channelName);
    await admin.sidebar.joinChannel(channelName);

    bob = await TauriApp.launch({ instance: 1 });
    await bob.connect.connect(config.serverHost, `e2e-Bob-${Date.now() % 100000}`, {
      port: config.serverPort,
    });
    await bob.chat.waitLoaded();
    await bob.sidebar.waitForChannel(channelName);
    await bob.sidebar.joinChannel(channelName);
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close()]);
  });

  it("uploads a file that appears as a file card for both the uploader and a peer", async () => {
    await admin.chat.uploadFileViaAttach(FIXTURE);
    // The uploader sees the resulting file card.
    await admin.chat.waitForText(FIXTURE_NAME, 30000);
    // The peer receives the file message over the channel (uploaded via :64739).
    await bob.chat.waitForText(FIXTURE_NAME, 30000);
  });
});
