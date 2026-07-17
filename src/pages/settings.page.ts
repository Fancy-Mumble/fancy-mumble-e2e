import { By, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID } from "../selectors";

/**
 * Page object for the Settings page (`/settings`), focused on the "Account"
 * tab: self-service management of the own server-side registration (password
 * auth, rename, email, TOTP 2FA, unregister).
 */
export class SettingsPage {
  constructor(private readonly d: WebDriver) {}

  /** Open Settings via the gear button in the channel sidebar. */
  async open(): Promise<void> {
    // Return to the server view first if another page swapped the sidebar.
    const tabs = await this.d.findElements(By.css('[role="tab"][aria-selected="true"]'));
    if (tabs.length > 0) {
      await tabs[0].click();
      await this.d.sleep(400);
    }
    const btn = await this.d.wait(
      until.elementLocated(By.css('button[title="Audio settings"]')),
      10000,
    );
    await btn.click();
    // The settings nav renders its tab list; wait for the Profile tab.
    await this.d.wait(
      until.elementLocated(By.xpath("//nav//button[contains(normalize-space(.), 'Profile')]")),
      10000,
    );
  }

  /** Whether the "Account" tab is currently offered in the settings nav. */
  async hasAccountTab(): Promise<boolean> {
    return (
      (await this.d.findElements(
        By.xpath("//nav//button[normalize-space(.)='Account']"),
      )).length > 0
    );
  }

  /** Switch to the "Account" tab and wait for the panel's overview block. */
  async openAccountTab(): Promise<void> {
    const tab = await this.d.wait(
      until.elementLocated(By.xpath("//nav//button[normalize-space(.)='Account']")),
      10000,
      "the settings nav never offered an 'Account' tab",
    );
    await tab.click();
    await this.d.wait(
      until.elementLocated(byTid(TID.accountOverview)),
      15000,
      "the Account panel's overview never rendered (no account snapshot from the server?)",
    );
  }

  /** The overview block's full text (auth mode, 2FA state, identity). */
  async overviewText(): Promise<string> {
    const el = await this.d.wait(until.elementLocated(byTid(TID.accountOverview)), 10000);
    return el.getText();
  }

  /** Wait until the overview block's text contains `needle`. */
  async waitForOverviewContains(needle: string, timeout = 15000): Promise<void> {
    await this.d.wait(
      async () => (await this.overviewText()).includes(needle),
      timeout,
      `account overview never showed "${needle}"`,
    );
  }

  /** Enable password auth / change the password via the Account panel. */
  async setPassword(password: string): Promise<void> {
    await this.type(TID.accountPasswordInput, password);
    await this.type(TID.accountPasswordConfirmInput, password);
    await this.clickEnabled(TID.accountPasswordSave);
  }

  /** Begin TOTP enrolment and return the base32 secret the server issued. */
  async beginTotpEnrollment(): Promise<string> {
    await this.clickEnabled(TID.accountTotpBegin);
    const secretEl = await this.d.wait(
      until.elementLocated(byTid(TID.accountTotpSecret)),
      15000,
      "the TOTP secret never appeared after starting 2FA enrolment",
    );
    const secret = await secretEl.getAttribute("value");
    if (!secret) throw new Error("empty TOTP secret in the enrolment view");
    return secret;
  }

  /** Confirm TOTP enrolment with a code from the "authenticator app". */
  async verifyTotp(code: string): Promise<void> {
    await this.type(TID.accountTotpCodeInput, code);
    await this.clickEnabled(TID.accountTotpVerify);
  }

  /** Unregister the own account through the type-name-to-confirm flow. */
  async unregister(accountName: string): Promise<void> {
    await this.clickEnabled(TID.accountUnregisterBegin);
    await this.type(TID.accountUnregisterConfirmInput, accountName);
    await this.clickEnabled(TID.accountUnregisterConfirm);
  }

  /** Leave the settings page via the sidebar back button. */
  async back(): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(By.css('nav button[aria-label]')),
      10000,
    );
    await btn.click();
  }

  private async type(tid: string, value: string): Promise<void> {
    const el = await this.field(tid);
    await el.clear();
    await el.sendKeys(value);
  }

  private async field(tid: string, timeout = 10000): Promise<WebElement> {
    const el = await this.d.wait(until.elementLocated(byTid(tid)), timeout);
    await this.d.wait(until.elementIsVisible(el), timeout);
    return el;
  }

  private async clickEnabled(tid: string, timeout = 10000): Promise<void> {
    const el = await this.d.wait(until.elementLocated(byTid(tid)), timeout);
    await this.d.wait(until.elementIsEnabled(el), timeout);
    await el.click();
  }
}
