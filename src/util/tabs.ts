import { By, type WebDriver } from "selenium-webdriver";
import { config } from "../config";

/**
 * Activate a sidebar tab and confirm it took.
 *
 * The naive form - locate the tab, click once, move on - is the suite's most
 * expensive flake. Three clients render concurrently, and a click that lands
 * while the sidebar re-renders either raises a WebDriver `TimeoutError` (the
 * command never completes) or silently does nothing (the element the driver
 * clicked is detached before React handles the event). Both surface far from
 * here: the caller waits out its own timeout on a member row that was never
 * going to appear, the `before` hook fails, and every test in the file is
 * cancelled. That is exactly how `server compatibility: control-path
 * boundaries` lost all three of its tests in one sweep and passed 3/3 in
 * isolation minutes later.
 *
 * So: retry the click, and gate on the state the click is supposed to produce
 * (`aria-selected`) rather than on the click returning. Already-selected is the
 * fast path and costs one attribute read.
 */
export async function selectTab(
  d: WebDriver,
  label: string,
  timeout = config.waitTimeout,
): Promise<void> {
  const selector = By.xpath(`//button[@role='tab' and normalize-space(.)=${JSON.stringify(label)}]`);
  await d.wait(
    async () => {
      const [tab] = await d.findElements(selector);
      if (!tab) return false;
      // Re-read through the element each pass: a re-render between the find and
      // the click detaches it, and a stale reference throws rather than lying.
      try {
        if ((await tab.getAttribute("aria-selected")) === "true") return true;
        await tab.click();
        return (await tab.getAttribute("aria-selected")) === "true";
      } catch {
        return false; // stale or mid-render - the next pass re-finds it
      }
    },
    timeout,
    `the ${label} tab never became selected`,
  );
}
