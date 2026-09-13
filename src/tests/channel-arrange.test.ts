import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { By, Origin, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { TauriApp } from "../app";
import { config } from "../config";
import { byTid, TID } from "../selectors";
import { isNebula } from "../ui-flavour";
import { setSuperUserPassword } from "../util/server";
import { contextClickPossiblyHidden, locateForGesture } from "../util/layout";
import { cssAttrEscape } from "../util/css";
import { delay } from "../util/wait";
import { dismissMenus } from "../util/nebula";
import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Nebula's arrange mode: the channel menu puts the tree into it, and a drag
 * then moves a channel among its siblings.
 *
 * The tree is only ever redrawn from the server's ChannelState, so an order
 * that changes on screen is an order the server accepted - one client is
 * enough to prove the round trip.
 */
describe(
  "channel arrange mode (nebula)",
  { skip: !isNebula && "arrange mode is Nebula's; Standard reorders with a plain drag" },
  () => {
    let app: TauriApp;
    let d: WebDriver;
    const prefix = `e2e-arr-${Date.now() % 1000000}`;
    const [a, b, c] = ["a", "b", "c"].map((suffix) => `${prefix}-${suffix}`);

    const row = (name: string) =>
      By.css(`[data-testid="${TID.channelItem}"][data-channel-name="${cssAttrEscape(name)}"]`);

    /** Our three channels, top to bottom, as the tree draws them. */
    const order = () =>
      d.executeScript<string[]>(
        `return [...document.querySelectorAll('[data-testid="${TID.channelItem}"]')]
           .map((el) => el.getAttribute("data-channel-name"))
           .filter((name) => name && name.startsWith(arguments[0]));`,
        prefix,
      );

    const waitForOrder = async (expected: string[]) => {
      let last: string[] = [];
      await d.wait(
        async () => {
          last = await order();
          return last.join() === expected.join();
        },
        config.waitTimeout,
        `channel order never became ${expected.join(", ")}`,
      ).catch((err: unknown) => {
        throw new Error(`${String(err)} (last seen: ${last.join(", ")})`);
      });
    };

    const box = (el: WebElement) =>
      d.executeScript<{ x: number; top: number; bottom: number }>(
        `const r = arguments[0].getBoundingClientRect();
         return { x: Math.round(r.left + r.width / 2), top: r.top, bottom: r.bottom };`,
        el,
      );

    /** Saved only when E2E_SCREENSHOT_DIR asks for it, for looking at the mode. */
    const shot = async (name: string) => {
      const dir = process.env.E2E_SCREENSHOT_DIR;
      if (dir) writeFileSync(path.join(dir, `${name}.png`), await d.takeScreenshot(), "base64");
    };

    /** Press on a row, carry it to `toY` in a few steps, and let go. */
    const dragTo = async (name: string, toY: number, midShot?: string) => {
      const from = await box(await d.findElement(row(name)));
      const startY = Math.round((from.top + from.bottom) / 2);
      const actions = d
        .actions({ async: true })
        .move({ origin: Origin.VIEWPORT, x: from.x, y: startY })
        .press()
        .move({ origin: Origin.VIEWPORT, x: from.x, y: startY + (toY > startY ? 8 : -8), duration: 100 })
        .move({ origin: Origin.VIEWPORT, x: from.x, y: Math.round(toY), duration: 400 })
        .pause(150);
      await actions.perform();
      if (midShot) await shot(midShot);
      await d.actions({ async: true }).release().perform();
    };

    before(async () => {
      setSuperUserPassword("testpassword");
      app = await TauriApp.launch({ instance: 0 });
      d = app.driver;
      await app.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      });
      await app.chat.waitLoaded();
    });

    after(async () => {
      await app?.close();
    });

    it("SuperUser makes three sibling channels, ordered by name", async () => {
      for (const name of [a, b, c]) {
        // Retried: the dialog's inputs can re-render under the driver, and a
        // stale element there says nothing about arranging.
        for (let attempt = 0; ; attempt++) {
          try {
            if ((await d.findElements(row(name))).length === 0) await app.sidebar.createSubChannel(0, name);
            await app.sidebar.waitForChannel(name);
            break;
          } catch (err) {
            await dismissMenus(d);
            if (attempt >= 2) throw err;
            await delay(500);
          }
        }
      }
      await waitForOrder([a, b, c]);
    });

    it("SuperUser sits in the channel that will be moved", async () => {
      await app.sidebar.joinChannel(c);
      await d.wait(
        until.elementLocated(By.css(`${`[data-testid="${TID.channelItem}"]`}[data-channel-name="${cssAttrEscape(c)}"][data-joined="true"]`)),
        config.waitTimeout,
        "never joined the channel to move",
      );
    });

    it("the channel menu enters arrange mode", async () => {
      // Retried as a whole, like the page object's own menu actions: straight
      // after the channel dialog closes, a menu click can land on its fading
      // backdrop and do nothing.
      for (let attempt = 0; ; attempt++) {
        try {
          await contextClickPossiblyHidden(d, await locateForGesture(d, row(a)));
          await delay(400);
          const toggle = await d.wait(until.elementLocated(byTid(TID.channelArrangeToggle)), 5000);
          await d.wait(until.elementIsVisible(toggle), 3000);
          await toggle.click();
          await d.wait(until.elementLocated(byTid(TID.channelArrangeBar)), 4000);
          break;
        } catch (err) {
          await dismissMenus(d);
          if (attempt >= 3) throw err;
        }
      }
      await delay(300);
      await shot("arrange-mode");
      // The channel you are in has its permissions queried, unlike the rest,
      // so it is the one row a wrong permission check would leave without a handle.
      const arrangeable = await d.findElement(row(c)).getAttribute("data-arrangeable");
      assert.equal(arrangeable, "true", "the joined channel has no handle");
    });

    it("dragging the last channel onto the first puts it in front", async () => {
      const first = await box(await d.findElement(row(a)));
      await dragTo(c, first.top + 4, "arrange-mid-drag");
      await waitForOrder([c, a, b]);
    });

    it("dragging a channel past its last sibling puts it at the end", async () => {
      await delay(300);
      const last = await box(await d.findElement(row(b)));
      await dragTo(a, last.bottom - 2);
      await waitForOrder([c, b, a]);
    });

    it("Done leaves arrange mode", async () => {
      await (await d.findElement(byTid(TID.channelArrangeDone))).click();
      await d.wait(
        async () => (await d.findElements(byTid(TID.channelArrangeBar))).length === 0,
        5000,
        "the arrange bar stayed up after Done",
      );
      assert.equal(await d.findElement(row(c)).getAttribute("data-arrangeable"), null);
    });
  },
);
