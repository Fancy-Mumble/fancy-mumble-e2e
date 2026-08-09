import type { WebDriver, WebElement } from "selenium-webdriver";

/**
 * Whether `text` contains a code point above U+FFFF.
 *
 * WebDriver's `sendKeys` is defined over the Basic Multilingual Plane, and
 * msedgedriver rejects anything else outright with "only supports characters in
 * the BMP". Emoji are the common case: a single 👩🏽‍💻 is four code points, three
 * of which are astral.
 */
export function hasAstralChars(text: string): boolean {
  // Iterating a string yields code points, not UTF-16 units, so a surrogate
  // pair is one iteration and comparing against 0xffff is meaningful.
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) > 0xffff) return true;
  }
  return false;
}

/**
 * Whether the keyboard cannot deliver `text` faithfully to a composer.
 *
 * Two reasons, and they fail differently. Astral code points are *refused* by
 * msedgedriver. A newline is worse: `sendKeys` presses Enter, the composer
 * submits, and the remainder is sent as a second message - so the test does
 * not error, it silently asserts against the wrong thing.
 */
export function needsScriptedInput(text: string): boolean {
  return hasAstralChars(text) || text.includes("\n");
}

/**
 * Set a React-controlled input's value and raise the event React listens for.
 *
 * React installs its own value setter on the input prototype and tracks the
 * last value it wrote, so assigning `element.value` directly is swallowed:
 * React compares against its tracked value, sees no change, and never runs the
 * onChange handler. Calling the *prototype's* setter updates the DOM without
 * touching React's tracker, and the subsequent `input` event then looks like a
 * real edit.
 *
 * **Use this for every value a test will later assert on. Do not reach for
 * `sendKeys`.** On this rig keystrokes go through the compositor's keymap,
 * which types "-" as "ß" - and only when the window happens to hold focus, so
 * it strikes intermittently. Every suite mints hyphenated names and tokens
 * (`e2e-bob-<sfx>`), so a `sendKeys` input site fails by sending a value that
 * matches nothing, and it reads as a bug in whatever feature the suite
 * measures: it cost this suite the entire "pchat messages never render" red,
 * the "invitee never became a suggestion" red, and the composer flakiness,
 * before the pattern was found. `sendKeys` stays acceptable only where the
 * *content* is never asserted on (e.g. typing to trigger a typing indicator).
 */
export async function setReactInputValue(
  driver: WebDriver,
  element: WebElement,
  value: string,
): Promise<void> {
  await driver.executeScript(
    `const [el, value] = arguments;
     const proto = el instanceof HTMLTextAreaElement
       ? HTMLTextAreaElement.prototype
       : HTMLInputElement.prototype;
     Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
     el.dispatchEvent(new Event("input", { bubbles: true }));`,
    element,
    value,
  );
}
