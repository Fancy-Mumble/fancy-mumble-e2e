import { By, Key, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID, CALENDAR_EVENT_TITLE_ATTR } from "../selectors";
import { xpathLiteral } from "../util/xpath";

/**
 * Page object for the calendar split-view (the `fancy-calendar` plugin UI):
 * CalendarPanel + EventDialog + the month/week event chips. The calendar header
 * action is only rendered when the server has the plugin loaded, so its
 * presence doubles as the end-to-end "plugin available" signal.
 */
export class CalendarPage {
  constructor(private readonly d: WebDriver) {}

  /**
   * Whether the calendar header button is present. True only when the client
   * received the `fancy-calendar` plugin-info from the server (plugin enabled +
   * client gating) - the core thing the gating test asserts.
   */
  async headerButtonPresent(timeout = 15000): Promise<boolean> {
    try {
      await this.d.wait(until.elementLocated(byTid(TID.calendarHeaderButton)), timeout);
      return true;
    } catch {
      return false;
    }
  }

  /** Open the calendar split-view via the header button. */
  async open(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.calendarHeaderButton)), 15000);
    await this.d.wait(until.elementIsVisible(btn), 5000);
    await btn.click();
    await this.d.wait(until.elementLocated(byTid(TID.calendarPanel)), 15000);
  }

  /** Switch the active view (day | workweek | week | month). */
  async switchView(view: "day" | "workweek" | "week" | "month"): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(
        By.css(`[data-testid="${TID.calendarViewButton}"][data-view="${view}"]`),
      ),
      10000,
    );
    await btn.click();
  }

  /**
   * Create a meeting through the dialog, inviting one or more participants.
   * Each invitee is added via the member picker's name autocomplete; a
   * suggestion only resolves once that user is a registered candidate
   * (`user_id > 0`), so adding them also synchronises on registration having
   * propagated to this client.
   */
  async createMeeting(title: string, invitees: string | readonly string[] = []): Promise<void> {
    const inviteeNames = typeof invitees === "string" ? [invitees] : invitees;
    await this.openMeetingDialog();
    await this.setMeetingTitle(title);
    await this.addInvitees(inviteeNames);
    await this.saveMeeting();
  }

  /** Open the "new meeting" dialog and wait for it to render. */
  async openMeetingDialog(): Promise<void> {
    const newBtn = await this.d.wait(until.elementLocated(byTid(TID.calendarNewMeeting)), 10000);
    await newBtn.click();
    await this.d.wait(until.elementLocated(byTid(TID.calendarDialog)), 10000);
  }

  /** Set the open dialog's meeting title. */
  async setMeetingTitle(title: string): Promise<void> {
    const titleInput = await this.d.wait(until.elementLocated(byTid(TID.calendarTitleInput)), 10000);
    await titleInput.clear();
    await titleInput.sendKeys(title);
  }

  /**
   * Add one or more invitees to the open dialog via the member picker. A name
   * suggestion only resolves once that user is a registered candidate
   * (`user_id > 0`), so this also synchronises on registration having
   * propagated to this client. Once committed, an invitee is held as a chip by
   * `user_id` independent of whether that user is still online - so a meeting
   * can be addressed to someone who subsequently goes offline before it is
   * saved (the relay then delivers it on their next connect).
   */
  async addInvitees(invitees: string | readonly string[]): Promise<void> {
    const inviteeNames = typeof invitees === "string" ? [invitees] : invitees;
    if (inviteeNames.length === 0) return;
    // The picker clears its query after each commit, so the same input element
    // serves every invitee in turn.
    const picker = await this.d.findElement(byTid(TID.calendarInviteeInput));
    for (const name of inviteeNames) {
      await this.addInvitee(picker, name);
    }
  }

  /**
   * Set the open dialog's start date+time to `minutesAhead` from now, computed
   * from the webview's own clock so it matches the app's local timezone. Sets
   * the values via the native input setter + input/change events so React's
   * controlled inputs pick them up (sendKeys into date/time inputs is locale-
   * fragile).
   */
  async setStartInMinutes(minutesAhead: number): Promise<void> {
    await this.d.executeScript(
      `
      const min = arguments[0];
      const d = new Date(Date.now() + min * 60000);
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes());
      const setVal = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal('[data-testid="${TID.calendarStartDate}"]', dateStr);
      setVal('[data-testid="${TID.calendarStartTime}"]', timeStr);
      `,
      minutesAhead,
    );
  }

  /** Set the open dialog's reminder offset (minutes before start; null = none). */
  async setReminder(minutes: number | null): Promise<void> {
    await this.d.executeScript(
      `
      const val = arguments[0];
      const el = document.querySelector('[data-testid="${TID.calendarReminderSelect}"]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      `,
      minutes === null ? "none" : String(minutes),
    );
  }

  /** Save the open dialog and wait for it to close. */
  async saveMeeting(): Promise<void> {
    const save = await this.d.wait(until.elementLocated(byTid(TID.calendarSave)), 10000);
    await save.click();
    await this.d.wait(
      async () => (await this.d.findElements(byTid(TID.calendarDialog))).length === 0,
      10000,
    );
  }

  /** Type a name into the member picker and commit its autocomplete suggestion. */
  private async addInvitee(picker: WebElement, inviteeName: string): Promise<void> {
    await picker.clear();
    await picker.sendKeys(inviteeName);

    // The suggestion for `inviteeName` appears only once that user is a
    // registered candidate (`user_id > 0`); React re-renders the list as the
    // user list updates, so type + wait also covers registration propagation.
    // Scoped to the invitee's name so the (empty) description editor's markup
    // can never match.
    const suggestion = By.xpath(
      `//*[@data-testid="${TID.calendarDialog}"]//ul//li//button` +
        `[contains(normalize-space(.), ${xpathLiteral(inviteeName)})]`,
    );
    const sugg = await this.d.wait(
      until.elementLocated(suggestion),
      20000,
      `invitee "${inviteeName}" never became a registered suggestion`,
    );
    await sugg.click();
    // Belt-and-braces: if the click raced the list, Enter commits the input too.
    if ((await this.d.findElements(suggestion)).length > 0) await picker.sendKeys(Key.ENTER);
    // Ensure this invitee committed (the suggestion list cleared) before the
    // next name is typed, so names can't bleed across pickers.
    await this.d
      .wait(async () => (await this.d.findElements(suggestion)).length === 0, 5000)
      .catch(() => undefined);
  }

  /** CSS locator for a rendered meeting chip with the given title. */
  private eventLocator(title: string): By {
    return By.css(
      `[data-testid="${TID.calendarEvent}"][${CALENDAR_EVENT_TITLE_ATTR}="${cssAttrEscape(title)}"]`,
    );
  }

  /** Wait until a meeting chip with the given title is rendered in any view. */
  async waitForEvent(title: string, timeout = 20000): Promise<void> {
    await this.d.wait(until.elementLocated(this.eventLocator(title)), timeout);
  }

  /** Whether a meeting chip with the given title is currently rendered (no wait). */
  async hasEvent(title: string): Promise<boolean> {
    return (await this.d.findElements(this.eventLocator(title))).length > 0;
  }

  /** Open an existing meeting's detail popover by clicking its chip. */
  async openEvent(title: string): Promise<void> {
    const chip = await this.d.wait(until.elementLocated(this.eventLocator(title)), 20000);
    // Center the chip in the scroll viewport first: an event at the very top of
    // the day grid otherwise sits behind the sticky day-column header, which
    // would intercept the click (its exact position depends on the meeting's
    // time of day, so this keeps the click robust regardless of when we run).
    await this.d.executeScript(
      "arguments[0].scrollIntoView({ block: 'center', inline: 'center' });",
      chip,
    );
    try {
      await chip.click();
    } catch {
      // Fallback: if something still overlaps, dispatch the click directly.
      await this.d.executeScript("arguments[0].click();", chip);
    }
    await this.d.wait(until.elementLocated(byTid(TID.calendarDetailCard)), 10000);
  }

  /**
   * Click "Join meeting" on the open event detail card. The server provisions
   * (or locates) the meeting's hidden E2E room and admits the caller; the client
   * then moves into it. Resolves once the detail card has closed.
   */
  async joinMeeting(): Promise<void> {
    const join = await this.d.wait(until.elementLocated(byTid(TID.calendarJoinMeeting)), 10000);
    await join.click();
    await this.d.wait(
      async () => (await this.d.findElements(byTid(TID.calendarDetailCard))).length === 0,
      10000,
    );
  }

  /**
   * Click the organiser-only "Copy invite link", capturing the link the server
   * returns over the plugin channel (surfaced as the `fancy:meeting-invite-link`
   * DOM event, observed here rather than reading the OS clipboard).
   */
  async copyInviteLink(timeout = 10000): Promise<string> {
    // Install the listener before clicking so we never miss the event.
    await this.d.executeScript(`
      window.__fancyMeetingInviteLink = null;
      window.addEventListener('fancy:meeting-invite-link', (e) => {
        window.__fancyMeetingInviteLink = e.detail && e.detail.url;
      }, { once: true });
    `);
    const copy = await this.d.wait(until.elementLocated(byTid(TID.calendarCopyInviteLink)), 10000);
    await copy.click();
    return this.d.wait<string>(async () => {
      const url = (await this.d.executeScript("return window.__fancyMeetingInviteLink;")) as
        | string
        | null;
      return url ?? "";
    }, timeout, "invite link never arrived");
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
