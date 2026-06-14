import { By, until, type WebDriver } from "selenium-webdriver";
import { TID, MEMBER_NAME_ATTR } from "../selectors";
import { delay } from "../util/wait";

/**
 * Page object for the channel sidebar (ChannelSidebar.tsx + the flat
 * ModernChannelList). Channel rows carry `channel-item` / data-channel-id /
 * data-channel-name; create/edit/delete happen via the right-click context
 * menu + ChannelEditorDialog (addressed by its stable element ids and the
 * English-forced button text).
 */
export class SidebarPage {
  constructor(private readonly d: WebDriver) {}

  private byChannelName(name: string): By {
    return By.css(
      `[data-testid="${TID.channelItem}"][data-channel-name="${cssAttrEscape(name)}"]`,
    );
  }

  private byChannelId(id: number): By {
    return By.css(`[data-testid="${TID.channelItem}"][data-channel-id="${id}"]`);
  }

  /** Wait for a channel with the given name to appear in the sidebar. */
  async waitForChannel(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(until.elementLocated(this.byChannelName(name)), timeout);
  }

  /**
   * Create a sub-channel under the channel with `parentId` (0 = root) via the
   * right-click context menu and the channel editor dialog. Resolves once the
   * dialog has closed. Pass `pchatProtocol` (e.g. "fancy_v1_full_archive" or
   * "signal_v1") to enable persistent chat on the new channel.
   */
  async createSubChannel(
    parentId: number,
    name: string,
    opts: { pchatProtocol?: string } = {},
  ): Promise<void> {
    const parent = await this.d.wait(until.elementLocated(this.byChannelId(parentId)), 15000);
    await this.d.actions().contextClick(parent).perform();
    // The context menu + editor dialog animate in; located-but-not-yet-
    // interactable elements otherwise swallow the click. Wait for visibility
    // and let each transition settle.
    await delay(400);

    const createItem = await this.d.wait(
      until.elementLocated(By.xpath("//button[contains(normalize-space(.), 'Create Sub-channel')]")),
      10000,
    );
    await this.d.wait(until.elementIsVisible(createItem), 5000);
    await createItem.click();
    await delay(400);

    const nameInput = await this.d.wait(until.elementLocated(By.css("#ch-ed-name")), 10000);
    await this.d.wait(until.elementIsVisible(nameInput), 5000);
    await nameInput.clear();
    await nameInput.sendKeys(name);

    if (opts.pchatProtocol) {
      const select = await this.d.findElement(By.css("#ch-ed-pchat"));
      await select.findElement(By.css(`option[value="${opts.pchatProtocol}"]`)).click();
    }

    const createBtn = await this.d.wait(
      until.elementLocated(By.xpath("//*[@role='dialog']//button[normalize-space(.)='Create']")),
      10000,
    );
    await this.d.wait(until.elementIsEnabled(createBtn), 5000);
    await createBtn.click();

    // The dialog closes on success (the name input disappears).
    await this.d.wait(
      async () => (await this.d.findElements(By.css("#ch-ed-name"))).length === 0,
      10000,
    );
  }

  /**
   * Double-click a channel to MOVE the local user into it (membership), not just
   * select it for viewing. The double-click can land as a select-only (the two
   * clicks race the re-render), so retry until the self row confirms membership.
   */
  async joinChannel(name: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const el = await this.d.wait(until.elementLocated(this.byChannelName(name)), 15000);
      await this.d.actions().doubleClick(el).perform();
      try {
        await this.waitForMembership(name, 4000);
        return;
      } catch {
        /* select-only landed; retry the double-click */
      }
    }
    throw new Error(`failed to move into channel "${name}" (membership not confirmed)`);
  }

  /**
   * Right-click a user row and register them on the server (admin only). The
   * relay-based features (calendar, file-server) route by a stable registered
   * `user_id`, so an anonymous peer must be registered before it can be invited.
   * Synchronisation on the new `user_id` propagating is left to the caller (the
   * calendar invitee autocomplete only resolves once it lands).
   */
  async registerUser(name: string): Promise<void> {
    const row = await this.d.wait(
      until.elementLocated(
        By.css(`[data-testid="${TID.memberItem}"][${MEMBER_NAME_ATTR}="${cssAttrEscape(name)}"]`),
      ),
      15000,
    );
    await this.d.actions().contextClick(row).perform();
    await delay(400);
    const register = await this.d.wait(
      until.elementLocated(By.xpath("//button[normalize-space(.)='Register']")),
      8000,
    );
    await this.d.wait(until.elementIsVisible(register), 5000);
    await register.click();
    await delay(400);
  }

  /**
   * Wait until the local user is a MEMBER of `name`. The sidebar self row
   * (the only member-item with data-clickable=true) carries a channel chip
   * showing the channel the user is currently in.
   */
  async waitForMembership(name: string, timeout = 12000): Promise<void> {
    await this.d.wait(async () => {
      const rows = await this.d.findElements(
        By.css(`[data-testid="${TID.memberItem}"][data-clickable="true"]`),
      );
      if (rows.length === 0) return false;
      const text = await rows[0].getText().catch(() => "");
      return text.includes(name);
    }, timeout);
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
