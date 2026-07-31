import { By, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { xpathLiteral } from "../util/xpath";
import { delay } from "../util/wait";
import { needsScriptedInput, setReactInputValue } from "../util/astral";

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
    // Both connect-time modals, so both belong here. The trust prompt only
    // appears against a server that actually ships plugins, which the published
    // fixture image did not - so 35 of the 41 files never learned to answer it,
    // and every one of them broke the moment the server was built from
    // vendor/server. It renders with `closeOnEsc=false` and an overlay that
    // swallows clicks, so the symptom is an unrelated
    // ElementClickInterceptedError several steps later.
    await this.allowServerPlugins();
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

  /**
   * Resolve the plugin trust prompt (the modal a server with bundled plugins
   * raises a beat after connect; `closeOnEsc=false`, so it MUST be answered)
   * by allowing all offered plugins for this server. No-op when the prompt
   * never shows within `timeout`. Call before driving UI that a lingering
   * modal overlay would otherwise click-intercept.
   */
  async allowServerPlugins(timeout = 8000): Promise<void> {
    const allowSel = By.xpath(
      "//*[@role='dialog']//button[normalize-space(.)='Allow all for this server'" +
        " or normalize-space(.)='Allow for this server']",
    );
    try {
      const btn = await this.d.wait(until.elementLocated(allowSel), timeout);
      await btn.click();
      await this.d.wait(async () => (await this.d.findElements(allowSel)).length === 0, 5000);
    } catch {
      /* no trust prompt (no plugins, or already trusted) */
    }
  }

  /** Type into the composer's textarea and click send. */
  async sendMessage(text: string): Promise<void> {
    const wrap = await this.d.wait(until.elementLocated(byTid(TID.chatComposerInput)), 15000);
    const editable = await wrap.findElement(By.css("textarea"));
    await editable.click();

    if (needsScriptedInput(text)) {
      // The keyboard cannot deliver this faithfully: msedgedriver refuses
      // astral code points outright, and a newline presses Enter, which
      // submits and sends the remainder as a second message. Both are
      // limitations of the harness rather than the product, and the server's
      // handling of such payloads is exactly what this path exists to test.
      // So set the value directly and raise the event React listens for.
      await setReactInputValue(this.d, editable, text);
    } else {
      await editable.sendKeys(text);
    }

    const send = await this.d.findElement(byTid(TID.chatSend));
    await this.d.wait(until.elementIsEnabled(send), 5000);
    await send.click();
  }

  /** Type without submitting; useful for exercising typing-indicator transport. */
  async typeMessage(text: string): Promise<void> {
    const wrap = await this.d.wait(until.elementLocated(byTid(TID.chatComposerInput)), 15000);
    const editable = await wrap.findElement(By.css("textarea"));
    await editable.click();
    await editable.sendKeys(text);
  }

  /**
   * Open a direct-message conversation with a user by clicking their member
   * row (a single click enters DM mode - see ChannelSidebar.handleUserClick ->
   * selectDmUser). The row must be present and online, so this doubles as a
   * check that the user is currently visible in the roster.
   */
  async openDirectMessage(name: string): Promise<void> {
    await this.ensureMembersTab();
    const row = await this.d.wait(until.elementLocated(this.memberRow(name)), 15000);
    await row.click();
  }

  /** Open a DM with `name` and send them `text` directly. */
  async sendDirectMessage(name: string, text: string): Promise<void> {
    await this.openDirectMessage(name);
    await this.sendMessage(text);
  }

  /** Whether the chat header's end-to-end-encrypted badge is shown (i.e. the open
   *  chat is an E2E signal channel - e.g. a friend chat that upgraded). */
  async hasE2EBadge(): Promise<boolean> {
    return (await this.d.findElements(byTid(TID.chatE2EBadge))).length > 0;
  }

  /** Wait until the chat header's E2E badge appears (the chat became E2E). */
  async waitForE2EBadge(timeout = 15000): Promise<void> {
    await this.d.wait(
      until.elementLocated(byTid(TID.chatE2EBadge)),
      timeout,
      "chat never showed the end-to-end-encrypted badge",
    );
  }

  /** The chat header's title text (channel/peer display name). */
  async headerTitle(): Promise<string> {
    const el = await this.d.wait(until.elementLocated(byTid(TID.chatHeaderTitle)), 10000);
    return (await el.getText()).trim();
  }

  /**
   * Add `name` as a friend via the roster row's context menu. The friend is keyed
   * by the user's TLS cert hash, so the target must be a registered/known user.
   */
  async addFriend(name: string): Promise<void> {
    await this.ensureMembersTab();
    const row = await this.d.wait(until.elementLocated(this.memberRow(name)), 15000);
    await this.d.wait(until.elementIsVisible(row), 5000);
    await this.d.actions().contextClick(row).perform();
    const toggle = await this.d.wait(until.elementLocated(byTid(TID.userMenuFriendToggle)), 8000);
    await this.d.wait(until.elementIsVisible(toggle), 5000);
    await toggle.click();
  }

  private senderRow(sender: string): By {
    return By.css(
      `[data-testid="${TID.chatMessageSender}"][data-sender-name="${cssAttrEscape(sender)}"]`,
    );
  }

  /** Wait until a rendered message is attributed to `sender`. */
  async waitForMessageFrom(sender: string, timeout = 15000): Promise<void> {
    await this.d.wait(
      until.elementLocated(this.senderRow(sender)),
      timeout,
      `no message attributed to "${sender}" appeared`,
    );
  }

  /** Whether any currently rendered message is attributed to `sender`. */
  async hasMessageFrom(sender: string): Promise<boolean> {
    return (await this.d.findElements(this.senderRow(sender))).length > 0;
  }

  /** Open the channel menu and create a poll through the shipped UI. */
  async createPoll(question: string, options: string[], multiple = false): Promise<void> {
    const menu = await this.d.wait(
      until.elementLocated(By.css('button[aria-label="Channel options"]')),
      10000,
    );
    await menu.click();
    // `KebabMenu` sets `key={item.id}` — a React key, which never reaches the
    // DOM — so `By.id("create-poll")` matched nothing and never could. The
    // rendered item is a `role="menuitem"` carrying only its label, so that is
    // what identifies it.
    await this.d
      .wait(
        until.elementLocated(
          By.xpath(`//*[@role='menuitem'][normalize-space(.)=${xpathLiteral("Create poll")}]`),
        ),
        5000,
      )
      .then((el) => el.click());
    const dialog = await this.d.wait(until.elementLocated(By.css('[role="dialog"]')), 5000);
    const inputs = await dialog.findElements(By.css("input"));
    await inputs[0].sendKeys(question);
    for (let i = 0; i < options.length; i++) await inputs[i + 1].sendKeys(options[i]);
    if (multiple) await dialog.findElement(By.css('input[type="checkbox"]')).click();
    await dialog.findElement(By.xpath(".//button[normalize-space(.)='Create Poll']")).click();
  }

  /** Vote in the first rendered poll containing `question`. */
  async votePoll(question: string, option: string): Promise<void> {
    // `PollCard` renders each option as a <button> holding a <span> of the
    // option text — there is no <label> and no <input>, so both halves of the
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
      15000,
    );
    const choice = await card.findElement(
      By.xpath(`.//button[contains(normalize-space(.), ${xpathLiteral(option)})]`),
    );
    await choice.click();
    const vote = await card.findElements(By.xpath(".//button[contains(normalize-space(.), 'Vote')]"));
    if (vote.length > 0) await vote[0].click();
  }

  /** Right-click a persistent message and choose Pin/Unpin. */
  async togglePin(messageText: string): Promise<void> {
    const wrapper = await this.d.wait(
      until.elementLocated(By.xpath(`//*[@data-msg-id][contains(normalize-space(.), ${xpathLiteral(messageText)})]`)),
      15000,
    );
    await this.d.actions().contextClick(wrapper).perform();
    const item = await this.d.wait(
      until.elementLocated(By.xpath("//button[normalize-space(.)='Pin' or normalize-space(.)='Unpin']")),
      5000,
    );
    await item.click();
  }

  /** Open the pinned-message panel from the channel menu. */
  async openPinnedMessages(): Promise<void> {
    const menu = await this.d.wait(until.elementLocated(By.css('button[aria-label="Channel options"]')), 10000);
    await menu.click();
    await this.d.wait(
      until.elementLocated(By.xpath("//*[@id='pinned-messages' or normalize-space(.)='Pinned messages']")),
      5000,
    ).then((el) => el.click());
  }

  /** Count the currently rendered messages attributed to `sender`. */
  async messageCountFrom(sender: string): Promise<number> {
    return (await this.d.findElements(this.senderRow(sender))).length;
  }

  /** Wait until exactly `count` messages from `sender` are rendered. */
  async waitForMessageCountFrom(sender: string, count: number, timeout = 20000): Promise<void> {
    await this.d.wait(
      async () => (await this.messageCountFrom(sender)) === count,
      timeout,
      `expected exactly ${count} messages from "${sender}"`,
    );
  }

  /** Wait until some element on the page renders `text` (message delivered). */
  async waitForText(text: string, timeout = 15000): Promise<void> {
    // Normalise the needle the same way the haystack is normalised. XPath's
    // `normalize-space()` collapses every run of whitespace in the rendered
    // text to one space, so a needle that still contains a newline is compared
    // against text where that newline is already a space, and `contains()` can
    // never be true. A multi-line message therefore failed to be found even
    // though it had arrived and rendered correctly.
    const needle = text.replace(/\s+/gu, " ").trim();
    const xp = By.xpath(`//*[contains(normalize-space(string(.)), ${xpathLiteral(needle)})]`);
    await this.d.wait(until.elementLocated(xp), timeout);
  }

  /** Wait for the read-receipt state rendered on a message bubble. */
  async waitForReadReceipt(messageText: string, expectedTitle = "Read"): Promise<void> {
    const message = By.xpath(
      `//*[@data-msg-id][contains(normalize-space(.), ${xpathLiteral(messageText)})]`,
    );
    await this.d.wait(until.elementLocated(message), 15000);
    await this.d.wait(
      until.elementLocated(
        By.xpath(`//*[@data-msg-id][contains(normalize-space(.), ${xpathLiteral(messageText)})]` +
          `//*[@aria-label=${xpathLiteral(expectedTitle)} or starts-with(@title, ${xpathLiteral(expectedTitle)})]`),
      ),
      15000,
      `message did not reach read-receipt state ${expectedTitle}`,
    );
  }

  /** Whether `text` is currently rendered anywhere (no waiting). */
  async hasText(text: string): Promise<boolean> {
    const xp = By.xpath(`//*[contains(normalize-space(string(.)), ${xpathLiteral(text)})]`);
    return (await this.d.findElements(xp)).length > 0;
  }

  /**
   * Approve pending key-share consent dialogs ("Share Key"). Sharing an
   * encryption key with a peer is gated behind explicit user consent (the
   * KeyShareWarningDialog), so a peer can only decrypt once the key holder
   * approves. Dialogs appear asynchronously as peers announce their keys, so
   * poll for the whole window and approve each as it shows. Returns the count.
   */
  async approveKeyShares(maxWaitMs = 15000): Promise<number> {
    const shareBtn = By.xpath("//*[@role='dialog']//button[normalize-space(.)='Share Key']");
    let approved = 0;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const btns = await this.d.findElements(shareBtn);
      if (btns.length > 0) {
        try {
          await btns[0].click();
          approved++;
          await delay(700);
          continue;
        } catch {
          /* dialog re-rendered; re-poll */
        }
      }
      await delay(800);
    }
    return approved;
  }

  /**
   * Upload a file via the composer's "File" attach option (the file-server
   * plugin path). The native file picker (`plugin:dialog|open`) is intercepted
   * in the webview to return `hostFilePath` so Selenium never faces a native
   * dialog, then the FileShareDialog is submitted with its defaults ("session"
   * access, default TTL). Requires the SHARE_FILES permission, so the attach
   * "File" option is only present for an authorised user (e.g. SuperUser).
   */
  async uploadFileViaAttach(hostFilePath: string): Promise<void> {
    await this.d.executeScript(
      `window.__e2eAttachPath = arguments[0];
       if (!window.__e2eDialogMocked) {
         const inv = window.__TAURI_INTERNALS__.invoke;
         window.__TAURI_INTERNALS__.invoke = function (cmd, args, opts) {
           if (cmd === 'plugin:dialog|open') return Promise.resolve(window.__e2eAttachPath);
           return inv.call(this, cmd, args, opts);
         };
         window.__e2eDialogMocked = true;
       }`,
      hostFilePath,
    );
    // Open the attach menu (its tooltip only reads "...or file" once the
    // file-server capabilities are loaded and upload is permitted) and pick File.
    const attachBtn = await this.d.wait(
      until.elementLocated(By.xpath("//button[@title='Attach image or file']")),
      20000,
    );
    await attachBtn.click();
    const fileItem = await this.d.wait(
      until.elementLocated(By.xpath("//button[@role='menuitem' and normalize-space(.)='File']")),
      8000,
    );
    await fileItem.click();
    // FileShareDialog: submit with defaults.
    const uploadBtn = await this.d.wait(
      until.elementLocated(By.xpath("//*[@role='dialog']//button[normalize-space(.)='Upload']")),
      10000,
    );
    await this.d.wait(until.elementIsEnabled(uploadBtn), 8000);
    await uploadBtn.click();
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

  /**
   * Capture desktop notifications the app raises. The native notification IPC
   * (`plugin:notification|notify`) can't be intercepted from the webview - its
   * `__TAURI_INTERNALS__.invoke` is locked non-writable - so the app mirrors
   * every notification onto a `fancy:desktop-notification` DOM event (see
   * `showDesktopNotification`), which we record here as `{ title, body }`.
   * Install before the action that should notify. Idempotent.
   */
  async installNotificationCapture(): Promise<void> {
    await this.d.executeScript(`
      window.__e2eNotifications = window.__e2eNotifications || [];
      if (!window.__e2eNotifyCapture) {
        window.__e2eNotifyCapture = function (e) {
          try {
            const d = e.detail || {};
            window.__e2eNotifications.push({ title: d.title || '', body: d.body || '' });
          } catch (err) { /* ignore */ }
        };
        window.addEventListener('fancy:desktop-notification', window.__e2eNotifyCapture);
      }
    `);
  }

  /** All notifications captured since {@link installNotificationCapture}. */
  async notifications(): Promise<{ title: string; body: string }[]> {
    return this.d.executeScript("return window.__e2eNotifications || [];");
  }

  /**
   * Wait until a captured notification has `match` in its title or body, and
   * return it. Use a phrase unique to the notification under test (e.g. the
   * meeting title, or "Meeting invitation") so reminder and invite notifications
   * don't alias each other.
   */
  async waitForNotification(
    match: string,
    timeout = 30000,
  ): Promise<{ title: string; body: string }> {
    let found: { title: string; body: string } | undefined;
    await this.d.wait(async () => {
      const list = await this.notifications();
      found = list.find((n) => n.title.includes(match) || n.body.includes(match));
      return found !== undefined;
    }, timeout, `no notification matching "${match}" was fired`);
    return found!;
  }

  /** Wait for a member row with the given display name to appear in the list. */
  async waitForMember(name: string, timeout = 20000): Promise<void> {
    await this.ensureMembersTab();
    await this.d.wait(until.elementLocated(this.memberRow(name)), timeout);
  }

  /**
   * Wait until the named member's row is gone from the list. Used to assert
   * presence hiding: when a user moves into a hidden channel the viewer can't
   * see, the server sends a UserRemove so they vanish from the viewer's roster.
   *
   * Deliberately does NOT require the member-list element to be mounted:
   * when the last other member leaves, MembersTab swaps the list for a
   * "No other members" empty state - i.e. the success condition itself
   * unmounts the list, so gating on it (like ensureMembersTab does) would
   * deadlock. The pane must still show *either* the list or the empty state
   * before we accept "0 rows", so an unmounted pane can't false-positive.
   */
  async waitForMemberGone(name: string, timeout = 20000): Promise<void> {
    await this.selectMembersTab();
    await this.d.wait(
      async () => {
        if ((await this.d.findElements(this.memberRow(name))).length > 0) return false;
        if ((await this.d.findElements(byTid(TID.memberList))).length > 0) return true;
        return (await this.d.findElements(this.membersEmptyState)).length > 0;
      },
      timeout,
      `member "${name}" was still visible after ${timeout}ms`,
    );
  }

  /**
   * MembersTab's roster-is-empty placeholder (sidebar.json `membersTab.empty`;
   * the suite forces English). It has no test id, so match the text.
   */
  private readonly membersEmptyState = By.xpath(
    "//*[normalize-space(.)='No other members' and not(*)]",
  );

  /**
   * Wait until the named member's row shows the "Registered" status icon - i.e.
   * the server has committed their registration and broadcast the new user_id.
   * Registration is keyed by the live session, so a peer that disconnects before
   * it commits is never persisted; confirm it landed before relying on the
   * registered-user directory to invite them while offline.
   */
  /**
   * Whether a member's row shows a real avatar image.
   *
   * `UserListItem` renders an `<img>` only when it has resolved a texture; with
   * none it draws a coloured initial instead (`UserListItem.tsx:365`). So the
   * presence of the `img` *is* the assertion — and it is a stronger one than a
   * hash on the wire, because the image only appears once the receiving client
   * has fetched the blob by hash and decoded it.
   */
  async hasAvatar(name: string): Promise<boolean> {
    await this.ensureMembersTab();
    const found = await this.d.findElements(this.memberRow(name, " img"));
    return found.length > 0;
  }

  /** Wait until a member's avatar image has arrived and rendered. */
  async waitForAvatar(name: string, timeout = 20000): Promise<void> {
    await this.ensureMembersTab();
    await this.d.wait(
      until.elementLocated(this.memberRow(name, " img")),
      timeout,
      `no avatar image rendered for "${name}"`,
    );
  }

  /**
   * Whether a member currently carries the registered badge.
   *
   * The immediate counterpart to {@link waitForRegistered}: that one proves a
   * registration *arrived*, this one proves one has *not* — which needs an
   * answer now rather than a wait, since waiting for an absence only ever
   * reports the timeout.
   */
  async isRegistered(name: string): Promise<boolean> {
    await this.ensureMembersTab();
    const found = await this.d.findElements(this.memberRow(name, ' [title="Registered"]'));
    return found.length > 0;
  }

  async waitForRegistered(name: string, timeout = 20000): Promise<void> {
    await this.ensureMembersTab();
    await this.d.wait(
      until.elementLocated(this.memberRow(name, ' [title="Registered"]')),
      timeout,
    );
  }

  /**
   * Switch the sidebar to the Members tab once. Member rows there are
   * `UserListItem`s carrying member-item / data-muted / data-deaf; the default
   * Channels tab renders users with a different component (no test ids). Once
   * mounted the pane stays in the DOM (hidden when inactive), so elementLocated
   * still finds rows after switching away.
   */
  private async ensureMembersTab(): Promise<void> {
    await this.selectMembersTab();
    await this.d.wait(until.elementLocated(byTid(TID.memberList)), 15000);
  }

  /** Activate the Members tab without requiring the member list to mount. */
  private async selectMembersTab(): Promise<void> {
    // Activate the Members tab. Checking only DOM presence of the member list is
    // not enough: once mounted the pane stays in the DOM (display:none) when the
    // Channels tab is active, so its rows would be located but not interactable.
    // Gate on the tab's aria-selected, mirroring sidebar.ensureChannelsTab.
    const tab = await this.d.wait(
      until.elementLocated(By.xpath("//button[@role='tab' and normalize-space(.)='Members']")),
      10000,
    );
    if ((await tab.getAttribute("aria-selected")) !== "true") {
      await tab.click();
    }
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

  /**
   * The backend's authoritative voice state ("inactive" | "active" | "muted").
   * Unlike the self-mute INDICATOR (data-muted, which reflects the server-echoed
   * self_mute and lags a round-trip), this updates immediately, so driving the
   * mute controls off it avoids a tap-until-detected loop oscillating on the lag.
   */
  async voiceState(): Promise<string> {
    return this.d.executeAsyncScript<string>(`
      const cb = arguments[arguments.length - 1];
      const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv) { cb('no-invoke'); return; }
      inv('get_voice_state').then((r) => cb(String(r))).catch(() => cb('err'));
    `);
  }

  /** Drive the local user into the backend "muted" voice state (mic off, can hear). */
  async ensureMuted(): Promise<void> {
    // Cycle is inactive -> active -> muted. Decide from the authoritative voice
    // state and wait for each tap to land before tapping again.
    for (let i = 0; i < 6; i++) {
      const vs = await this.voiceState();
      if (vs === "muted") {
        await this.waitSelfMuted(true, 8000).catch(() => undefined); // let the indicator catch up
        return;
      }
      await this.tapMute();
      await this.d.wait(async () => (await this.voiceState()) !== vs, 6000).catch(() => undefined);
    }
  }

  /** Drive the local user into the "active" (voice on, unmuted, undeafened) state. */
  async ensureUnmuted(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const vs = await this.voiceState();
      if (vs === "active") {
        await this.waitSelfMuted(false, 8000).catch(() => undefined);
        return;
      }
      // Undeafen first if needed (deaf implies muted); otherwise tap mute to
      // move muted/inactive -> active.
      if ((await this.selfVoiceFlags()).deaf) await this.tapDeafen();
      else await this.tapMute();
      await this.d.wait(async () => (await this.voiceState()) !== vs, 6000).catch(() => undefined);
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
