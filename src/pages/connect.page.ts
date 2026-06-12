import { until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID } from "../selectors";

export interface ConnectOptions {
  /** Only honoured in the wizard's expert mode (where the port field shows). */
  port?: number;
  /** Use "Connect & Save" (persist the server) instead of "Quick connect". */
  save?: boolean;
}

/** Page object for the connect wizard (ConnectPage.tsx). */
export class ConnectPage {
  constructor(private readonly d: WebDriver) {}

  async waitReady(timeout = 30000): Promise<void> {
    await this.d.wait(until.elementLocated(byTid(TID.connectHostInput)), timeout);
  }

  /**
   * Drive the wizard end-to-end: host -> (port, expert mode only) -> username
   * -> connect. Assumes a fresh profile (no saved servers), which lands on the
   * wizard's first step.
   */
  async connect(host: string, username: string, opts: ConnectOptions = {}): Promise<void> {
    const hostInput = await this.field(TID.connectHostInput);
    await this.setValue(hostInput, host);

    if (opts.port !== undefined) {
      // The port field only exists in expert mode; ignore it otherwise
      // (normal mode always uses the default 64738).
      const ports = await this.d.findElements(byTid(TID.connectPortInput));
      if (ports.length > 0) await this.setValue(ports[0], String(opts.port));
    }

    await this.clickEnabled(TID.wizardContinue);

    const userInput = await this.field(TID.connectUsernameInput, 15000);
    await this.setValue(userInput, username);

    await this.clickEnabled(opts.save ? TID.connectAndSave : TID.quickConnect);
  }

  private async field(id: string, timeout = 10000): Promise<WebElement> {
    const el = await this.d.wait(until.elementLocated(byTid(id)), timeout);
    await this.d.wait(until.elementIsVisible(el), timeout);
    return el;
  }

  private async setValue(el: WebElement, value: string): Promise<void> {
    await el.clear();
    await el.sendKeys(value);
  }

  private async clickEnabled(id: string, timeout = 10000): Promise<void> {
    const el = await this.d.wait(until.elementLocated(byTid(id)), timeout);
    await this.d.wait(until.elementIsEnabled(el), timeout);
    await el.click();
  }
}
