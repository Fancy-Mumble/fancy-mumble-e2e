import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID, KEBAB_ITEM_ATTR } from "../selectors";
import { xpathLiteral } from "../util/xpath";
import { config } from "../config";

/**
 * Page object for the scheduled-messages split view
 * (ScheduledMessagesPanel.tsx): compose a channel message for future
 * delivery, list the caller's pending messages, cancel one. The server
 * stores and delivers (FancyScheduledMessage* wire messages), so a pending
 * row appearing proves the schedule round-tripped through the server.
 */
export class ScheduledPage {
  constructor(private readonly d: WebDriver) {}

  /** Open the scheduled-messages split view via the chat header's kebab menu. */
  async open(): Promise<void> {
    const kebab = await this.d.wait(until.elementLocated(byTid(TID.chatHeaderKebab)), config.waitTimeout);
    await kebab.click();
    const item = await this.d.wait(
      until.elementLocated(
        By.css(`[data-testid="${TID.kebabMenuItem}"][${KEBAB_ITEM_ATTR}="scheduled-messages"]`),
      ),
      10000,
    );
    await item.click();
    await this.d.wait(until.elementLocated(byTid(TID.scheduledPanel)), config.waitTimeout);
  }

  /**
   * Set the delivery time to `minutesAhead` (fractions allowed) from now,
   * computed on the webview's own clock. Uses the native value setter +
   * input/change events so React's controlled `datetime-local` input picks it
   * up (sendKeys into date/time inputs is locale-fragile). The input has
   * minute resolution, so the value is truncated to the whole minute.
   */
  async setDeliveryInMinutes(minutesAhead: number): Promise<void> {
    await this.d.executeScript(
      `
      const min = arguments[0];
      const d = new Date(Date.now() + min * 60000);
      const pad = (n) => String(n).padStart(2, '0');
      const val = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      const el = document.querySelector('[data-testid="${TID.scheduledTimeInput}"]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      `,
      minutesAhead,
    );
  }

  /** Replace the composer's message body with `text`. */
  async setBody(text: string): Promise<void> {
    const input = await this.d.wait(until.elementLocated(byTid(TID.scheduledBodyInput)), 10000);
    await input.click();
    await input.clear();
    await input.sendKeys(text);
  }

  /** Click "Schedule". Does not wait for any outcome. */
  async submit(): Promise<void> {
    const btn = await this.d.findElement(byTid(TID.scheduledSubmit));
    await this.d.wait(until.elementIsEnabled(btn), 5000);
    await btn.click();
  }

  /**
   * Schedule `text` for delivery `minutesAhead` from now and wait for the
   * pending row to appear - i.e. for the server's ack + list refresh (the
   * full schedule round-trip).
   */
  async schedule(text: string, minutesAhead: number): Promise<void> {
    await this.setBody(text);
    await this.setDeliveryInMinutes(minutesAhead);
    await this.submit();
    await this.waitForPendingItem(text);
  }

  /** Locator for a pending row whose message body contains `text`. */
  private pendingItem(text: string): By {
    return By.xpath(
      `//*[@data-testid="${TID.scheduledItem}"][contains(normalize-space(string(.)), ${xpathLiteral(text)})]`,
    );
  }

  /** Wait for a pending scheduled-message row containing `text`. */
  async waitForPendingItem(text: string, timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      until.elementLocated(this.pendingItem(text)),
      timeout,
      `scheduled message "${text}" never appeared in the pending list`,
    );
  }

  /** Wait until no pending row containing `text` remains (cancelled/delivered). */
  async waitForPendingGone(text: string, timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      async () => (await this.d.findElements(this.pendingItem(text))).length === 0,
      timeout,
      `scheduled message "${text}" never left the pending list`,
    );
  }

  /** Number of pending rows currently listed. */
  async pendingCount(): Promise<number> {
    return (await this.d.findElements(byTid(TID.scheduledItem))).length;
  }

  /** Cancel the pending row containing `text` and wait for it to disappear. */
  async cancel(text: string): Promise<void> {
    const row = await this.d.wait(until.elementLocated(this.pendingItem(text)), 10000);
    await row.findElement(byTid(TID.scheduledItemCancel)).then((b) => b.click());
    await this.waitForPendingGone(text);
  }

  /** Re-request the pending list from the server. */
  async refresh(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.scheduledRefresh)), 10000);
    await btn.click();
  }

  /** The composer's error line text, or null when no error is shown. */
  async errorText(): Promise<string | null> {
    const els = await this.d.findElements(byTid(TID.scheduledError));
    if (els.length === 0) return null;
    return (await els[0].getText()).trim();
  }

  /** Wait for the composer error line to show (validation/server rejection). */
  async waitForError(timeout = 10000): Promise<string> {
    const el = await this.d.wait(until.elementLocated(byTid(TID.scheduledError)), timeout);
    return (await el.getText()).trim();
  }
}
