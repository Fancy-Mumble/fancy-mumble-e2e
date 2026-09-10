import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { By } from "selenium-webdriver";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { bridgeMissing } from "../util/preconditions";

/**
 * A signal_v1 channel is the one place where the client is the only archive.
 *
 * The mode keeps no server-side history on purpose - a late joiner must never
 * read what was said before it arrived - so `fetch_channel_history` skips the
 * request entirely and the local encrypted cache
 * (`signal_message_cache.enc`) is the sole copy of the transcript. That makes
 * "was the cache written?" the whole of whether a message still exists.
 *
 * It was not. The only writers were the three disconnect paths, so a client
 * that ended any other way - the window closed, the process killed - dropped
 * everything said that session, permanently and silently. The channel came
 * back empty and there was nowhere left to fetch it from.
 *
 * So this test ends the client the way that used to lose the data: no
 * disconnect, just gone. What it asserts is the guarantee the cache is for -
 * a message survives the client that received it.
 */

/**
 * Long enough to cover the cache's own save interval plus a flush tick.
 *
 * The write is deliberately throttled rather than per-message (a full save
 * re-encrypts the whole cache), so a message is owed a write for up to that
 * interval. Waiting it out is what makes the kill below a fair test of
 * durability instead of a race against the timer.
 */
const FLUSH_WINDOW_MS = 25_000;

/** A public image URL, sent as a link the way a user would paste one. */
const IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png";

/** Whether the transcript currently renders an `img` served from `url`. */
async function rendersImage(app: TauriApp, url: string): Promise<boolean> {
  const found = await app.driver.findElements(By.css(`img[src*="${url}"]`));
  return found.length > 0;
}

describe("signal pchat: a message outlives the client that received it", { skip: bridgeMissing() }, () => {
  let app: TauriApp | undefined;
  /** Reused by the second launch - the same profile *is* the same user. */
  let profile: string | undefined;

  after(async () => {
    await app?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("restores text and a linked image after the client is killed", async () => {
    setSuperUserPassword("testpassword");
    profile = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-signal-"));
    const channelName = `e2e-sig-restart-${Date.now() % 1000000}`;
    const token = `sig-restart-${Date.now()}`;

    const first = (app = await TauriApp.launch({ instance: 0, dataDir: profile }));
    await first.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await first.chat.waitLoaded();
    await first.sidebar.createSubChannel(0, channelName, { pchatProtocol: "signal_v1" });
    await first.sidebar.joinChannel(channelName);

    await first.chat.composer.send(token);
    await first.chat.messages.waitForText(token, 25000);
    await first.chat.composer.send(IMAGE_URL);
    await first.chat.messages.waitForText(IMAGE_URL, 25000);

    // Whether a bare image link renders as an `img` is the renderer's business
    // and not what this test is about; captured here so the assertion after
    // the restart is "the transcript came back the same" rather than a guess.
    const imageWasRendered = await rendersImage(first, IMAGE_URL);

    await first.driver.sleep(FLUSH_WINDOW_MS);

    // No disconnect: `close` quits the session and kills the process, which is
    // exactly the ending that used to take the transcript with it.
    await first.close();

    const second = (app = await TauriApp.launch({ instance: 0, dataDir: profile }));
    await second.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await second.chat.waitLoaded();
    await second.sidebar.waitForChannel(channelName);
    await second.sidebar.joinChannel(channelName);

    await second.chat.messages.waitForText(token, 25000).catch(() => undefined);
    assert.equal(
      await second.chat.messages.hasText(token),
      true,
      "the text message did not survive the client restart - signal_v1 has no " +
        "server-side history, so the local cache was the only copy of it",
    );
    assert.equal(
      await second.chat.messages.hasText(IMAGE_URL),
      true,
      "the image link did not survive the client restart",
    );
    assert.equal(
      await rendersImage(second, IMAGE_URL),
      imageWasRendered,
      "the image link came back as text the client no longer renders as an image",
    );
  });
});
