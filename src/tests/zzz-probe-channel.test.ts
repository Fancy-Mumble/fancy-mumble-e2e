/**
 * Probe for A4: which channel does each client land in?
 *
 * `registration`'s fourth subtest has bob send a message and admin wait for it.
 * It is green standalone and red whenever a suite that moves the SuperUser into
 * a channel has run first (reproduced with `pchat` + `registration`, three
 * minutes). Client profiles are `mkdtemp` and deleted per launch, so nothing
 * carries over on that side — which leaves server state.
 *
 * The hypothesis this settles: Starling restores a *registered* user's last
 * channel on login, so admin (SuperUser, reused by many suites) reconnects into
 * whatever channel the previous suite left it in, while bob — unregistered
 * until mid-test — starts in root. Two clients, two rooms, and the message is
 * never in the room admin is looking at.
 *
 * Run it *after* a suite that joins a channel, or it proves nothing:
 *   npm run e2e -- src/tests/pchat.multiclient.test.ts src/tests/zzz-probe-channel.test.ts
 *
 * `chat-header-title` carries the current channel's name, so that is the read.
 */

import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

describe("probe: landing channel", { concurrency: 1 }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  const bobName = `probe-bob-${Date.now() % 100000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    [admin, bob] = await TauriApp.launchAll({ instance: 0 }, { instance: 1 });
    await Promise.all([
      admin.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);
    await Promise.all([
      admin.chat.waitLoaded(config.connectTimeout),
      bob.chat.waitLoaded(config.connectTimeout),
    ]);
  });

  after(async () => {
    await Promise.all([admin?.close(), bob?.close()]);
  });

  it("reports where each client is", async () => {
    for (const [who, app] of [
      ["admin(SuperUser)", admin],
      ["bob(guest)", bob],
    ] as const) {
      const where: string = await app.driver.executeScript(`
        const title = document.querySelector('[data-testid="chat-header-title"]');
        const me = document.querySelector('[data-testid="channel-member"]');
        return JSON.stringify({
          channel: title ? title.textContent.trim() : null,
          firstMemberShown: me ? me.textContent.trim().slice(0, 30) : null,
        });
      `);
      console.log(`PROBE ${who}: ${where}`);
    }
  });
});
