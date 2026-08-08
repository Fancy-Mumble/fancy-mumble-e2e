import { By, Key, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { delay } from "../util/wait";

export interface ConnectOptions {
  /** Only honoured in the wizard's expert mode (where the port field shows). */
  port?: number;
  /** Use "Connect & Save" (persist the server) instead of "Quick connect". */
  save?: boolean;
  /**
   * Server/user password. When set, the connect attempt is expected to raise
   * the password dialog (e.g. connecting as SuperUser); it is filled and
   * submitted automatically.
   */
  password?: string;
}

/** Page object for the connect wizard (ConnectPage.tsx). */
export class ConnectPage {
  constructor(private readonly d: WebDriver) {}

  async waitReady(timeout = 30000): Promise<void> {
    // The connect page lands on either the wizard (fresh: host input) or the
    // saved-servers list (when the real Tauri store already has servers).
    await this.d.wait(
      until.elementLocated(
        By.css(`[data-testid="${TID.connectHostInput}"], [data-testid="${TID.serverCard}"]`),
      ),
      timeout,
    );
  }

  /**
   * Drive the wizard end-to-end: host -> (port, expert mode only) -> username
   * -> connect. When the saved-servers view is showing (the store can't be
   * isolated on Windows), click "Add Server" to reach the wizard first.
   */
  async connect(host: string, username: string, opts: ConnectOptions = {}): Promise<void> {
    await this.ensureWizard();
    const hostInput = await this.field(TID.connectHostInput);
    await this.setValue(hostInput, host);

    if (opts.port !== undefined) {
      // The port field only exists in expert mode; ignore it otherwise
      // (normal mode always uses the default 64738).
      const ports = await this.d.findElements(byTid(TID.connectPortInput));
      if (ports.length > 0) await this.setValue(ports[0], String(opts.port));
    }

    await this.clickEnabled(TID.wizardContinue);

    await this.ensureUsernameInput();
    const userInput = await this.field(TID.connectUsernameInput, 15000);
    await this.setValue(userInput, username);

    // Expert/developer mode adds a label step after username; advance until the
    // final action buttons appear.
    await this.advanceToFinalStep();
    await this.clickEnabled(opts.save ? TID.connectAndSave : TID.quickConnect);

    if (opts.password !== undefined) await this.submitPassword(opts.password);
  }

  /**
   * Fill and submit the password dialog (e.g. SuperUser). Resolves once the
   * dialog closes, which only happens when the server accepts the password.
   */
  private async submitPassword(password: string): Promise<void> {
    // The dialog remounts after the client's "Connection to server was lost."
    // transition, so a #pw-dialog-input handle taken just before that re-render
    // is stale by the time clear()/sendKeys() run — the most common flake in
    // the multi-client suites. Re-locate and retry the fill as one unit, within
    // the same 15s, so a remount costs a retry rather than the test.
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const input = await this.d.wait(
          until.elementLocated(By.css("#pw-dialog-input")),
          Math.max(1, deadline - Date.now()),
        );
        await input.clear();
        await input.sendKeys(password, Key.ENTER);
        break;
      } catch (error) {
        const stale = (error as { name?: string }).name === "StaleElementReferenceError";
        if (!stale || Date.now() >= deadline) throw error;
        await delay(200);
      }
    }
    await this.d.wait(
      async () => (await this.d.findElements(By.css("#pw-dialog-input"))).length === 0,
      15000,
    );
  }

  /** Click "Continue" until the wizard's final action buttons are shown. */
  private async advanceToFinalStep(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if ((await this.d.findElements(byTid(TID.quickConnect))).length > 0) return;
      const conts = await this.d.findElements(byTid(TID.wizardContinue));
      if (conts.length === 0) return;
      await conts[0].click();
      await delay(400);
    }
  }

  /**
   * Reveal the username text field on the wizard's username step. In normal
   * mode with a stored default name, the step shows a confirmation instead -
   * click "Use a different name" so a per-test username can be typed.
   */
  private async ensureUsernameInput(): Promise<void> {
    // Step 1 is the last step in normal mode, so the final action buttons are
    // present once it has rendered.
    await this.d.wait(
      until.elementLocated(
        By.css(`[data-testid="${TID.connectUsernameInput}"], [data-testid="${TID.quickConnect}"]`),
      ),
      15000,
    );
    const inputs = await this.d.findElements(byTid(TID.connectUsernameInput));
    if (inputs.length > 0) return;
    const link = await this.d.wait(
      until.elementLocated(By.xpath("//button[contains(normalize-space(.), 'Use a different name')]")),
      10000,
    );
    await link.click();
  }

  /** Open the wizard if the saved-servers list is showing instead. */
  private async ensureWizard(): Promise<void> {
    const hostInputs = await this.d.findElements(byTid(TID.connectHostInput));
    if (hostInputs.length > 0) return;
    // Saved-servers view: click the "Add Server" header button. Located by its
    // (English-forced) text since it has no dedicated test id yet.
    const addBtn = await this.d.wait(
      until.elementLocated(By.xpath("//button[contains(normalize-space(.), 'Add Server')]")),
      10000,
    );
    await addBtn.click();
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
