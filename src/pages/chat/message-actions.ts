import { By, until, type WebDriver } from "selenium-webdriver";
import { config } from "../../config";
import { delay } from "../../util/wait";
import { xpathLiteral } from "../../util/xpath";
import { isNebula, menuLabel } from "../../ui-flavour";
import { dismissMenus } from "../../util/nebula";
import { contextClickPossiblyHidden, locateForGesture } from "../../util/layout";
import { MessageList } from "./message-list";

/**
 * Actions on a single message - the per-message menu and the reaction bar
 * (Nebula's `MessageMenu.tsx` + `ReactionBar.tsx`, Standard's `message/` and
 * `reaction/`).
 *
 * Both ways in reveal the same controls: hovering a row shows the action bar,
 * right-clicking it opens the context menu, and each renders its own copy of
 * the Pin button and the quick-reaction emoji. {@link openMenuFor} is the one
 * gesture that gets there, so the pin and reaction paths cannot drift apart on
 * it again - they used to hand-roll it separately, and only one of them had
 * learned about scrolling and the synthetic-event fallback.
 */
export class MessageActions {
  constructor(private readonly d: WebDriver) {}

  /** Right-click a persistent message and choose Pin/Unpin. */
  async togglePin(messageText: string): Promise<void> {
    await this.openMenuFor(messageText);
    // Either verb, and either pack's wording for it: Nebula's menu names the
    // destination ("Pin to channel"), Standard's says only "Pin".
    const selector = By.xpath(
      `//*[self::button or @role='menuitem']` +
        `[normalize-space(.)=${xpathLiteral(menuLabel("pinMessage"))}` +
        ` or normalize-space(.)=${xpathLiteral(menuLabel("unpinMessage"))}]`,
    );
    try {
      await this.d.wait(until.elementLocated(selector), 5000);
    } catch (err) {
      // Say what the menu *did* offer. A caption that moved reads exactly like
      // a menu that never opened, and the two have nothing in common.
      const offered = await this.menuCaptions();
      if (isNebula) await dismissMenus(this.d);
      throw new Error(`${(err as Error).message}\nthe menu offered: ${offered}`);
    }
    for (const candidate of await this.d.findElements(selector)) {
      if (await candidate.isDisplayed()) {
        await candidate.click();
        return;
      }
    }
    // Never leave the context menu behind: its backdrop would take every later
    // click in the file, and the next test would fail naming the composer.
    if (isNebula) await dismissMenus(this.d);
    throw new Error(`no visible Pin/Unpin button for message "${messageText}"`);
  }

  /**
   * Right-click a message (located by its text) and pick a quick-reaction
   * emoji. The message must carry a message_id (pchat) for the context menu to
   * be wired; otherwise the wrapper has no data-msg-id / onContextMenu.
   */
  async react(messageText: string, emoji: string): Promise<void> {
    await this.openMenuFor(messageText);
    // The quick-reaction row renders a beat behind the menu items.
    await delay(500);

    // The context menu's copy first, and it is not a preference: the menu
    // renders a full-screen overlay under itself (MessageContextMenu.tsx), so
    // the action bar's copy is visible, hit-testable, and *behind* it. Clicking
    // that one is an ElementClickInterceptedError several frames from anything
    // to do with reactions, which is how this read as a server failure.
    const inMenu = `//button[normalize-space(.)=${xpathLiteral(emoji)}]` +
      `[not(ancestor::*[@data-action-bar])]`;
    const anywhere = `//button[normalize-space(.)=${xpathLiteral(emoji)}]`;
    for (const xpath of [inMenu, anywhere]) {
      for (const btn of await this.d.findElements(By.xpath(xpath))) {
        if (!(await btn.isDisplayed())) continue;
        try {
          await btn.click();
          return;
        } catch {
          // Intercepted or gone stale: try the next candidate rather than
          // failing on the first one the overlay happens to cover.
        }
      }
    }
    throw new Error(`No clickable '${emoji}' quick-reaction button after opening message actions`);
  }

  /** Wait for a reaction pill to appear (its aria-label starts with the emoji). */
  async waitForReaction(emoji: string, timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      until.elementLocated(By.xpath(`//button[starts-with(@aria-label, ${xpathLiteral(emoji)})]`)),
      timeout,
    );
  }

  /**
   * Reveal the per-message controls for the message carrying `messageText`.
   *
   * Located through `locateForGesture`: the Actions API does not scroll to its
   * target, so a message below the fold of the river fails as
   * MoveTargetOutOfBounds - or, worse, opens no menu at all.
   *
   * Hover first, because the action bar is revealed on hover and the context
   * menu is the other way in. Both render the same buttons, and the action
   * bar's copies stay in the DOM while hidden - so a caller taking the first
   * match gets an element that exists, is found, and cannot be clicked.
   */
  private async openMenuFor(messageText: string): Promise<void> {
    const wrapper = await locateForGesture(this.d, MessageList.rowByText(messageText));
    await this.d.actions().move({ origin: wrapper }).perform();
    await contextClickPossiblyHidden(this.d, wrapper);
    // Confirm the menu actually opened, and dispatch the event directly if it
    // did not. The Actions API aims at the element's centre, which on a wide
    // river is padding to the side of the bubble - the row still owns the
    // handler, but whatever is under the pointer can swallow the gesture
    // first. The synthetic event goes to the row that carries the handler.
    if ((await this.d.findElements(By.css('[role="menuitem"]'))).length === 0) {
      await this.d.executeScript(
        `const r = arguments[0].getBoundingClientRect();
         arguments[0].dispatchEvent(new MouseEvent("contextmenu", {
           bubbles: true, cancelable: true, view: window,
           clientX: Math.round(r.left + 24), clientY: Math.round(r.top + r.height / 2),
         }));`,
        wrapper,
      );
      await delay(300);
    }
  }

  /** Every caption currently on screen in a menu, for a failure to quote. */
  private async menuCaptions(): Promise<string> {
    const items = await this.d.executeScript<string>(`
      return [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => (e.textContent || "").trim())
        .filter(Boolean)
        .join(" | ");
    `);
    return items || "(no menu was open)";
  }
}
