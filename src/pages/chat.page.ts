import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { xpathLiteral } from "../util/xpath";

/** Page object for the main chat view (ChatPage.tsx / ChatComposer.tsx). */
export class ChatPage {
  constructor(private readonly d: WebDriver) {}

  /**
   * Resolves once the chat composer is mounted, which only happens after the
   * connection is up and the post-connect bootstrap (channels/users/own
   * session) has completed.
   */
  async waitLoaded(timeout = 45000): Promise<void> {
    await this.d.wait(until.elementLocated(byTid(TID.chatComposerInput)), timeout);
  }

  /** Type into the (contenteditable) composer and click send. */
  async sendMessage(text: string): Promise<void> {
    const wrap = await this.d.wait(until.elementLocated(byTid(TID.chatComposerInput)), 15000);
    const editable = await wrap.findElement(By.css('[contenteditable="true"]'));
    await editable.click();
    await editable.sendKeys(text);

    const send = await this.d.findElement(byTid(TID.chatSend));
    await this.d.wait(until.elementIsEnabled(send), 5000);
    await send.click();
  }

  /** Wait until some element on the page renders `text` (message delivered). */
  async waitForText(text: string, timeout = 15000): Promise<void> {
    const xp = By.xpath(`//*[contains(normalize-space(string(.)), ${xpathLiteral(text)})]`);
    await this.d.wait(until.elementLocated(xp), timeout);
  }

  /** Wait for a member row with the given display name to appear in the list. */
  async waitForMember(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(until.elementLocated(this.memberRow(name)), timeout);
  }

  /** Toggle the local user's self-mute via the sidebar voice control. */
  async selfMute(): Promise<void> {
    await this.clickTid(TID.toggleMute);
  }

  /** Toggle the local user's self-deafen via the sidebar voice control. */
  async selfDeafen(): Promise<void> {
    await this.clickTid(TID.toggleDeafen);
  }

  /** Wait until the named member's row shows the muted state. */
  async waitForMemberMuted(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(until.elementLocated(this.memberRow(name, '[data-muted="true"]')), timeout);
  }

  /** Wait until the named member's row shows the deafened state. */
  async waitForMemberDeaf(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(until.elementLocated(this.memberRow(name, '[data-deaf="true"]')), timeout);
  }

  /** CSS locator for a member row, optionally narrowed by a state attribute. */
  private memberRow(name: string, extra = ""): By {
    return By.css(
      `[data-testid="${TID.memberItem}"][data-user-name="${cssAttrEscape(name)}"]${extra}`,
    );
  }

  private async clickTid(id: string, timeout = 15000): Promise<void> {
    const el = await this.d.wait(until.elementLocated(byTid(id)), timeout);
    await this.d.wait(until.elementIsEnabled(el), timeout);
    await el.click();
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
