import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID, MEMBER_NAME_ATTR } from "../selectors";
import { delay } from "../util/wait";
import { xpathLiteral } from "../util/xpath";
import { setReactInputValue, setReactSelectValue } from "../util/input";
import { config } from "../config";
import { selectTab } from "../util/tabs";

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

  /**
   * Ensure the sidebar's "Channels" tab is active before interacting with a
   * channel row. Channels and Members share one sidebar (SidebarTabs.tsx); when
   * the Members tab is selected (e.g. after chat.waitForMember / registerUser)
   * the channels pane is display:none, so channel rows are in the DOM but have
   * zero size and are not interactable (right-click / double-click throw
   * ElementNotInteractable). Switching back is idempotent via aria-selected.
   */
  private async ensureChannelsTab(): Promise<void> {
    await selectTab(this.d, "Channels");
  }

  /** Wait for a channel with the given name to appear in the sidebar. */
  async waitForChannel(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(until.elementLocated(this.byChannelName(name)), timeout);
  }

  /**
   * Create a sub-channel under the channel with `parentId` (0 = root) via the
   * right-click context menu and the channel editor dialog. Resolves once the
   * dialog has closed.
   *
   * Options:
   *  - `pchatProtocol` (e.g. "fancy_v1_full_archive") enables persistent chat.
   *  - `hidden` marks the channel hidden (only users with SeeChannel see it).
   *  - `expiryMode` 1 = absolute, 2 = sliding; with `expirySeconds` the lifetime/
   *    idle window. The dialog edits value + unit, so we set the value in seconds
   *    via the "seconds" unit for deterministic short timeouts in tests.
   */
  async createSubChannel(
    parentId: number,
    name: string,
    opts: {
      pchatProtocol?: string;
      hidden?: boolean;
      expiryMode?: 1 | 2;
      expirySeconds?: number;
      /** Names of registered users to invite (implies a hidden private room). */
      invitees?: readonly string[];
    } = {},
  ): Promise<void> {
    await this.ensureChannelsTab();
    const parent = await this.d.wait(until.elementLocated(this.byChannelId(parentId)), config.waitTimeout);
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
    // Set the value through the DOM: a non-US compositor keymap types "-" as
    // "ß", so "e2e-ch-1234" was created as "e2eßchß1234" and never matched what
    // the test waited for. See setReactInputValue.
    await setReactInputValue(this.d, nameInput, name);

    if (opts.pchatProtocol) {
      const select = await this.d.findElement(By.css("#ch-ed-pchat"));
      await setReactSelectValue(this.d, select, opts.pchatProtocol);
    }

    const wantHidden = opts.hidden || (opts.invitees?.length ?? 0) > 0;
    if (wantHidden) {
      const cb = await this.d.findElement(By.css("#ch-ed-hidden"));
      if (!(await cb.isSelected())) await cb.click();
    }

    // The invitee picker only renders once "hidden" is checked.
    if (opts.invitees?.length) {
      const picker = await this.d.wait(
        until.elementLocated(By.css('[data-testid="ch-ed-invitee-input"]')),
        5000,
      );
      for (const inviteeName of opts.invitees) {
        await picker.clear();
        await picker.sendKeys(inviteeName);
        const suggestion = By.xpath(
          `//*[@role='dialog']//ul//li//button[contains(normalize-space(.), ${xpathLiteral(inviteeName)})]`,
        );
        const sugg = await this.d.wait(
          until.elementLocated(suggestion),
          config.waitTimeout,
          `invitee "${inviteeName}" never became a suggestion`,
        );
        await sugg.click();
      }
    }

    if (opts.expiryMode) {
      const modeSel = await this.d.findElement(By.css("#ch-ed-expiry-mode"));
      await setReactSelectValue(this.d, modeSel, String(opts.expiryMode));
      // The value+unit fields only render once a mode is chosen.
      const valueInput = await this.d.wait(until.elementLocated(By.css("#ch-ed-expiry-value")), 5000);
      await valueInput.clear();
      await valueInput.sendKeys(String(opts.expirySeconds ?? 0));
      const unitSel = await this.d.findElement(By.css("#ch-ed-expiry-unit"));
      await setReactSelectValue(this.d, unitSel, "1"); // seconds
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

  /** Whether a channel with the given name is currently in the sidebar (no wait). */
  async hasChannel(name: string): Promise<boolean> {
    return (await this.d.findElements(this.byChannelName(name))).length > 0;
  }

  /** The server-assigned channel id for the named channel (read from its row). */
  async channelIdByName(name: string): Promise<string> {
    const el = await this.d.wait(until.elementLocated(this.byChannelName(name)), config.waitTimeout);
    return (await el.getAttribute("data-channel-id")) ?? "";
  }

  /**
   * Whether a channel with the given id is present (no wait). Stronger than
   * hasChannel for leak checks: a leaked hidden channel may arrive with only its
   * id (no name), so it would slip past a name-based check but not this one.
   */
  async hasChannelId(id: string): Promise<boolean> {
    if (!id) return false;
    return (await this.d.findElements(this.byChannelId(Number(id)))).length > 0;
  }

  /**
   * Return to the main channel view from another route (e.g. the Friends page)
   * by activating the connected server's tab in the left server rail. The
   * server tab is the only `role="tab"` element with `aria-selected="true"`
   * while off the channel view (the Channels/Members sidebar tabs aren't
   * mounted there). Resolves once the channel sidebar's "Channels" tab exists.
   */
  async goToChannels(): Promise<void> {
    const tab = await this.d.wait(
      until.elementLocated(By.css('[role="tab"][aria-selected="true"]')),
      10000,
    );
    await tab.click();
    await this.d.wait(
      until.elementLocated(By.xpath("//button[@role='tab' and normalize-space(.)='Channels']")),
      10000,
    );
  }

  /** Wait until a channel with the given name is gone from the sidebar. */
  async waitForChannelGone(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(
      async () => (await this.d.findElements(this.byChannelName(name))).length === 0,
      timeout,
      `channel "${name}" was still visible after ${timeout}ms`,
    );
  }

  /**
   * Double-click a channel to MOVE the local user into it (membership), not just
   * select it for viewing. The double-click can land as a select-only (the two
   * clicks race the re-render), so retry until the self row confirms membership.
   */
  async joinChannel(name: string): Promise<void> {
    await this.ensureChannelsTab();
    for (let attempt = 0; attempt < 4; attempt++) {
      const el = await this.d.wait(until.elementLocated(this.byChannelName(name)), config.waitTimeout);
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
   * Right-click a user row and click an admin action by its menu label.
   *
   * The user context menu has no root test id, so items are addressed by their
   * English label (the suite forces English), matching {@link registerUser}.
   */
  private async userMenuAction(name: string, label: string): Promise<void> {
    const row = await this.d.wait(
      until.elementLocated(
        By.css(`[data-testid="${TID.memberItem}"][${MEMBER_NAME_ATTR}="${cssAttrEscape(name)}"]`),
      ),
      config.waitTimeout,
    );
    await this.d.actions().contextClick(row).perform();
    await delay(400);
    const item = await this.d.wait(
      until.elementLocated(By.xpath(`//button[normalize-space(.)=${xpathLiteral(label)}]`)),
      8000,
    );
    await this.d.wait(until.elementIsVisible(item), 5000);
    await item.click();
    await delay(400);
  }

  /** Server-mute `name` (admin; MuteDeafen on their channel). */
  async muteUser(name: string): Promise<void> {
    await this.userMenuAction(name, "Mute");
  }

  /** Server-deafen `name` (admin; MuteDeafen on their channel). */
  async deafenUser(name: string): Promise<void> {
    await this.userMenuAction(name, "Deafen");
  }

  /** Grant `name` priority speaker (admin; MuteDeafen on their channel). */
  async setPrioritySpeaker(name: string): Promise<void> {
    await this.userMenuAction(name, "Priority speaker");
  }

  /**
   * Right-click a user row and register them on the server (admin only). The
   * relay-based features (calendar, file-server) route by a stable registered
   * `user_id`, so an anonymous peer must be registered before it can be invited.
   * Synchronisation on the new `user_id` propagating is left to the caller (the
   * calendar invitee autocomplete only resolves once it lands).
   *
   * Registration takes two clicks: the menu item and then the confirmation,
   * which together are what registers anybody.
   *
   * "Register" in the context menu only *opens* a `ConfirmDialog`
   * (`UserContextMenu.tsx:406` sets `registerConfirm`); the request is sent by
   * that dialog's own button, which is **also** labelled "Register"
   * (`sidebar.json` `userMenu.register` and `userMenu.registerConfirm`). So an
   * xpath on the label alone matches the menu item, opens the dialog, and stops
   * — nothing reaches the server, and the dialog is left on screen to swallow
   * whatever the test clicks next.
   *
   * Both locators are therefore scoped: the first to the menu, the second to
   * the dialog. Confirming here rather than in a separate method because every
   * caller wants the user registered — an unconfirmed click registers nobody,
   * which is not a state any test is written to be in.
   */
  async registerUser(name: string): Promise<void> {
    const row = await this.d.wait(
      until.elementLocated(
        By.css(`[data-testid="${TID.memberItem}"][${MEMBER_NAME_ATTR}="${cssAttrEscape(name)}"]`),
      ),
      config.waitTimeout,
    );
    await this.d.actions().contextClick(row).perform();
    await delay(400);

    const menuItem = await this.d.wait(
      until.elementLocated(
        By.xpath("//div[contains(@class,'menu')]//button[normalize-space(.)='Register']"),
      ),
      8000,
    );
    await this.d.wait(until.elementIsVisible(menuItem), 5000);
    await menuItem.click();

    // Located after the click, so the wait cannot resolve against the menu item
    // that is still on screen when it starts.
    await delay(400);
    const confirm = await this.d.wait(
      until.elementLocated(
        By.xpath(
          "//*[contains(@class,'dialog') or @role='dialog']//button[normalize-space(.)='Register']",
        ),
      ),
      8000,
    );
    await this.d.wait(until.elementIsVisible(confirm), 5000);
    await confirm.click();
    await delay(400);
  }

  /**
   * The self row's full text, or null when there is no self row.
   *
   * Read with `textContent`, NOT WebDriver's `getText()`: the sidebar clips the
   * name and channel chip at narrow widths, so `getText()` — which returns only
   * what is *rendered* — yields just the avatar initial ("S"). Membership was
   * then never confirmed even though the user had moved, and every caller
   * failed with "membership not confirmed" against a client that was in the
   * right channel.
   */
  private async selfRowText(): Promise<string | null> {
    return this.d.executeScript<string | null>(
      `const row = document.querySelector('[data-testid="' + arguments[0] + '"][data-clickable="true"]');
       return row ? row.textContent : null;`,
      TID.memberItem,
    );
  }

  /**
   * Wait until the local user is a MEMBER of `name`. The sidebar self row
   * (the only member-item with data-clickable=true) carries a channel chip
   * showing the channel the user is currently in.
   */
  async waitForMembership(name: string, timeout = 12000): Promise<void> {
    await this.d.wait(async () => (await this.selfRowText())?.includes(name) ?? false, timeout);
  }

  /**
   * Wait until the local user is still connected (the self row exists) but NO
   * longer a member of `name`. Used to assert that when a channel is removed
   * (e.g. expiry), its occupant is moved to the parent rather than disconnected.
   */
  async waitForMembershipGone(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(async () => {
      const text = await this.selfRowText();
      if (text === null) return false; // self row missing -> disconnected, not "moved"
      return !text.includes(name);
    }, timeout);
  }

  private byChannelMember(name: string): By {
    return By.css(`[data-testid="${TID.channelMember}"][${MEMBER_NAME_ATTR}="${cssAttrEscape(name)}"]`);
  }

  /**
   * Whether a user row for `name` is currently rendered *in the channel tree*
   * (nested under a channel), as opposed to the members roster. On the Channels
   * tab the members pane is `display:none`, so a *displayed* member-item can only
   * be one rendered under a channel. This is the stronger signal for presence:
   * a user revealed as "online" still shows in the roster, but a user we can't
   * place (hidden channel / sentinel) is never shown under a channel.
   */
  async hasChannelViewMember(name: string): Promise<boolean> {
    await this.ensureChannelsTab();
    const els = await this.d.findElements(this.byChannelMember(name));
    for (const el of els) {
      if (await el.isDisplayed().catch(() => false)) return true;
    }
    return false;
  }

  /** Wait until a user row for `name` is rendered under a channel in the tree. */
  async waitForChannelViewMember(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(
      () => this.hasChannelViewMember(name),
      timeout,
      `user "${name}" never appeared under a channel in the sidebar tree`,
    );
  }

  /** Whether the channel-join password dialog is currently shown. */
  async hasPasswordPrompt(): Promise<boolean> {
    return (await this.d.findElements(byTid(TID.passwordPromptDialog))).length > 0;
  }

  /**
   * Whether a private room with the given (display) name is listed in the flat
   * "Private rooms"/Meetings viewer above the channel tree. Meeting rooms are
   * shown there by their stripped meeting name, not in the main tree.
   */
  async hasPrivateRoom(displayName: string): Promise<boolean> {
    const els = await this.d.findElements(
      By.css(
        `[data-testid="${TID.privateChannelsViewer}"] ` +
          `[data-testid="${TID.channelItem}"][data-channel-name="${cssAttrEscape(displayName)}"]`,
      ),
    );
    return els.length > 0;
  }

  /** Wait until a private room with the given display name appears in the viewer. */
  async waitForPrivateRoom(displayName: string, timeout = 20000): Promise<void> {
    await this.d.wait(
      () => this.hasPrivateRoom(displayName),
      timeout,
      `private room "${displayName}" never appeared in the Private rooms viewer`,
    );
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
