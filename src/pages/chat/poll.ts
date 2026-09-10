import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID } from "../../selectors";
import { config } from "../../config";
import { xpathLiteral } from "../../util/xpath";
import { setReactInputValue } from "../../util/astral";
import { isNebula } from "../../ui-flavour";
import { dismissMenus, waitMenusClosed } from "../../util/nebula";
import { ensureSidebarClosed, clickPossiblyHidden } from "../../util/layout";
import { type ChatComposer } from "./composer";
import { type ChatHeader } from "./header";

/**
 * The poll composer and the `PollCard` it posts (Nebula's `PollCard.tsx`,
 * Standard's `poll/`).
 *
 * Where the composer is opened from is the one pack-specific step, and it is
 * why this object holds the two surfaces that offer it: Standard files "Create
 * poll" in the chat header's kebab, Nebula in the composer's attach menu - the
 * same feature filed under "what this channel can do" in one and "what I can
 * put in this message" in the other. Everything after that is addressed by
 * test id and is the same in both.
 */
export class PollSurface {
  constructor(
    private readonly d: WebDriver,
    private readonly composer: ChatComposer,
    private readonly header: ChatHeader,
  ) {}

  /** Create a poll through the shipped UI. */
  async create(question: string, options: string[], multiple = false): Promise<void> {
    await ensureSidebarClosed(this.d);
    // Whatever a previous step left open would take this click instead.
    if (isNebula) await dismissMenus(this.d);
    if (isNebula) await this.composer.openAttachMenu();
    else await this.header.openKebab();
    // Standard's kebab item carries no test id of its own, only the caption it
    // is rendered with; Nebula's does. Either finds exactly one item.
    const entry = isNebula
      ? byTid(TID.chatCreatePoll)
      : By.xpath(`//*[@role='menuitem'][normalize-space(.)=${xpathLiteral("Create poll")}]`);
    await this.d
      .wait(until.elementLocated(entry), 5000)
      .then((el) => clickPossiblyHidden(this.d, el));
    // Nebula opens the poll composer as a popover *from* that menu, so the two
    // are on screen together for a transition and the composer's controls sit
    // under the menu that spawned them.
    if (isNebula) await waitMenusClosed(this.d);

    // DOM-injected like the composer: poll tests assert on hyphenated
    // question/option tokens, and keystrokes mangle "-" under the compositor
    // keymap (see ChatComposer.send).
    const questionInput = await this.d.wait(
      until.elementLocated(byTid(TID.pollQuestionInput)),
      5000,
    );
    await setReactInputValue(this.d, questionInput, question);
    for (let i = 0; i < options.length; i++) {
      // Re-read each time: Nebula grows a fresh empty row as the previous one
      // is filled, so a list taken up front is one short by the second option.
      const rows = await this.d.findElements(byTid(TID.pollOptionInput));
      await setReactInputValue(this.d, rows[i], options[i]);
    }
    if (multiple) {
      await clickPossiblyHidden(this.d, await this.d.findElement(byTid(TID.pollMultiple)));
    }
    await clickPossiblyHidden(this.d, await this.d.findElement(byTid(TID.pollSubmit)));
    // Nebula posts from a popover behind a scrim; the scrim outlives the click
    // by a transition, and the next step's click lands on it.
    if (isNebula) await dismissMenus(this.d);
  }

  /** Vote in the first rendered poll containing `question`. */
  async vote(question: string, option: string): Promise<void> {
    await ensureSidebarClosed(this.d);
    // `PollCard` renders each option as a <button> holding a <span> of the
    // option text - there is no <label> and no <input>, so both halves of the
    // old locator were wrong: the ancestor axis looked for a card containing an
    // <input>, and the option for a <label>. Anchor on the question and take
    // the nearest ancestor that actually holds the option buttons.
    const card = await this.d.wait(
      until.elementLocated(
        By.xpath(
          `//*[contains(normalize-space(.), ${xpathLiteral(question)})]` +
            `[.//button][not(.//*[contains(normalize-space(.), ${xpathLiteral(question)})][.//button])]`,
        ),
      ),
      config.waitTimeout,
    );
    const choice = await card.findElement(
      By.xpath(`.//button[contains(normalize-space(.), ${xpathLiteral(option)})]`),
    );
    await choice.click();
    const vote = await card.findElements(By.xpath(".//button[contains(normalize-space(.), 'Vote')]"));
    if (vote.length > 0) await vote[0].click();
  }
}
