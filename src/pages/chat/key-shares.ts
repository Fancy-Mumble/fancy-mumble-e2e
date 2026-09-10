import { By, type WebDriver } from "selenium-webdriver";
import { config } from "../../config";
import { delay } from "../../util/wait";
import { ensureSidebarClosed } from "../../util/layout";

/**
 * The encryption-key consent prompts: the in-chat banner a peer's request
 * raises (`buildKeyShareBanner`) and the `KeyShareWarningDialog` it opens.
 *
 * Sharing a key with a peer is gated behind explicit user consent, so a peer
 * can only decrypt once the key holder approves.
 */
export class KeySharePrompts {
  constructor(private readonly d: WebDriver) {}

  /**
   * Approve every pending key-share prompt, polling for the whole window
   * because they appear asynchronously as peers announce their keys. Returns
   * how many were approved.
   */
  async approveAll(maxWaitMs = config.waitTimeout): Promise<number> {
    // Two clicks per approval, because the client asks twice. A peer's
    // request first surfaces as a banner in the chat view ("<peer> joined and
    // needs the encryption key" - `buildKeyShareBanner`), whose "Share Key"
    // opens `KeyShareWarningDialog`; the dialog's own "Share Key" is what
    // actually shares. Both buttons carry the same caption, and only the
    // second sits under a `role="dialog"`, so matching the dialog alone waited
    // out the whole budget on a prompt that was on screen the entire time,
    // one click away.
    // The banner lives in the chat area, so an open drawer's backdrop sits on
    // top of it: the click is intercepted, and polling never sees the prompt it
    // is already looking straight at.
    await ensureSidebarClosed(this.d);
    const dialogConfirm = By.xpath("//*[@role='dialog']//button[normalize-space(.)='Share Key']");
    const bannerOffer = By.xpath(
      "//button[normalize-space(.)='Share Key'][not(ancestor::*[@role='dialog'])]",
    );
    let approved = 0;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const [confirm] = await this.d.findElements(dialogConfirm);
      if (confirm) {
        try {
          await confirm.click();
          approved++;
          await delay(700);
          continue;
        } catch {
          /* dialog re-rendered; re-poll */
        }
      }
      const [offer] = await this.d.findElements(bannerOffer);
      if (offer) {
        try {
          await offer.click();
          await delay(400); // the dialog mounts; the next pass confirms it
          continue;
        } catch {
          // Re-close and retry rather than swallowing: an intercepted banner
          // click looks identical to "no prompt yet" from here, and that cost
          // a whole debugging session once.
          await ensureSidebarClosed(this.d);
        }
      }
      await delay(800);
    }
    return approved;
  }
}
