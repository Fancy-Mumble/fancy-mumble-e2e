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
    const newBtn = await this.d.wait(until.elementLocated(byTid(TID.calendarNewMeeting)), 10000);
    await newBtn.click();
    await this.d.wait(until.elementLocated(byTid(TID.calendarDialog)), 10000);

    const titleInput = await this.d.wait(until.elementLocated(byTid(TID.calendarTitleInput)), 10000);
    await titleInput.clear();
    await titleInput.sendKeys(title);

    // The picker clears its query after each commit, so the same input element
    // serves every invitee in turn.
    const picker = await this.d.findElement(byTid(TID.calendarInviteeInput));
    for (const name of inviteeNames) {
      await this.addInvitee(picker, name);
    }

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
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
