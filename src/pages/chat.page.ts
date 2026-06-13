import { By, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { xpathLiteral } from "../util/xpath";
import { delay } from "../util/wait";

/** Self-mute / self-deafen flags as reflected in the UI. */
export interface VoiceFlags {
  readonly muted: boolean;
  readonly deaf: boolean;
}

async function readVoiceFlags(el: WebElement): Promise<VoiceFlags> {
  return {
    muted: (await el.getAttribute("data-muted")) === "true",
    deaf: (await el.getAttribute("data-deaf")) === "true",
  };
}

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

  /**
   * Right-click a message (located by its text) and pick a quick-reaction
   * emoji from the context menu. The message must carry a message_id (pchat)
   * for the context menu to be wired; otherwise the wrapper has no
   * data-msg-id / onContextMenu.
   */
  async reactToMessage(messageText: string, emoji: string): Promise<void> {
    const wrapper = await this.d.wait(
      until.elementLocated(
        By.xpath(`//*[@data-msg-id][contains(normalize-space(.), ${xpathLiteral(messageText)})]`),
      ),
      15000,
    );
    // Hovering reveals the per-message action bar and right-click opens the
    // context menu; both expose the same quick-reaction emoji buttons (and the
    // action bar's copy is always in the DOM but hidden). Click whichever
    // matching emoji button is actually visible.
    await this.d.actions().move({ origin: wrapper }).perform();
    await this.d.actions().contextClick(wrapper).perform();
    await delay(500);
    const candidates = await this.d.findElements(
      By.xpath(`//button[normalize-space(.)=${xpathLiteral(emoji)}]`),
    );
    for (const btn of candidates) {
      if (await btn.isDisplayed()) {
        await btn.click();
        return;
      }
    }
    throw new Error(`No visible '${emoji}' quick-reaction button after opening message actions`);
  }

  /** Wait for a reaction pill to appear (its aria-label starts with the emoji). */
  async waitForReaction(emoji: string, timeout = 15000): Promise<void> {
    await this.d.wait(
      until.elementLocated(By.xpath(`//button[starts-with(@aria-label, ${xpathLiteral(emoji)})]`)),
      timeout,
    );
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

  /** Single click of the mute control (cycles inactive -> active -> muted). */
  async tapMute(): Promise<void> {
    await this.clickTid(TID.toggleMute);
  }

  /** Single click of the deafen control. */
  async tapDeafen(): Promise<void> {
    await this.clickTid(TID.toggleDeafen);
  }

  /**
   * Read the local user's own voice flags from the sidebar self row. That row
   * is the only `member-item` carrying `data-clickable="true"` (isSelf), so it
   * uniquely identifies "me" regardless of name collisions.
   */
  async selfVoiceFlags(): Promise<VoiceFlags> {
    const el = await this.d.wait(
      until.elementLocated(By.css(`[data-testid="${TID.memberItem}"][data-clickable="true"]`)),
      10000,
    );
    return readVoiceFlags(el);
  }

  /** Read a peer's voice flags as shown to this client in the Members tab. */
  async peerVoiceFlags(name: string): Promise<VoiceFlags> {
    await this.ensureMembersTab();
    const el = await this.d.wait(until.elementLocated(this.memberRow(name)), 15000);
    return readVoiceFlags(el);
  }

  /** Wait until the peer's row reflects the expected voice flags (or throw). */
  async waitForPeerVoice(name: string, expected: VoiceFlags, timeout = 15000): Promise<void> {
    await this.ensureMembersTab();
    const row = this.memberRow(name);
    await this.d.wait(async () => {
      const els = await this.d.findElements(row);
      if (els.length === 0) return false;
      const f = await readVoiceFlags(els[0]);
      return f.muted === expected.muted && f.deaf === expected.deaf;
    }, timeout);
  }

  /** Click the sidebar Disconnect button (returns to the connect page). */
  async disconnect(): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(By.xpath("//button[contains(normalize-space(.), 'Disconnect')]")),
      10000,
    );
    await btn.click();
  }

  /** Wait until the local self row reports the expected muted state. */
  async waitSelfMuted(muted: boolean, timeout = 10000): Promise<void> {
    await this.d.wait(async () => (await this.selfVoiceFlags()).muted === muted, timeout);
  }

  /** Tap mute until the self row reports muted (max a few cycles). */
  async ensureMuted(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      if ((await this.selfVoiceFlags()).muted) return;
      await this.tapMute();
      await delay(500);
    }
  }

  /** Tap deafen/mute until the self row reports unmuted and undeafened. */
  async ensureUnmuted(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const f = await this.selfVoiceFlags();
      if (!f.muted && !f.deaf) return;
      if (f.deaf) await this.tapDeafen();
      else await this.tapMute();
      await delay(500);
    }
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
