import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Channel management requires admin rights, so the admin client connects as
 * SuperUser (driving the password dialog). It creates a sub-channel under root;
 * a second, anonymous client must then see that channel appear - proving the
 * create round-trips through the server to every client.
 */
describe("channels: SuperUser create + cross-client visibility", () => {
  let admin: TauriApp;
  let observer: TauriApp | undefined;
  const channelName = `e2e-ch-${Date.now() % 1000000}`;

  before(async () => {
    // Work around the mumble-docker entrypoint not applying the SU password.
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), observer?.close()]);
  });

  it("SuperUser creates a sub-channel under root", async () => {
    await admin.sidebar.createSubChannel(0, channelName);
    await admin.sidebar.waitForChannel(channelName);
  });

  it("a second client sees the newly created channel", async () => {
    observer = await TauriApp.launch({ instance: 1 });
    await observer.connect.connect(config.serverHost, `e2e-Obs-${Date.now() % 100000}`, {
      port: config.serverPort,
    });
    await observer.chat.waitLoaded();
    await observer.sidebar.waitForChannel(channelName, 25000);
  });
});
