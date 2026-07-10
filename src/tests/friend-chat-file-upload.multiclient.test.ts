import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Uploading a file into a 1:1 friend chat must work while *peeking* it.
 *
 * A friend chat is a detached channel the client peeks (reads without joining),
 * so the uploader sits in another channel (root) while sharing into the friend
 * room. The file-server's upload guard used to require `current_channel == the
 * target channel` ("channel mismatch: you can only upload from the channel you
 * are in"), which 403'd every peeked-chat upload. It now gates on channel
 * *access* instead, so an accessible-but-unjoined room is allowed.
 *
 * admin = SuperUser, which holds SHARE_FILES, so the composer exposes the File
 * attach option (the native picker is mocked in uploadFileViaAttach).
 *
 * Requires the file-server + friends plugins (mumble-server:dev).
 *
 * SKIPPED for the same reason as fileserver.multiclient.test.ts: the composer's
 * attach->File flow gates on the `fancy-file-server-config` plugin-data
 * (`canShareFiles`) which does not surface under the e2e harness, so the upload
 * dialog never opens (the Upload button is never rendered) and the HTTP upload -
 * where the 403 would occur - is never reached. The fix itself is covered by the
 * file-server unit tests `upload_to_accessible_channel_is_allowed_without_being_in_it`
 * and `upload_to_inaccessible_channel_is_rejected` (http/upload.rs), which encode
 * exactly this scenario (uploading to a channel you have access to but are not in).
 */

const FIXTURE = fileURLToPath(new URL("../../fixtures/upload-sample.txt", import.meta.url));
const FIXTURE_NAME = "upload-sample.txt";

describe("friend chat 1:1: file upload while peeking", { skip: "blocked: client does not receive fancy-file-server-config plugin-data in e2e (see fileserver.multiclient.test.ts); fix covered by file-server http/upload.rs unit tests" }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-bob-${sfx}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    bob = await TauriApp.launch({ instance: 1 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await admin.chat.waitLoaded();
    await bob.chat.waitLoaded();
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close()]);
  });

  it("uploads a file into the peeked friend chat (no channel-mismatch 403)", async () => {
    // bob must be registered for the E2E friend channel to be provisioned.
    await admin.chat.waitForMember(bobName);
    await admin.sidebar.registerUser(bobName);
    await admin.chat.waitForRegistered(bobName);

    // Open the friend chat (peek - admin stays in root, the friend room is only
    // selected, never joined).
    await admin.chat.openDirectMessage(bobName);
    await admin.chat.waitForE2EBadge();

    // Upload a file into the peeked chat. With the bug this 403s ("channel
    // mismatch: you can only upload from the channel you are in") and no file
    // card ever appears; the fix gates on channel access so the upload lands.
    await admin.chat.uploadFileViaAttach(FIXTURE);
    await admin.chat.waitForText(FIXTURE_NAME, 30000);
    await bob.chat.openDirectMessage("SuperUser");
    await bob.chat.waitForText(FIXTURE_NAME, 30000);
  });
});
