import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";

/**
 * Smoke test: the single most important path. Proves the whole tauri-driver +
 * Selenium + real-server stack works before any broader scenarios are built on
 * top of it. Launch the real app, connect to the Docker server, reach the chat
 * view, and round-trip a text message through the server back into the UI.
 */
describe("smoke: connect + chat", () => {
  let app: TauriApp;

  before(async () => {
    app = await TauriApp.launch();
  });

  after(async () => {
    await app?.close();
  });

  it("connects to the Mumble server and reaches the chat view", async () => {
    const username = `e2e-Alice-${Date.now() % 100000}`;
    await app.connect.connect(config.serverHost, username, { port: config.serverPort });
    await app.chat.waitLoaded(config.connectTimeout);
  });

  it("sends a text message that renders in the chat", async () => {
    const token = `e2e-msg-${Date.now()}`;
    await app.chat.sendMessage(token);
    await app.chat.waitForText(token);
  });
});
