import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { xpathLiteral } from "../util/xpath";
import { delay } from "../util/wait";

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
    await this.dismissWelcomeModal();
  }

  /**
   * Dismiss the server "welcome message" modal if it appears. It pops up a beat
   * after connecting (z-index 1100) and intercepts clicks on the composer.
   */
  private async dismissWelcomeModal(): Promise<void> {
    const closeSel = By.xpath("//*[@role='dialog']//button[normalize-space(.)='Close']");
    try {
      const btn = await this.d.wait(until.elementLocated(closeSel), 4000);
      await btn.click();
      await this.d.wait(async () => (await this.d.findElements(closeSel)).length === 0, 4000);
    } catch {
      /* no welcome modal */
    }
  }

  /** Type into the composer's textarea and click send. */
  async sendMessage(text: string): Promise<void> {
    const wrap = await this.d.wait(until.elementLocated(byTid(TID.chatComposerInput)), 15000);
    const editable = await wrap.findElement(By.css("textarea"));
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
    await this.ensureMembersTab();
    await this.d.wait(until.elementLocated(this.memberRow(name)), timeout);
  }

  /**
   * Switch the sidebar to the Members tab once. Member rows there are
   * `UserListItem`s carrying member-item / data-muted / data-deaf; the default
   * Channels tab renders users with a different component (no test ids). Once
   * mounted the pane stays in the DOM (hidden when inactive), so elementLocated
   * still finds rows after switching away.
   */
  private async ensureMembersTab(): Promise<void> {
    if ((await this.d.findElements(byTid(TID.memberList))).length > 0) return;
    const tab = await this.d.wait(
      until.elementLocated(By.xpath("//button[@role='tab' and normalize-space(.)='Members']")),
      10000,
    );
    await tab.click();
    await this.d.wait(until.elementLocated(byTid(TID.memberList)), 15000);
  }

  /**
   * Put the local user into the self-muted state. The mute control cycles
   * inactive -> active -> muted, and a fresh connection starts inactive, so the
   * first click only activates voice; a second click mutes.
   */
  async selfMute(): Promise<void> {
    await this.clickTid(TID.toggleMute);
    await delay(400);
    await this.clickTid(TID.toggleMute);
  }

  /** Toggle the local user's self-deafen via the sidebar voice control. */
  async selfDeafen(): Promise<void> {
    await this.clickTid(TID.toggleDeafen);
  }

  /** Wait until the named member's row shows the muted state. */
  async waitForMemberMuted(name: string, timeout = 20000): Promise<void> {
    await this.ensureMembersTab();
    await this.d.wait(until.elementLocated(this.memberRow(name, '[data-muted="true"]')), timeout);
  }

  /** Wait until the named member's row shows the deafened state. */
  async waitForMemberDeaf(name: string, timeout = 20000): Promise<void> {
    await this.ensureMembersTab();
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
