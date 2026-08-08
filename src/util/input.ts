import type { WebDriver, WebElement } from "selenium-webdriver";

/**
 * Set a controlled input's value through the DOM instead of by typing it.
 *
 * WebDriver `sendKeys` routes through the compositor's keymap, so on a non-US
 * layout plain ASCII arrives as another character — a German keymap turns "-"
 * into "ß", and a channel created as "e2eßchßN" never matches the "e2e-ch-N"
 * the test looks for. Writing the value with React's own native setter and
 * firing the `input` event it listens for is layout-independent, and it commits
 * in one step so there is no partial-value race before a submit either.
 *
 * Only for controlled text fields whose handler reads the committed value.
 * Widgets that react to individual keystrokes — an autocomplete that opens on
 * keydown — still need real typing.
 */
export async function setReactInputValue(
  d: WebDriver,
  el: WebElement,
  value: string,
): Promise<void> {
  await d.executeScript(
    `const el = arguments[0], value = arguments[1];
     const proto = el.tagName === "TEXTAREA"
       ? HTMLTextAreaElement.prototype
       : HTMLInputElement.prototype;
     const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
     setter.call(el, "");
     setter.call(el, value);
     el.dispatchEvent(new Event("input", { bubbles: true }));
     el.dispatchEvent(new Event("change", { bubbles: true }));`,
    el,
    value,
  );
}

/**
 * Pick a <select> option through the DOM instead of clicking the <option>.
 *
 * The WebKitWebDriver that ships with Ubuntu 26.04 refuses to click <option>
 * elements directly (ElementNotInteractableError), which broke every dialog
 * with a dropdown. Setting the value with the native setter and firing
 * `change` — the event a real selection dispatches, and the one React binds
 * onChange to for selects — is driver-independent.
 */
export async function setReactSelectValue(
  d: WebDriver,
  el: WebElement,
  value: string,
): Promise<void> {
  await d.executeScript(
    `const el = arguments[0], value = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
     setter.call(el, value);
     el.dispatchEvent(new Event("change", { bubbles: true }));`,
    el,
    value,
  );
}
