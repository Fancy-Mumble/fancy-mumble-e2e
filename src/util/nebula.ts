import { By, Key, error, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { config } from "../config";
import { delay } from "./wait";

/**
 * Nebula-specific navigation, kept out of the page objects.
 *
 * Nebula draws the same client with a different frame: there are no
 * Channels/Members sidebar tabs, the roster is a panel the chat header opens,
 * and adding a server is a dialog rather than a wizard. The page objects branch
 * on `isNebula` and call in here, so what is genuinely pack-specific lives in
 * one file instead of spreading through nine.
 */

/**
 * The first *displayed* element matching `by`, or null.
 *
 * Nebula draws the same control more than once - the server rail's strip and
 * its pinned panel both carry an "add server" button, and only one of them is
 * on screen. Taking `findElements()[0]` picks whichever comes first in the DOM,
 * which is regularly the hidden one, and the click then fails as
 * ElementNotInteractable several steps from the cause.
 */
export async function firstDisplayed(d: WebDriver, by: By): Promise<WebElement | null> {
  for (const el of await d.findElements(by)) {
    try {
      if (await el.isDisplayed()) return el;
    } catch {
      /* detached between the find and the check */
    }
  }
  return null;
}

/** Wait for the first displayed match of `by`. */
export async function waitDisplayed(
  d: WebDriver,
  by: By,
  timeout = config.waitTimeout,
  message?: string,
): Promise<WebElement> {
  let found: WebElement | null = null;
  await d.wait(
    async () => {
      found = await firstDisplayed(d, by);
      return found !== null;
    },
    timeout,
    message,
  );
  return found!;
}

/**
 * The chat header's members button, which toggles the roster panel.
 *
 * Matched by aria-label: the header's icon buttons carry no test ids, and test
 * mode pins the UI to English, which is what makes the label deterministic -
 * the same bargain `selectTab` and the burger locator already make.
 */
const MEMBERS_BUTTON = By.css('button[aria-label^="Members"], button[aria-label^="members"]');

/**
 * Show the member roster.
 *
 * Standard keeps the roster behind a sidebar tab that, once mounted, stays in
 * the DOM; Nebula mounts and unmounts a panel, so this has to gate on the panel
 * being there rather than on a tab reporting itself selected.
 */
export async function openMemberPanel(d: WebDriver, timeout = config.waitTimeout): Promise<void> {
  const deadline = Date.now() + timeout;
  // The header the roster is opened from only exists on the chat screen, and a
  // client that has just reconnected is still on the session-status one. Wait
  // for the conversation rather than spending the whole budget clicking at a
  // header that is not there yet.
  try {
    await d.wait(until.elementLocated(byTid(TID.chatComposerInput)), timeout);
  } catch {
    /* fall through: the loop's own message names the roster, which is what the
       caller asked for */
  }
  for (;;) {
    if ((await d.findElements(byTid(TID.memberList))).length > 0) {
      // The panel is 264px of new layout on the right, and the reflow detaches
      // whatever the caller located a moment ago. Settling here is what turns a
      // StaleElementReferenceError three steps away back into a wait.
      await delay(250);
      return;
    }
    // The header's own button carries a head count, so it is only drawn where
    // there is one to draw - a DM, or a channel whose roster has not arrived,
    // has none. The kebab beside it lists Members either way, which is why it
    // is worth two clicks rather than failing.
    const button = (await firstDisplayed(d, MEMBERS_BUTTON)) ?? (await openKebabMembers(d));
    if (button) {
      try {
        await button.click();
      } catch {
        /* re-render mid-click; the next pass re-finds it */
      }
    }
    if (Date.now() > deadline) {
      // Never leave a menu behind on the way out: an open MUI menu lays a
      // backdrop over the whole page, so the caller's *next* click fails as
      // ElementClickIntercepted and the roster is never mentioned again.
      await dismissMenus(d);
      throw new Error("the member roster never opened (no way in from the chat header)");
    }
    await delay(200);
  }
}

/**
 * The chat kebab's "Members" entry, with the kebab opened to reach it.
 *
 * Closes the menu again when the entry is not there. Leaving it open was worse
 * than failing: the backdrop swallowed every later click in the file, so a
 * missing roster surfaced as an intercepted composer or mute button somewhere
 * else entirely.
 */
async function openKebabMembers(d: WebDriver): Promise<WebElement | null> {
  const kebab = await firstDisplayed(d, byTid(TID.chatHeaderKebab));
  if (!kebab) return null;
  try {
    await kebab.click();
  } catch {
    return null;
  }
  await delay(250);
  const item = await firstDisplayed(
    d,
    By.xpath("//*[@role='menuitem'][normalize-space(.)='Members']"),
  );
  if (!item) await dismissMenus(d);
  return item;
}

/**
 * Close any open menu/popover and wait for its backdrop to go.
 *
 * Nebula leans on MUI menus, and every one of them lays a full-page backdrop.
 * One left open turns the rest of a test file into ElementClickIntercepted
 * errors that name the button they hit rather than the menu over it.
 */
export async function dismissMenus(d: WebDriver, timeout = 4000): Promise<void> {
  const backdrop = By.css(".MuiBackdrop-root, [role='presentation'] > .MuiPaper-root");
  if ((await d.findElements(backdrop)).length === 0) return;
  try {
    await d.actions().sendKeys(Key.ESCAPE).perform();
  } catch {
    /* nothing focused; the wait below decides */
  }
  try {
    await d.wait(async () => (await d.findElements(backdrop)).length === 0, timeout);
  } catch {
    /* still there - the caller's own failure is more informative than this */
  }
  await delay(150);
}

/**
 * Wait until Nebula's client shell is mounted.
 *
 * Its root is the one marker that is up before any screen decides what to
 * draw, so it separates "the pack is loading" from "the pack is showing me
 * something I did not expect".
 */
export async function waitShell(d: WebDriver, timeout = 30000): Promise<void> {
  await d.wait(
    until.elementLocated(By.css('[data-testid="nebula-client-root"]')),
    timeout,
    "Nebula's client shell never mounted",
  );
}

/**
 * Return to the conversation from another screen (servers, friends, settings).
 *
 * Nebula's server rail is always up, and picking the connected server on it is
 * what puts the chat screen back - the same gesture Standard's server tab is.
 */
export async function goToChat(d: WebDriver, timeout = config.waitTimeout): Promise<void> {
  if ((await d.findElements(byTid(TID.chatComposerInput))).length > 0) return;
  const card = await waitDisplayed(
    d,
    By.css('[data-testid="nebula-server-rail-card"], [data-testid="nebula-server-rail-panel"] li'),
    timeout,
    "Nebula's server rail showed no server to return to",
  );
  await card.click();
  await d.wait(
    until.elementLocated(byTid(TID.chatComposerInput)),
    timeout,
    "the conversation never came back",
  );
}

/**
 * Click, retrying while something is still on top of the target.
 *
 * Nebula stacks MUI surfaces: a menu item that opens a dialog leaves the
 * menu's backdrop fading out while the dialog's is fading in, and a click that
 * lands in that window hits the wrong layer. There is nothing to wait *for* -
 * both layers are legitimately present - so this waits the transition out
 * instead of trying to name it.
 */
export async function clickWhenFree(el: WebElement, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await el.click();
      return;
    } catch (err) {
      const transient =
        err instanceof error.ElementClickInterceptedError ||
        err instanceof error.ElementNotInteractableError;
      if (!transient || Date.now() > deadline) throw err;
      await delay(200);
    }
  }
}

/**
 * Wait until no MUI menu is on screen.
 *
 * Unlike {@link dismissMenus} this asks for nothing - it waits for a menu that
 * is *already closing* to finish. A menu item that opens a popover is the
 * common case: the popover mounts while the menu is still fading, and a click
 * aimed at the popover lands on the menu item above it.
 */
export async function waitMenusClosed(d: WebDriver, timeout = 5000): Promise<void> {
  try {
    await d.wait(
      async () => (await d.findElements(By.css(".MuiMenu-root"))).length === 0,
      timeout,
    );
  } catch {
    /* still open - the caller's own click reports what is over it */
  }
  await delay(150);
}
