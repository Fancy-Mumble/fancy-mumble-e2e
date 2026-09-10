import { By, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID, MEMBER_REGISTERED_ATTR } from "../../selectors";
import { config } from "../../config";
import { isNebula } from "../../ui-flavour";
import { openMemberPanel } from "../../util/nebula";
import { selectTab } from "../../util/tabs";
import { cssAttrEscape } from "../../util/css";

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

/**
 * The roster of members shown alongside the chat - presence, registration,
 * avatars, and the voice flags each row carries.
 *
 * Split out of {@link import("./chat.page").ChatPage} because every method
 * here shares one precondition and one locator: the Members pane has to be
 * showing, and a member is addressed by `member-item` + `data-user-name`.
 * That pairing is what the rest of the chat page kept having to know about.
 */
export class MemberRoster {
  constructor(private readonly d: WebDriver) {}

  /**
   * CSS locator for a member row, optionally narrowed by a state attribute.
   *
   * Public because the chat page addresses the same rows for gestures that are
   * not roster reads - opening a DM, adding a friend.
   */
  row(name: string, extra = ""): By {
    return By.css(
      `[data-testid="${TID.memberItem}"][data-user-name="${cssAttrEscape(name)}"]${extra}`,
    );
  }

  /**
   * Switch the sidebar to the Members tab once. Member rows there are
   * `UserListItem`s carrying member-item / data-muted / data-deaf; the default
   * Channels tab renders users with a different component (no test ids). Once
   * mounted the pane stays in the DOM (hidden when inactive), so elementLocated
   * still finds rows after switching away.
   */
  async ensureVisible(): Promise<void> {
    if (isNebula) return openMemberPanel(this.d);
    await this.select();
    await this.d.wait(until.elementLocated(byTid(TID.memberList)), config.waitTimeout);
  }

  /** Activate the Members tab without requiring the member list to mount. */
  async select(): Promise<void> {
    if (isNebula) return openMemberPanel(this.d);
    // Gate on aria-selected, not on DOM presence of the member list: once
    // mounted the pane stays in the DOM (display:none) while the Channels tab
    // is active, so its rows would be located but not interactable.
    await selectTab(this.d, "Members");
  }

  /** Wait for a member row with the given display name to appear in the list. */
  async waitForMember(name: string, timeout = 20000): Promise<void> {
    await this.ensureVisible();
    await this.d.wait(until.elementLocated(this.row(name)), timeout);
  }

  /**
   * Wait until the named member's row is gone from the list. Used to assert
   * presence hiding: when a user moves into a hidden channel the viewer can't
   * see, the server sends a UserRemove so they vanish from the viewer's roster.
   *
   * Deliberately does NOT require the member-list element to be mounted:
   * when the last other member leaves, MembersTab swaps the list for a
   * "No other members" empty state - i.e. the success condition itself
   * unmounts the list, so gating on it (like {@link ensureVisible} does) would
   * deadlock. The pane must still show *either* the list or the empty state
   * before we accept "0 rows", so an unmounted pane can't false-positive.
   */
  async waitForMemberGone(name: string, timeout = 20000): Promise<void> {
    await this.select();
    await this.d.wait(
      async () => {
        if ((await this.d.findElements(this.row(name))).length > 0) return false;
        if ((await this.d.findElements(byTid(TID.memberList))).length > 0) return true;
        return (await this.d.findElements(MemberRoster.emptyState)).length > 0;
      },
      timeout,
      `member "${name}" was still visible after ${timeout}ms`,
    );
  }

  /**
   * MembersTab's roster-is-empty placeholder (sidebar.json `membersTab.empty`;
   * the suite forces English). It has no test id, so match the text.
   */
  private static readonly emptyState = By.xpath(
    "//*[normalize-space(.)='No other members' and not(*)]",
  );

  /**
   * Whether a member's row shows a real avatar image.
   *
   * `UserListItem` renders an `<img>` only when it has resolved a texture; with
   * none it draws a coloured initial instead (`UserListItem.tsx:365`). So the
   * presence of the `img` *is* the assertion - and it is a stronger one than a
   * hash on the wire, because the image only appears once the receiving client
   * has fetched the blob by hash and decoded it.
   */
  async hasAvatar(name: string): Promise<boolean> {
    await this.ensureVisible();
    const found = await this.d.findElements(this.row(name, " img"));
    return found.length > 0;
  }

  /** Wait until a member's avatar image has arrived and rendered. */
  async waitForAvatar(name: string, timeout = 20000): Promise<void> {
    await this.ensureVisible();
    await this.d.wait(
      until.elementLocated(this.row(name, " img")),
      timeout,
      `no avatar image rendered for "${name}"`,
    );
  }

  /**
   * Whether a member is currently shown as registered.
   *
   * The immediate counterpart to {@link waitForRegistered}: that one proves a
   * registration *arrived*, this one proves one has *not* - which needs an
   * answer now rather than a wait, since waiting for an absence only ever
   * reports the timeout.
   */
  async isRegistered(name: string): Promise<boolean> {
    await this.ensureVisible();
    const found = await this.d.findElements(this.row(name, `[${MEMBER_REGISTERED_ATTR}="true"]`));
    return found.length > 0;
  }

  /**
   * Wait until the named member's row shows the "Registered" status icon - i.e.
   * the server has committed their registration and broadcast the new user_id.
   * Registration is keyed by the live session, so a peer that disconnects before
   * it commits is never persisted; confirm it landed before relying on the
   * registered-user directory to invite them while offline.
   */
  async waitForRegistered(name: string, timeout = 20000): Promise<void> {
    await this.ensureVisible();
    await this.d.wait(
      until.elementLocated(this.row(name, `[${MEMBER_REGISTERED_ATTR}="true"]`)),
      timeout,
      `"${name}" never showed as registered`,
    );
  }

  /** Wait until the named member's row shows the muted state. */
  async waitForMemberMuted(name: string, timeout = 20000): Promise<void> {
    await this.ensureVisible();
    await this.d.wait(until.elementLocated(this.row(name, '[data-muted="true"]')), timeout);
  }

  /** Wait until the named member's row shows the deafened state. */
  async waitForMemberDeaf(name: string, timeout = 20000): Promise<void> {
    await this.ensureVisible();
    await this.d.wait(until.elementLocated(this.row(name, '[data-deaf="true"]')), timeout);
  }

  /**
   * Read the local user's own voice flags from the sidebar self row. That row
   * is the only `member-item` carrying `data-clickable="true"` (isSelf), so it
   * uniquely identifies "me" regardless of name collisions.
   */
  async selfVoiceFlags(): Promise<VoiceFlags> {
    // The roster has to be showing first. Standard keeps it mounted behind a
    // tab once visited; Nebula unmounts the panel, so without this the self
    // row is not merely hidden, it is absent.
    await this.ensureVisible();
    const el = await this.d.wait(
      until.elementLocated(By.css(`[data-testid="${TID.memberItem}"][data-clickable="true"]`)),
      10000,
    );
    return readVoiceFlags(el);
  }

  /** Read a peer's voice flags as shown to this client in the Members tab. */
  async peerVoiceFlags(name: string): Promise<VoiceFlags> {
    await this.ensureVisible();
    const el = await this.d.wait(until.elementLocated(this.row(name)), config.waitTimeout);
    return readVoiceFlags(el);
  }

  /**
   * Add `name` as a friend via the row's context menu (`UserActions.tsx` /
   * `UserContextMenu`). The friend is keyed by the user's TLS cert hash, so
   * the target must be a registered/known user.
   */
  async addFriend(name: string): Promise<void> {
    await this.ensureVisible();
    const row = await this.d.wait(until.elementLocated(this.row(name)), config.waitTimeout);
    await this.d.wait(until.elementIsVisible(row), 5000);
    await this.d.actions().contextClick(row).perform();
    const toggle = await this.d.wait(until.elementLocated(byTid(TID.userMenuFriendToggle)), 8000);
    await this.d.wait(until.elementIsVisible(toggle), 5000);
    await toggle.click();
  }

  /** Wait until the peer's row reflects the expected voice flags (or throw). */
  async waitForPeerVoice(
    name: string,
    expected: VoiceFlags,
    timeout = config.waitTimeout,
  ): Promise<void> {
    await this.ensureVisible();
    const row = this.row(name);
    await this.d.wait(async () => {
      const els = await this.d.findElements(row);
      if (els.length === 0) return false;
      const f = await readVoiceFlags(els[0]);
      return f.muted === expected.muted && f.deaf === expected.deaf;
    }, timeout);
  }
}
