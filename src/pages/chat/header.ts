import { until, type WebDriver } from "selenium-webdriver";
import { byTid, TID } from "../../selectors";
import { config } from "../../config";
import { clickPossiblyHidden } from "../../util/layout";

/**
 * The chat header - `ChatHeader.tsx` in both packs.
 *
 * It names the open conversation, badges its encryption, and (in Standard)
 * carries the kebab that opens the poll composer and the pinned panel. Those
 * two surfaces own their own page objects and reach the kebab through
 * {@link openKebab}.
 */
export class ChatHeader {
  constructor(private readonly d: WebDriver) {}

  /** The header's title text (channel/peer display name). */
  async title(): Promise<string> {
    const el = await this.d.wait(until.elementLocated(byTid(TID.chatHeaderTitle)), 10000);
    return (await el.getText()).trim();
  }

  /** Whether the end-to-end-encrypted badge is shown (i.e. the open chat is an
   *  E2E signal channel - e.g. a friend chat that upgraded). */
  async hasE2EBadge(): Promise<boolean> {
    return (await this.d.findElements(byTid(TID.chatE2EBadge))).length > 0;
  }

  /** Wait until the E2E badge appears (the chat became E2E). */
  async waitForE2EBadge(timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      until.elementLocated(byTid(TID.chatE2EBadge)),
      timeout,
      "chat never showed the end-to-end-encrypted badge",
    );
  }

  /**
   * Open the header's overflow menu - the channel kebab.
   *
   * Through `clickPossiblyHidden` because a previous popover's scrim can still
   * be fading over it, and a positional click then reports the scrim rather
   * than the button.
   */
  async openKebab(timeout = 10000): Promise<void> {
    const menu = await this.d.wait(until.elementLocated(byTid(TID.chatHeaderKebab)), timeout);
    await clickPossiblyHidden(this.d, menu);
  }
}
