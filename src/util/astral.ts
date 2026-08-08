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
 * Only for text the driver cannot type. Everything else should go through
 * `sendKeys`, which exercises the keyboard path a user actually takes.
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
