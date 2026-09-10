import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";

/**
 * Mute has to be a state the client remembers, not a side effect of one button.
 *
 * The suite already proves the sidebar's own mute toggle survives a reconnect
 * (`voice-state-sync`), and that was the whole of the coverage - which is why
 * the client could lose every *other* way of muting and stay green. The
 * preference was written by the store's `toggleMute` action, so a mute made
 * from the tray menu or the global Ctrl+Shift+M shortcut changed the real state
 * and recorded nothing: reconnect, and you were live again without having asked
 * to be.
 *
 * Both tests here are about the same claim from two directions - what the user
 * last chose is what they come back as, whichever control they chose it with,
 * and whether "coming back" means reconnecting or restarting the client.
 */
describe("mute persistence: whatever muted you, you stay muted", () => {
  let app: TauriApp | undefined;
  /** Kept between the two launches of the restart test - it *is* the test. */
  let profile: string | undefined;

  after(async () => {
    await app?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  /** Reconnect to the same server as the same user, as the user would. */
  async function reconnect(client: TauriApp, username: string): Promise<void> {
    await client.chat.disconnect();
    await client.connect.waitReady(config.connectTimeout);
    await client.connect.connect(config.serverHost, username, { port: config.serverPort });
    await client.chat.waitLoaded();
  }

  it("restores a mute that was made outside the UI", async () => {
    const username = `e2e-Mute-${Date.now() % 100000}`;
    // A local binding as well as the shared one: the shared one is what
    // `after` closes, and a `TauriApp | undefined` cannot be used inside the
    // wait closures below.
    const client = (app = await TauriApp.launch({ instance: 0 }));
    await client.connect.connect(config.serverHost, username, { port: config.serverPort });
    await client.chat.waitLoaded();

    // Voice on through the dock, then muted the way the tray and the global
    // shortcut do it - the two controls WebDriver cannot reach.
    await client.chat.voice.tapMute();
    await client.driver.wait(async () => (await client.chat.voice.state()) === "active", 8000);
    await client.chat.voice.toggleOutsideTheUi();
    await client.driver.wait(async () => (await client.chat.voice.state()) === "muted", 8000);

    await reconnect(client, username);
    await client.chat.voice.waitSelfMuted(true, 20000).catch(() => undefined);
    assert.equal(
      await client.chat.voice.state(),
      "muted",
      "a mute made from the tray / global shortcut was not restored",
    );
    assert.equal(
      (await client.chat.roster.selfVoiceFlags()).muted,
      true,
      "the client restored the mute but its own indicator does not show it",
    );

    // The other direction, because "always come back muted" would pass the
    // assertion above and be just as wrong: unmuting outside the UI has to
    // stick too.
    await client.chat.voice.toggleOutsideTheUi();
    await client.driver.wait(async () => (await client.chat.voice.state()) === "active", 8000);
    await reconnect(client, username);
    await client.chat.voice.waitSelfMuted(false, 20000).catch(() => undefined);
    assert.equal(
      await client.chat.voice.state(),
      "active",
      "an unmute made from the tray / global shortcut was not restored",
    );
  });

  it("restores a mute across a full client restart", async () => {
    // A reconnect keeps the preference in memory; only a restart proves it
    // reached disk. Same profile directory both times, so the second launch is
    // the same user coming back rather than a new one.
    profile = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-profile-"));
    const username = `e2e-Restart-${Date.now() % 100000}`;

    await app?.close();
    const first = (app = await TauriApp.launch({ instance: 0, dataDir: profile }));
    await first.connect.connect(config.serverHost, username, { port: config.serverPort });
    await first.chat.waitLoaded();
    await first.chat.voice.ensureMuted();
    await first.close();

    const second = (app = await TauriApp.launch({ instance: 0, dataDir: profile }));
    await second.connect.connect(config.serverHost, username, { port: config.serverPort });
    await second.chat.waitLoaded();
    await second.chat.voice.waitSelfMuted(true, 20000).catch(() => undefined);
    assert.equal(
      await second.chat.voice.state(),
      "muted",
      "the muted state did not survive a client restart",
    );
  });
});
