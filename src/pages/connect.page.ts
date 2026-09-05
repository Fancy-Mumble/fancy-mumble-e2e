import { By, Key, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { delay } from "../util/wait";
import { setReactInputValue } from "../util/input";
import { config } from "../config";
import { isNebula } from "../ui-flavour";
import { clickWhenFree, waitDisplayed } from "../util/nebula";

export interface ConnectOptions {
  /** Only honoured in the wizard's expert mode (where the port field shows). */
  port?: number;
  /**
   * Use "Connect & Save" (persist the server) instead of "Quick connect".
   *
   * Standard only. Nebula has no such choice - saving the server and choosing
   * the name you arrive under are one dialog there, so every connect persists.
   */
  save?: boolean;
  /**
   * Server/user password. When set, the connect attempt is expected to raise
   * the password dialog (e.g. connecting as SuperUser); it is filled and
   * submitted automatically.
   */
  password?: string;
}

/**
 * Serializes password-dialog typing across concurrently connecting clients.
 *
 * The wizard is driven through the DOM (`setReactInputValue`), so two clients
 * can run it at the same time — which is what lets a suite's `before` hook
 * connect its clients in parallel. The password dialog is the one step that
 * still types real key events (`sendKeys`), and key events go to whichever
 * window holds focus, which two clients on one display trade away from each
 * other. One at a time through this gate; the step costs ~1 s, so the serial
 * section is small.
 */
let passwordTurn: Promise<void> = Promise.resolve();

/** Page object for the connect wizard (ConnectPage.tsx). */
export class ConnectPage {
  constructor(private readonly d: WebDriver) {}

  async waitReady(timeout = 30000): Promise<void> {
    // The connect page lands on either the wizard (fresh: host input) or the
    // saved-servers list (when the real Tauri store already has servers).
    // Nebula has no wizard: a fresh profile shows the server column with
    // nothing in it, so its add-server action is the only thing guaranteed to
    // be up.
    const ready = isNebula
      ? `[data-testid="${TID.addServer}"], [data-testid="${TID.serverCard}"]`
      : `[data-testid="${TID.connectHostInput}"], [data-testid="${TID.serverCard}"]`;
    await this.d.wait(until.elementLocated(By.css(ready)), timeout);
  }

  /**
   * Drive the wizard end-to-end: host -> (port, expert mode only) -> username
   * -> connect. When the saved-servers view is showing (the store can't be
   * isolated on Windows), click "Add Server" to reach the wizard first.
   */
  async connect(host: string, username: string, opts: ConnectOptions = {}): Promise<void> {
    if (isNebula) return this.connectNebula(host, username, opts);
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
    const userInput = await this.field(TID.connectUsernameInput, config.waitTimeout);
    await this.setValue(userInput, username);

    // Expert/developer mode adds a label step after username; advance until the
    // final action buttons appear.
    await this.advanceToFinalStep();
    await this.clickEnabled(opts.save ? TID.connectAndSave : TID.quickConnect);

    if (opts.password !== undefined) await this.submitPassword(opts.password);
  }

  /**
   * Nebula's connect flow: add the server, then join as the identity it saved.
   *
   * There is no wizard here. A server and the name you arrive under are one
   * record - the add-server dialog takes host, port and username together and
   * writes a saved identity - and the connect screen is then a list of those
   * identities with one button under it. So `save` has no meaning in this pack:
   * every connect persists, which is why the option is documented as
   * standard-only rather than quietly ignored.
   */
  private async connectNebula(
    host: string,
    username: string,
    opts: ConnectOptions,
  ): Promise<void> {
    await this.openAddServerDialog();

    const hostInput = await this.field(TID.connectHostInput);
    await this.setValue(hostInput, host);
    if (opts.port !== undefined) {
      const ports = await this.d.findElements(byTid(TID.connectPortInput));
      if (ports.length > 0) await this.setValue(ports[0], String(opts.port));
    }
    const userInput = await this.field(TID.connectUsernameInput, config.waitTimeout);
    await this.setValue(userInput, username);
    await this.chooseCertificate();
    await this.clickEnabled(TID.connectAndSave);

    // Saving selects the new server and swings the main area to its connect
    // screen. Gate on the dialog going away first: its Save button and the
    // screen's Connect button are both on screen for a beat, and a click that
    // lands on the closing dialog does nothing.
    await this.d.wait(
      async () => (await this.d.findElements(byTid(TID.connectHostInput))).length === 0,
      config.waitTimeout,
      "the add-server dialog never closed after saving",
    );
    await this.clickEnabled(TID.quickConnect, config.waitTimeout);

    if (opts.password !== undefined) await this.submitPassword(opts.password);
  }

  /**
   * Make sure the add-server dialog is saving an identity, not an anonymous
   * login.
   *
   * The client picks `default` itself now - the same certificate Standard's
   * wizard opens on, and the one `TauriApp.launch` generates - so this is a
   * safety net for a client build that predates that, not a step the flow
   * depends on. A cert-less connect is worth catching: the server refuses to
   * register it, and pchat and signal key distribution key off the same hash,
   * so the suites fail a long way from the cause.
   *
   * Deliberately cannot throw. It runs before every connect in the pack, and a
   * fussy widget interaction here would take out whole files for a control the
   * test is not about; a connect that really did go out anonymous fails on its
   * own assertion, which names the thing the test cares about.
   */
  private async chooseCertificate(label = "default"): Promise<void> {
    try {
      const [field] = await this.d.findElements(byTid(TID.connectCertificate));
      if (!field) return; // a build that predates the tagged picker
      if ((await field.getText()).includes(label)) return; // already chosen
      // The control itself, not the field wrapper the id sits on: a click on
      // the wrapper can land on the label or the helper line, which opens
      // nothing. A MUI select, not a native one - the options exist only while
      // the listbox is open, so this clicks through rather than setting state.
      const [picker] = await this.d.findElements(
        By.css(`[data-testid="${TID.connectCertificate}"] [role="combobox"]`),
      );
      if (!picker) return;
      await clickWhenFree(picker);
      const [option] = await this.d.findElements(By.css(`[data-cert-label="${label}"]`));
      if (option) await clickWhenFree(option);
      else await this.d.actions().sendKeys(Key.ESCAPE).perform();
      // The listbox is a popover over the dialog, and a Save clicked while it
      // fades lands on it instead. Best effort: `clickEnabled` retries through
      // an overlay anyway.
      await this.d
        .wait(async () => (await this.d.findElements(By.css('[role="listbox"]'))).length === 0, 4000)
        .catch(() => undefined);
    } catch {
      /* see the doc comment: never fail a connect over the certificate widget */
    }
    await delay(200);
  }

  /**
   * Open the add-server dialog from whichever server column is showing.
   *
   * Nebula draws that column twice - the rail's pinned panel and, with the
   * rail switched off, the sidebar shell - and the rail's narrow strip carries
   * an add button of its own. Only one is on screen, so this takes the first
   * *displayed* one rather than the first in the DOM.
   */
  private async openAddServerDialog(): Promise<void> {
    if ((await this.d.findElements(byTid(TID.connectHostInput))).length > 0) return;
    const add = await waitDisplayed(
      this.d,
      byTid(TID.addServer),
      config.waitTimeout,
      "Nebula's connect screen showed no add-server action",
    );
    // Through `clickWhenFree`: a reconnect arrives here while the leave-server
    // dialog's backdrop is still fading out, and a click that lands on it is
    // reported against this button rather than against the dialog.
    await clickWhenFree(add);
    await this.field(TID.connectHostInput, config.waitTimeout);
  }

  /**
   * Fill and submit the password dialog (e.g. SuperUser). Resolves once the
   * dialog closes, which only happens when the server accepts the password.
   */
  private async submitPassword(password: string): Promise<void> {
    const turn = passwordTurn.then(() => this.typePassword(password));
    passwordTurn = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private async typePassword(password: string): Promise<void> {
    // Two races made this the flakiest step in the multi-client suites, so the
    // fill is verified rather than fired and forgotten:
    //
    // - The dialog remounts after the client's "Connection to server was lost."
    //   transition, so a handle on the secret field taken a moment earlier is
    //   stale by the time we type into it. Re-locate and retry on a stale one.
    // - The field is a controlled React input and the form's submit reads its
    //   state, so sendKeys(password, ENTER) can submit before the last onChange
    //   has committed — the request goes out with a partial password and the
    //   server refuses it. Confirm the field holds the whole password before
    //   pressing Enter, and if the dialog comes back (a refusal), type it again.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const input = await this.d.wait(
          until.elementLocated(byTid(TID.connectPasswordInput)),
          Math.max(1, deadline - Date.now()),
        );
        await input.clear();
        await input.sendKeys(password);
        await this.d.wait(async () => (await input.getAttribute("value")) === password, 3000);
        await input.sendKeys(Key.ENTER);
      } catch (error) {
        if ((error as { name?: string }).name === "StaleElementReferenceError") continue;
        throw error;
      }
      // The dialog closes only on acceptance; a reappearance is a refusal, so
      // loop and retype until it sticks or the deadline passes.
      if (await this.dialogClosed(4000)) return;
    }
    throw new Error("password dialog did not close after submitting the password");
  }

  /** Whether the password dialog has gone within `timeout`. */
  private async dialogClosed(timeout: number): Promise<boolean> {
    try {
      await this.d.wait(
        async () => (await this.d.findElements(byTid(TID.connectPasswordInput))).length === 0,
        timeout,
      );
      return true;
    } catch {
      return false;
    }
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
      config.waitTimeout,
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
    // Through the DOM, not keystrokes: a non-US compositor keymap types "-" as
    // "ß", which mangles hyphenated usernames like "e2e-reg-bob-1234". See
    // setReactInputValue.
    await setReactInputValue(this.d, el, value);
  }

  private async clickEnabled(id: string, timeout = 10000): Promise<void> {
    const el = await this.d.wait(until.elementLocated(byTid(id)), timeout);
    await this.d.wait(until.elementIsEnabled(el), timeout);
    await clickWhenFree(el);
  }
}
