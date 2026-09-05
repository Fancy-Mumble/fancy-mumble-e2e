import { By, error, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { config } from "../config";
import { delay } from "./wait";

/**
 * The client's narrow-layout breakpoint, shared by `ChatPage` (sidebar becomes
 * a drawer) and `ChannelSidebar.module.css` (desktop voice controls give way to
 * the mobile call button). Both use `max-width: 768px`.
 */
const NARROW_MAX_PX = 768;

/**
 * Long enough for the drawer to finish sliding in.
 *
 * `ChatPage.module.css` parks the closed drawer at `translate3d(-100%, 0, 0)`
 * and animates it back with `transition: transform 0.25s ease`. The burger
 * unmounts the instant the state flips, so its absence says the sidebar was
 * *asked* to open, not that it has arrived - and a control that is still
 * off-screen fails hit-testing with ElementNotInteractableError while reporting
 * itself as displayed. Paid only when this actually opened the drawer.
 */
const DRAWER_SLIDE_MS = 300;

/**
 * The client's burger toggle, which exists only while the sidebar is closed.
 *
 * Matched by aria-label because the button carries no test id and its only
 * other hook is a hashed CSS-module class. Test mode pins the UI to English
 * (`mumble-language=en`, see the README), which is what makes the label
 * deterministic - the same reason `selectTab` matches tab captions by text.
 * The open and close controls have distinct labels, so this cannot match the
 * drawer's backdrop ("Close channels").
 */
const BURGER = By.css('button[aria-label="Open channels"]');

/**
 * Make the channel sidebar interactable, whatever width the window happens to
 * have.
 *
 * `ChatPage` drops the sidebar into a slide-out drawer at `max-width: 768px`
 * and starts it closed, so on a narrow window every sidebar control is present
 * in the DOM but not interactable: the Channels/Members tabs, the channel tree,
 * and the self mute/deafen buttons, which live in `ChannelSidebar` too. Locates
 * still resolve - only clicks fail - so the symptoms name everything except the
 * cause: `selectTab` swallows the ElementNotInteractableError and retries until
 * it times out on "never became selected", `clickTid` throws it raw, and the
 * Actions API reports MoveTargetOutOfBounds.
 *
 * A tiling window manager makes that the normal case rather than an edge case.
 * It sized the window to 572-719px on the rig this was found on (2560x1440
 * screen, narrower the more windows it tiles, so three-client suites suffer
 * most), and it refuses to resize on request: `setRect` and `maximize` are both
 * accepted and then ignored. The harness cannot buy its way out with a bigger
 * window, so it opens the drawer instead.
 *
 * The burger renders only while the sidebar is closed, so its presence is the
 * state check and its absence is the wide-layout fast path: under a normal
 * window manager this costs one `findElements` and changes nothing.
 *
 * Call per interaction, not once per session: the drawer re-closes on every
 * channel click (`onChannelSelect={closeSidebar}`).
 */
export async function ensureSidebarOpen(
  d: WebDriver,
  timeout = config.waitTimeout,
): Promise<void> {
  const [burger] = await d.findElements(BURGER);
  if (!burger) return; // already inline (wide) or already open
  try {
    await burger.click();
  } catch {
    // Detached mid-render. Fall through to the wait: either another pass
    // already opened it, or the caller fails on its own assertion, which
    // describes the interaction it wanted rather than this helper.
    /* empty */
  }
  // Gate on the toggle going away rather than on the click returning: the
  // drawer slides in, and a tab clicked mid-transition is still not
  // interactable.
  await d.wait(
    async () => (await d.findElements(BURGER)).length === 0,
    timeout,
    "the channel sidebar never opened (its burger toggle stayed on screen)",
  );
  await delay(DRAWER_SLIDE_MS);
}

/**
 * The drawer's backdrop, which exists only while the drawer is open.
 *
 * Its label is the counterpart of the burger's, so the two locators cannot
 * match the same element.
 */
const BACKDROP = By.css('button[aria-label="Close channels"]');

/**
 * Put the sidebar back out of the way before touching the main area.
 *
 * An open drawer lays a full-page backdrop over everything else
 * (`useDrawer && sidebarOpen` in ChatPage), so a click aimed at the composer,
 * the poll dialog or the share picker lands on the backdrop instead and
 * WebDriver reports ElementClickIntercepted. `ensureSidebarOpen` deliberately
 * leaves the drawer open for the caller that needed it, which makes this its
 * required counterpart rather than an optional tidy-up.
 *
 * Dismissing it is also what the client itself does on a channel click, so this
 * restores the app's own resting state rather than inventing one. No backdrop
 * means a wide window or an already-closed drawer, and the call costs one
 * `findElements`.
 */
export async function ensureSidebarClosed(
  d: WebDriver,
  timeout = config.waitTimeout,
): Promise<void> {
  const [backdrop] = await d.findElements(BACKDROP);
  if (!backdrop) return;
  // Dispatched rather than clicked at its centre. The backdrop spans the whole
  // page and the drawer sits over that centre point, so a positional click
  // lands on the sidebar instead: WebDriver reports ElementClickIntercepted and
  // the drawer stays open. A real user clicks the strip beside the drawer, and
  // this is that click without computing where the strip is.
  await d.executeScript("arguments[0].click();", backdrop);
  await d.wait(
    async () => (await d.findElements(BACKDROP)).length === 0,
    timeout,
    "the channel sidebar never closed (its backdrop stayed on screen)",
  );
  await delay(DRAWER_SLIDE_MS);
}

/**
 * Bring an element into view before an Actions-API gesture.
 *
 * `actions().doubleClick(el)` and `.contextClick(el)` move the pointer to the
 * element's centre and do **not** scroll to it first, so a row below the fold
 * of the sidebar's own scroller (`channelList`, `overflow: auto`) fails with
 * MoveTargetOutOfBounds, or with ElementNotInteractable once it is only partly
 * clipped. Plain `el.click()` never hit this because WebDriver scrolls for it,
 * which is why only the right-click and double-click paths were affected.
 *
 * A narrow window makes it routine - a 360px drawer leaves the channel list
 * about 236px tall, so the second or third channel a suite creates is already
 * past the fold - but a long enough list does it at any width, so this is
 * deliberately not gated on the layout.
 */
export async function locateForGesture(
  d: WebDriver,
  by: By,
  timeout = config.waitTimeout,
): Promise<WebElement> {
  const el = await d.wait(until.elementLocated(by), timeout);
  await d.executeScript(
    "arguments[0].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });",
    el,
  );
  // Short settle: 'instant' defeats any CSS scroll-behavior, but the pointer
  // move is a separate WebDriver round trip and reads the post-layout position.
  await delay(100);
  // Re-find instead of reusing the reference we scrolled with. The sidebar
  // re-renders continuously while three clients are connected, so that
  // reference is routinely detached by the time the gesture reaches it - the
  // scroll turned what used to fail as ElementNotInteractable into
  // StaleElementReference, four retries deep, because it widened the gap.
  return d.findElement(by);
}

/**
 * Click a control the narrow layout may have hidden rather than moved.
 *
 * Below the breakpoint `ChannelSidebar` swaps its desktop voice actions
 * (`selfVoiceActions desktopOnly`) for a single call button carrying no test
 * id. So mute and deafen are not relocated and cannot be found by any
 * selector - they stay mounted with their handlers attached and go
 * `display: none`, which WebDriver reports as ElementNotInteractableError on a
 * 0x0 box. Since the window manager refuses to widen the window, the choice is
 * between dispatching the click and losing every voice-state suite on a tiling
 * desktop; these suites assert that voice state propagates, not that a button
 * is visible at 466px.
 *
 * The real click stays the primary path and the fallback is gated on the
 * viewport genuinely being narrow, so on a normal window an unclickable control
 * still fails - which is the regression this suite exists to catch.
 */
/**
 * Double-click a row the narrow layout may have moved out of reach.
 *
 * The Actions API aims at an element's centre in *viewport* coordinates, so a
 * row inside a drawer that has slid shut sits at a negative x and the gesture
 * fails with MoveTargetOutOfBounds - which is easy to hit here because a
 * successful channel select closes the drawer itself (`onChannelSelect`), so a
 * retry races the animation that the previous attempt started.
 *
 * Same bargain as {@link clickPossiblyHidden}: the real gesture is the primary
 * path and the dispatch is gated on the viewport being narrow, so a row that is
 * genuinely unreachable on a normal window still fails. React listens for
 * bubbled native events at the root, so a dispatched `dblclick` reaches
 * `onDoubleClick` exactly as the driver's would.
 */
export async function doubleClickPossiblyHidden(d: WebDriver, el: WebElement): Promise<void> {
  try {
    await d.actions().doubleClick(el).perform();
    return;
  } catch (err) {
    const inTheWay =
      err instanceof error.ElementNotInteractableError ||
      err instanceof error.ElementClickInterceptedError ||
      err instanceof error.MoveTargetOutOfBoundsError;
    if (!inTheWay || !(await isNarrow(d))) throw err;
    await d.executeScript(
      "arguments[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));",
      el,
    );
  }
}

/**
 * Right-click a row the narrow layout may have moved out of reach.
 *
 * The counterpart of {@link doubleClickPossiblyHidden}, and the same bargain:
 * real gesture first, dispatch only when the viewport is genuinely narrow. The
 * event carries the row's own centre coordinates so the context menu still
 * opens beside it - dispatching a bare event would place the menu at 0,0, where
 * its items are laid out off-screen and unclickable for a different reason.
 */
export async function contextClickPossiblyHidden(d: WebDriver, el: WebElement): Promise<void> {
  try {
    await d.actions().contextClick(el).perform();
    return;
  } catch (err) {
    const inTheWay =
      err instanceof error.ElementNotInteractableError ||
      err instanceof error.ElementClickInterceptedError ||
      err instanceof error.MoveTargetOutOfBoundsError;
    if (!inTheWay || !(await isNarrow(d))) throw err;
    await d.executeScript(
      `const r = arguments[0].getBoundingClientRect();
       arguments[0].dispatchEvent(new MouseEvent('contextmenu', {
         bubbles: true, cancelable: true, view: window,
         clientX: Math.round(r.left + r.width / 2),
         clientY: Math.round(r.top + r.height / 2),
       }));`,
      el,
    );
  }
}

/** Whether the client is below its narrow-layout breakpoint right now. */
async function isNarrow(d: WebDriver): Promise<boolean> {
  return d.executeScript<boolean>(
    `return window.matchMedia("(max-width: ${NARROW_MAX_PX}px)").matches;`,
  );
}

export async function clickPossiblyHidden(d: WebDriver, el: WebElement): Promise<void> {
  try {
    await el.click();
    return;
  } catch (err) {
    // Two shapes of the same problem - the narrow layout is in the way. Either
    // the target has no box to click (hidden), or something the narrow layout
    // put on top would take the click (the drawer, its backdrop, or a context
    // menu they overlap).
    const inTheWay =
      err instanceof error.ElementNotInteractableError ||
      err instanceof error.ElementClickInterceptedError;
    if (!inTheWay || !(await isNarrow(d))) {
      // On a wide window an intercept is a real overlay, and rethrowing is
      // right - but WebDriver's own message names neither the target nor the
      // thing over it, which leaves the reader guessing at a menu they cannot
      // see. Say what is actually at the point.
      if (inTheWay) throw new Error(`${(err as Error).message}\n${await describeOverlay(d, el)}`);
      throw err;
    }
    await d.executeScript("arguments[0].click();", el);
  }
}

/** What sits at the centre of `el`, and what the target itself is. */
async function describeOverlay(d: WebDriver, el: WebElement): Promise<string> {
  try {
    return await d.executeScript<string>(
      `const el = arguments[0];
       const describe = (n) => {
         if (!n) return "nothing";
         const id = n.getAttribute && n.getAttribute("data-testid");
         return n.tagName.toLowerCase()
           + (id ? '[data-testid="' + id + '"]' : "")
           + (n.className && typeof n.className === "string"
               ? "." + n.className.trim().split(/\s+/).slice(0, 3).join(".")
               : "");
       };
       const r = el.getBoundingClientRect();
       const at = document.elementFromPoint(
         Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
       const chain = [];
       for (let n = at; n && chain.length < 4; n = n.parentElement) chain.push(describe(n));
       return "target " + describe(el) + " at " + Math.round(r.left) + "," + Math.round(r.top)
         + " is covered by: " + chain.join(" < ");`,
      el,
    );
  } catch {
    return "(could not read what is over it)";
  }
}
