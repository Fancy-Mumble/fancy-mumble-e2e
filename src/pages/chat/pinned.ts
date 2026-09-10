import { By, until, type WebDriver } from "selenium-webdriver";
import { isNebula } from "../../ui-flavour";
import { type ChatHeader } from "./header";

/**
 * The pinned-message panel (`pinned/` in both packs).
 *
 * Standard files it under the channel kebab; Nebula gives pins a button of
 * their own in the header, so there is no menu to open first - which is why
 * this holds {@link ChatHeader} rather than reaching for the kebab itself.
 */
export class PinnedPanel {
  constructor(
    private readonly d: WebDriver,
    private readonly header: ChatHeader,
  ) {}

  /** Open the pinned-message panel. */
  async open(): Promise<void> {
    if (isNebula) {
      const pins = await this.d.wait(
        until.elementLocated(By.css('button[aria-label^="Pinned"]')),
        10000,
      );
      await pins.click();
      return;
    }
    await this.header.openKebab();
    await this.d
      .wait(
        until.elementLocated(
          By.xpath("//*[@id='pinned-messages' or normalize-space(.)='Pinned messages']"),
        ),
        5000,
      )
      .then((el) => el.click());
  }
}
