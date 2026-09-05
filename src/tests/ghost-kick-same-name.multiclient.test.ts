import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { delay } from "../util/wait";

/**
 * Reported from a live desktop: signing in as an already-connected identity
 * evicts the older session, and the evicted client was left in "a strange half
 * state, where some information is there, some isn't", with no word of what
 * happened.
 *
 * The server tells the ghost nothing - it is out of the gateway registry
 * before the ordinary disconnect path builds its `UserRemove`, so the ghost
 * only ever sees its socket close. That is the same thing a dropped link looks
 * like, so this test is also the general "the link went away" case.
 *
 * Two Fancy clients rather than the reporter's stock-client pair: the eviction
 * is keyed on the name, so which client holds the second connection makes no
 * difference to what the first one is told.
 */
describe("same-name eviction leaves the evicted client in a stated, empty state", () => {
  let ghost: TauriApp;
  let usurper: TauriApp;
  const name = `e2e-ghost-${Date.now() % 100000}`;

  before(async () => {
    ghost = await TauriApp.launch({ instance: 0 });
    await ghost.connect.connect(config.serverHost, name, { port: config.serverPort });
    await ghost.chat.waitLoaded(config.connectTimeout);
  });

  after(async () => {
    await usurper?.close();
    await ghost?.close();
  });

  it("tells the evicted client it is no longer connected", async () => {
    // The harness's page objects are Standard's, so the ghost connects there
    // and is then reloaded into Nebula: the backend session outlives a webview
    // reload, so what Nebula draws afterwards is a real connected session.
    const url = new URL(await ghost.driver.getCurrentUrl());
    url.searchParams.set("ui", "nebula");
    await ghost.driver.get(url.href);
    await ghost.driver.wait(
      async () =>
        (await ghost.driver.findElements({ css: '[data-testid="nebula-client-root"]' })).length > 0,
      30000,
      "Nebula never rendered",
    );
    await delay(2000);

    // The same name again, from a second client: the server evicts the first.
    usurper = await TauriApp.launch({ instance: 1 });
    await usurper.connect.connect(config.serverHost, name, { port: config.serverPort });
    await usurper.chat.waitLoaded(config.connectTimeout);

    // Give the eviction time to travel and the first client time to react.
    await delay(6000);

    const seen = await ghost.driver.executeScript<{
      bodyText: string;
      dialogs: number;
      channelRows: number;
      html: string;
    }>(`
      const dialogs = document.querySelectorAll('[role="dialog"]').length;
      const channelRows = document.querySelectorAll('[data-testid="channel-item"], [data-channel-id]').length;
      return {
        bodyText: document.body.innerText.slice(0, 2000),
        dialogs,
        channelRows,
        html: document.body.innerHTML.length + "",
      };
    `);

    console.log("=== GHOST CLIENT AFTER EVICTION ===");
    console.log("dialogs:", seen.dialogs, "channelRows:", seen.channelRows);
    console.log("--- visible text ---");
    console.log(seen.bodyText);
    console.log("=== END ===");

    // It has to say what happened...
    assert.ok(
      /disconnect|connection|lost|another device/i.test(seen.bodyText),
      "the evicted client shows no word of the disconnect",
    );
    // ...and it must stop pretending to be connected. The reported bug was the
    // chrome of a live session drawn around a dead one: a channel list with
    // nothing in it, a placeholder inviting the user to pick a channel, and a
    // composer that cannot send.
    assert.ok(
      !/Pick a channel|Choose a conversation|Message #/i.test(seen.bodyText),
      `the evicted client still renders the connected chrome:\n${seen.bodyText}`,
    );
  });
});
