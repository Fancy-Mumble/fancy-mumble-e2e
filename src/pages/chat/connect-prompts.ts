import { By, until, type WebDriver } from "selenium-webdriver";
import { delay } from "../../util/wait";

/**
 * The two modals a connect raises: the server's welcome message, and the
 * plugin trust prompt (`PluginTrustPrompt`).
 *
 * They matter far out of proportion to their size. The trust prompt renders
 * with `closeOnEsc=false` and an overlay that swallows clicks, so an
 * unanswered one surfaces as an unrelated ElementClickInterceptedError several
 * steps later - which is how 35 of 41 files once broke at the same time.
 */
export class ConnectPrompts {
  constructor(private readonly d: WebDriver) {}

  /**
   * Answer both connect-time modals with one watcher over the pair.
   *
   * These used to be two serial probes with their own generous timeouts (4 s
   * for welcome, 8 s for plugins), which priced every waitLoaded at ~12 s of
   * pure waiting against a server that raises neither - and the shared e2e
   * Starling configures no welcome text and ships no plugins, so that was
   * every connect of every sweep. Both modals are driven by messages that
   * arrive with the post-connect sync: by the time the composer has mounted
   * they are on screen or a render-beat away, so a short watch over both
   * selectors catches them, and each answered modal extends the watch in case
   * dismissing one reveals the next. A modal missed anyway fails exactly as
   * before: the next click is intercepted and its own retry names the overlay.
   */
  async answerAll(budgetMs = 2500): Promise<void> {
    const buttons = [
      By.xpath("//*[@role='dialog']//button[normalize-space(.)='Close']"),
      ConnectPrompts.allowPluginsButton,
    ];
    let deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      for (const sel of buttons) {
        const [btn] = await this.d.findElements(sel);
        if (!btn) continue;
        try {
          await btn.click();
          deadline = Date.now() + 2000; // dismissing one can reveal the next
        } catch {
          /* mid-animation or stale - the next pass re-finds it */
        }
      }
      await delay(150);
    }
  }

  /**
   * Resolve the plugin trust prompt (the modal a server with bundled plugins
   * raises a beat after connect; `closeOnEsc=false`, so it MUST be answered)
   * by allowing all offered plugins for this server. No-op when the prompt
   * never shows within `timeout`. Call before driving UI that a lingering
   * modal overlay would otherwise click-intercept.
   */
  async allowPlugins(timeout = 8000): Promise<void> {
    const allowSel = ConnectPrompts.allowPluginsButton;
    try {
      const btn = await this.d.wait(until.elementLocated(allowSel), timeout);
      await btn.click();
      await this.d.wait(async () => (await this.d.findElements(allowSel)).length === 0, 5000);
    } catch {
      /* no trust prompt (no plugins, or already trusted) */
    }
  }

  /** Either wording the trust prompt's accept button ships with. */
  private static readonly allowPluginsButton = By.xpath(
    "//*[@role='dialog']//button[normalize-space(.)='Allow all for this server'" +
      " or normalize-space(.)='Allow for this server']",
  );
}
