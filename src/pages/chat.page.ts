import { By, error, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID, MEMBER_REGISTERED_ATTR } from "../selectors";
import { xpathLiteral } from "../util/xpath";
import { delay } from "../util/wait";
import { setReactInputValue } from "../util/astral";
import { config } from "../config";
import { isNebula, menuLabel } from "../ui-flavour";
import {
  clickWhenFree,
  dismissMenus,
  openMemberPanel,
  waitDisplayed,
  waitMenusClosed,
} from "../util/nebula";
import { selectTab } from "../util/tabs";
import {
  ensureSidebarOpen,
  ensureSidebarClosed,
  clickPossiblyHidden,
  contextClickPossiblyHidden,
  locateForGesture,
} from "../util/layout";

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
    // Both connect-time modals belong here: the server welcome message and the
    // plugin trust prompt. The trust prompt renders with `closeOnEsc=false`
    // and an overlay that swallows clicks, so an unanswered one surfaces as an
    // unrelated ElementClickInterceptedError several steps later - which is
    // how 35 of 41 files once broke at the same time.
    await this.answerConnectModals();
  }

  /**
   * Answer the connect-time modals - welcome message and plugin trust prompt -
   * with one watcher over both.
   *
   * These used to be two serial probes with their own generous timeouts (4 s
   * for welcome, 8 s for plugins), which priced every waitLoaded at ~12 s of
   * pure waiting against a server that raises neither - and the shared e2e
   * Starling configures no welcome text and ships no plugins, so that was
   * every connect of every sweep. Both modals are driven by messages that
   * arrive with the post-connect sync: by the time the composer has mounted
   * they are on screen or a render-beat away, so a short watch over both
   * selectors catches them, and each answered modal extends the watch in case
   * dismissing one reveals the next. A modal missed anyway fails exactly as
   * before: the next click is intercepted and its own retry names the overlay.
   */
  private async answerConnectModals(budgetMs = 2500): Promise<void> {
    const buttons = [
      By.xpath("//*[@role='dialog']//button[normalize-space(.)='Close']"),
      By.xpath(
        "//*[@role='dialog']//button[normalize-space(.)='Allow all for this server'" +
          " or normalize-space(.)='Allow for this server']",
      ),
    ];
    let deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      for (const sel of buttons) {
        const [btn] = await this.d.findElements(sel);
        if (!btn) continue;
        try {
          await btn.click();
          deadline = Date.now() + 2000; // dismissing one can reveal the next
        } catch {
          /* mid-animation or stale - the next pass re-finds it */
        }
      }
      await delay(150);
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
    await ensureSidebarClosed(this.d);
    // A menu a previous step left open lays a backdrop over the composer, and
    // the failure then names the composer rather than the menu.
    if (isNebula) await dismissMenus(this.d);
    // Retried as a whole, because every reference in it can go stale together.
    // The composer re-renders while three clients talk, and a 4 KiB message
    // re-renders it again mid-send: the textarea located a moment ago is
    // detached before the value reaches it, and WebDriver reports
    // StaleElementReference from whichever step got there first. Re-locating
    // one element would leave the others pointing at the old tree, so the
    // whole locate-fill-send sequence is what repeats.
    await this.withFreshComposer(async (editable) => {
      await editable.click();
      // Always through the DOM, never keystrokes. sendKeys was kept here for
      // realism, but on this rig it is keymap roulette: with the compositor's
      // layout active, "-" types as "ß" - verified live, a sent token stored as
      // "probeßtokenß…" - and whether it strikes depends on which window holds
      // focus at that moment. Every suite asserts on hyphenated tokens, so the
      // mangling reads as a delivery bug in whatever feature the suite
      // measures. (Astral and newline text needed this path anyway:
      // msedgedriver refuses astral code points, and a newline presses Enter
      // mid-message.)
      await setReactInputValue(this.d, editable, text);
      // Located fresh inside the retry, not hoisted: it belongs to the same
      // render as the textarea above, and a re-render invalidates both.
      const send = await this.d.findElement(byTid(TID.chatSend));
      await this.d.wait(until.elementIsEnabled(send), 5000);
      await send.click();
    });
  }

  /**
   * Run `use` against a freshly located composer textarea, retrying the whole
   * body when the element goes stale under a re-render.
   */
  private async withFreshComposer(
    use: (editable: WebElement) => Promise<void>,
    attempts = 4,
  ): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const wrap = await this.d.wait(
          until.elementLocated(byTid(TID.chatComposerInput)),
          config.waitTimeout,
        );
        const editable = await wrap.findElement(By.css("textarea"));
        await use(editable);
        return;
      } catch (e) {
        if (!(e instanceof error.StaleElementReferenceError)) throw e;
        last = e;
        await delay(200);
      }
    }
    throw new Error(`the chat composer stayed stale across ${attempts} attempts: ${last}`);
  }

  /** Type without submitting; useful for exercising typing-indicator transport. */
  async typeMessage(text: string): Promise<void> {
    await ensureSidebarClosed(this.d);
    const wrap = await this.d.wait(until.elementLocated(byTid(TID.chatComposerInput)), config.waitTimeout);
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
    const row = await this.d.wait(until.elementLocated(this.memberRow(name)), config.waitTimeout);
    // A sidebar row like any other: on a narrow window it is in the DOM and
    // out of reach.
    await clickPossiblyHidden(this.d, row);
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
  async waitForE2EBadge(timeout = config.waitTimeout): Promise<void> {
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
    const row = await this.d.wait(until.elementLocated(this.memberRow(name)), config.waitTimeout);
    await this.d.wait(until.elementIsVisible(row), 5000);
    await this.d.actions().contextClick(row).perform();
    const toggle = await this.d.wait(until.elementLocated(byTid(TID.userMenuFriendToggle)), 8000);
    await this.d.wait(until.elementIsVisible(toggle), 5000);
    await toggle.click();
  }

  /**
   * One element per message attributed to `sender` - which is not the same
   * element in the two packs.
   *
   * Standard names the sender on the block header's label, so this counts
   * groups. Nebula draws no author name on your own bubbles at all, so
   * attribution is read off the message row, which carries it whoever wrote
   * it. `:not([data-testid])` is what keeps that to one match: Nebula's label
   * carries the name *as well*, and counting both would report every message
   * from someone else twice - which is exactly what "delivered exactly once"
   * asserts on.
   */
  private senderRow(sender: string): By {
    const name = cssAttrEscape(sender);
    return isNebula
      ? By.css(`[data-sender-name="${name}"]:not([data-testid])`)
      : By.css(`[data-testid="${TID.chatMessageSender}"][data-sender-name="${name}"]`);
  }

  /** Wait until a rendered message is attributed to `sender`. */
  async waitForMessageFrom(sender: string, timeout = config.waitTimeout): Promise<void> {
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

  /**
   * Create a poll through the shipped UI.
   *
   * Where the poll composer is opened from is the one pack-specific step:
   * Standard offers it in the chat header's kebab, Nebula in the composer's
   * attach menu - the same feature filed under "what this channel can do" in
   * one and "what I can put in this message" in the other. Everything after it
   * is addressed by test id and is the same in both.
   */
  async createPoll(question: string, options: string[], multiple = false): Promise<void> {
    await ensureSidebarClosed(this.d);
    // Whatever a previous step left open would take this click instead.
    if (isNebula) await dismissMenus(this.d);
    const opener = isNebula ? TID.chatAttachMenu : TID.chatHeaderKebab;
    const menu = await this.d.wait(until.elementLocated(byTid(opener)), 10000);
    // Through `clickPossiblyHidden`: the composer's controls sit under whatever
    // transition a previous popover is still finishing, and a positional click
    // reports the scrim rather than the button.
    await clickPossiblyHidden(this.d, menu);
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
    // keymap (see sendMessage).
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
  async votePoll(question: string, option: string): Promise<void> {
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

  /** Right-click a persistent message and choose Pin/Unpin. */
  async togglePin(messageText: string): Promise<void> {
    // Through `locateForGesture`: the Actions API does not scroll to its
    // target, so a message below the fold of the river fails as
    // MoveTargetOutOfBounds - or, worse, opens no menu at all.
    const wrapper = await locateForGesture(
      this.d,
      By.xpath(`//*[@data-msg-id][contains(normalize-space(.), ${xpathLiteral(messageText)})]`),
    );
    // Hover first: the per-message action bar is revealed on hover, and the
    // context menu is the other way in. Both render a Pin button, and the
    // action bar's copy stays in the DOM while hidden - so taking the first
    // match gets an element that exists, is found, and cannot be clicked
    // (ElementNotInteractableError). `reactToMessage` already had to learn
    // this; click whichever copy is actually displayed.
    await this.d.actions().move({ origin: wrapper }).perform();
    await contextClickPossiblyHidden(this.d, wrapper);
    // Confirm the menu actually opened, and dispatch the event directly if it
    // did not. The Actions API aims at the element's centre, which on a wide
    // river is padding to the side of the bubble - the row still owns the
    // handler, but whatever is under the pointer can swallow the gesture
    // first. The synthetic event goes to the row that carries the handler.
    if ((await this.d.findElements(By.css('[role="menuitem"]'))).length === 0) {
      await this.d.executeScript(
        `const r = arguments[0].getBoundingClientRect();
         arguments[0].dispatchEvent(new MouseEvent("contextmenu", {
           bubbles: true, cancelable: true, view: window,
           clientX: Math.round(r.left + 24), clientY: Math.round(r.top + r.height / 2),
         }));`,
        wrapper,
      );
      await delay(300);
    }
    // Either verb, and either pack's wording for it: Nebula's menu names the
    // destination ("Pin to channel"), Standard's says only "Pin".
    const selector = By.xpath(
      `//*[self::button or @role='menuitem']` +
        `[normalize-space(.)=${xpathLiteral(menuLabel("pinMessage"))}` +
        ` or normalize-space(.)=${xpathLiteral(menuLabel("unpinMessage"))}]`,
    );
    try {
      await this.d.wait(until.elementLocated(selector), 5000);
    } catch (err) {
      // Say what the menu *did* offer. A caption that moved reads exactly like
      // a menu that never opened, and the two have nothing in common.
      const offered = await this.menuCaptions();
      if (isNebula) await dismissMenus(this.d);
      throw new Error(`${(err as Error).message}\nthe menu offered: ${offered}`);
    }
    for (const candidate of await this.d.findElements(selector)) {
      if (await candidate.isDisplayed()) {
        await candidate.click();
        return;
      }
    }
    // Never leave the context menu behind: its backdrop would take every later
    // click in the file, and the next test would fail naming the composer.
    if (isNebula) await dismissMenus(this.d);
    throw new Error(`no visible Pin/Unpin button for message "${messageText}"`);
  }

  /**
   * Open the pinned-message panel.
   *
   * Standard files it under the channel kebab; Nebula gives pins a button of
   * their own in the header, so there is no menu to open first.
   */
  async openPinnedMessages(): Promise<void> {
    if (isNebula) {
      const pins = await this.d.wait(
        until.elementLocated(By.css('button[aria-label^="Pinned"]')),
        10000,
      );
      await pins.click();
      return;
    }
    const menu = await this.d.wait(until.elementLocated(byTid(TID.chatHeaderKebab)), 10000);
    await menu.click();
    await this.d.wait(
      until.elementLocated(By.xpath("//*[@id='pinned-messages' or normalize-space(.)='Pinned messages']")),
      5000,
    ).then((el) => el.click());
  }

  /** Every caption currently on screen in a menu, for a failure to quote. */
  private async menuCaptions(): Promise<string> {
    const items = await this.d.executeScript<string>(`
      return [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => (e.textContent || "").trim())
        .filter(Boolean)
        .join(" | ");
    `);
    return items || "(no menu was open)";
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
      `expected exactly ${count} sender labels for "${sender}"`,
    );
  }

  /**
   * How many times `token` is rendered on the page.
   *
   * For "delivered exactly once". Counting sender labels cannot answer that:
   * `chat-message-sender` is emitted only for the **first message of a
   * consecutive same-sender group** - the client's own `testids.ts` says so,
   * and `MessageItem` gates it on `isFirstInGroup`. Eight messages in a row
   * from one person therefore render one label, so a count of them is a count
   * of groups.
   *
   * Counting elements is no better: an XPath `contains()` matches every
   * ancestor too, so one message inflates to its whole chain. Occurrences in
   * the rendered text are what "exactly once" actually means.
   */
  async textOccurrences(token: string): Promise<number> {
    return await this.d.executeScript<number>(
      `const [token] = arguments;
       const text = document.body.innerText || "";
       let count = 0;
       let at = text.indexOf(token);
       while (at !== -1) { count += 1; at = text.indexOf(token, at + token.length); }
       return count;`,
      token,
    );
  }

  /** Wait until `token` is rendered exactly once. */
  async waitForExactlyOnce(token: string, timeout = 20000): Promise<void> {
    let seen = -1;
    await this.d.wait(
      async () => {
        seen = await this.textOccurrences(token);
        return seen === 1;
      },
      timeout,
      `expected "${token}" to be rendered exactly once`,
    );
  }

  /** Wait until some element on the page renders `text` (message delivered). */
  async waitForText(text: string, timeout = config.waitTimeout): Promise<void> {
    // A newline in the needle can never match, whichever way the client renders
    // it. `MarkdownInput` turns "\n" into `<br>`, and XPath's `string()`
    // contributes *nothing* for an element - so "a\nb" is in the DOM as "ab",
    // while the raw needle asks for "a\nb" and a whitespace-collapsed one asks
    // for "a b". Both fail on a message that arrived perfectly.
    //
    // So match each line independently on the same element. That holds whether
    // the newline became a `<br>` (no separator) or survived under
    // `white-space: pre-wrap` (a real newline), and it still proves every line
    // arrived and landed together.
    const lines = text
      .split("\n")
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter((line) => line.length > 0);
    const conditions = (lines.length > 0 ? lines : [""])
      .map((line) => `contains(normalize-space(string(.)), ${xpathLiteral(line)})`)
      .join(" and ");
    const target = By.xpath(`//*[${conditions}]`);
    // Polled rather than `until.elementLocated`, to survive a DOM that changes
    // while it is being searched. A large message re-renders the transcript
    // under the driver's own traversal and WebKitWebDriver aborts the *find*
    // with "Stale element found when trying to create the node handle" - not a
    // reference we held going stale, so no amount of re-locating on our side
    // helps. It is transient by nature: the next pass walks the settled tree.
    await this.d.wait(
      async () => {
        try {
          return (await this.d.findElements(target)).length > 0;
        } catch (e) {
          if (e instanceof error.StaleElementReferenceError) return false;
          throw e;
        }
      },
      timeout,
      `text never appeared: ${text.slice(0, 60)}`,
    );
  }

  /** Wait for the read-receipt state rendered on a message bubble. */
  async waitForReadReceipt(messageText: string, expectedTitle = "Read"): Promise<void> {
    const message = By.xpath(
      `//*[@data-msg-id][contains(normalize-space(.), ${xpathLiteral(messageText)})]`,
    );
    await this.d.wait(until.elementLocated(message), config.waitTimeout);
    await this.d.wait(
      until.elementLocated(
        By.xpath(`//*[@data-msg-id][contains(normalize-space(.), ${xpathLiteral(messageText)})]` +
          `//*[@aria-label=${xpathLiteral(expectedTitle)} or starts-with(@title, ${xpathLiteral(expectedTitle)})]`),
      ),
      config.waitTimeout,
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
  async approveKeyShares(maxWaitMs = config.waitTimeout): Promise<number> {
    // Two clicks per approval, because the client asks twice. A peer's
    // request first surfaces as a banner in the chat view ("<peer> joined and
    // needs the encryption key" - `buildKeyShareBanner`), whose "Share Key"
    // opens `KeyShareWarningDialog`; the dialog's own "Share Key" is what
    // actually shares. Both buttons carry the same caption, and only the
    // second sits under a `role="dialog"`, so matching the dialog alone waited
    // out the whole budget on a prompt that was on screen the entire time,
    // one click away.
    // The banner lives in the chat area, so an open drawer's backdrop sits on
    // top of it: the click is intercepted, and polling never sees the prompt it
    // is already looking straight at.
    await ensureSidebarClosed(this.d);
    const dialogConfirm = By.xpath("//*[@role='dialog']//button[normalize-space(.)='Share Key']");
    const bannerOffer = By.xpath(
      "//button[normalize-space(.)='Share Key'][not(ancestor::*[@role='dialog'])]",
    );
    let approved = 0;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const [confirm] = await this.d.findElements(dialogConfirm);
      if (confirm) {
        try {
          await confirm.click();
          approved++;
          await delay(700);
          continue;
        } catch {
          /* dialog re-rendered; re-poll */
        }
      }
      const [offer] = await this.d.findElements(bannerOffer);
      if (offer) {
        try {
          await offer.click();
          await delay(400); // the dialog mounts; the next pass confirms it
          continue;
        } catch {
          // Re-close and retry rather than swallowing: an intercepted banner
          // click looks identical to "no prompt yet" from here, and that cost
          // a whole debugging session once.
          await ensureSidebarClosed(this.d);
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
      config.waitTimeout,
    );
    // Hovering reveals the per-message action bar and right-click opens the
    // context menu; both expose the same quick-reaction emoji buttons (and the
    // action bar's copy is always in the DOM but hidden).
    await this.d.actions().move({ origin: wrapper }).perform();
    await this.d.actions().contextClick(wrapper).perform();
    await delay(500);

    // The context menu's copy first, and it is not a preference: the menu
    // renders a full-screen overlay under itself (MessageContextMenu.tsx), so
    // the action bar's copy is visible, hit-testable, and *behind* it. Clicking
    // that one is an ElementClickInterceptedError several frames from anything
    // to do with reactions, which is how this read as a server failure.
    const inMenu = `//button[normalize-space(.)=${xpathLiteral(emoji)}]` +
      `[not(ancestor::*[@data-action-bar])]`;
    const anywhere = `//button[normalize-space(.)=${xpathLiteral(emoji)}]`;
    for (const xpath of [inMenu, anywhere]) {
      for (const btn of await this.d.findElements(By.xpath(xpath))) {
        if (!(await btn.isDisplayed())) continue;
        try {
          await btn.click();
          return;
        } catch {
          // Intercepted or gone stale: try the next candidate rather than
          // failing on the first one the overlay happens to cover.
        }
      }
    }
    throw new Error(`No clickable '${emoji}' quick-reaction button after opening message actions`);
  }

  /** Wait for a reaction pill to appear (its aria-label starts with the emoji). */
  async waitForReaction(emoji: string, timeout = config.waitTimeout): Promise<void> {
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
   * presence of the `img` *is* the assertion - and it is a stronger one than a
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
   * Whether a member is currently shown as registered.
   *
   * The immediate counterpart to {@link waitForRegistered}: that one proves a
   * registration *arrived*, this one proves one has *not* - which needs an
   * answer now rather than a wait, since waiting for an absence only ever
   * reports the timeout.
   */
  async isRegistered(name: string): Promise<boolean> {
    await this.ensureMembersTab();
    const found = await this.d.findElements(this.memberRow(name, `[${MEMBER_REGISTERED_ATTR}="true"]`));
    return found.length > 0;
  }

  async waitForRegistered(name: string, timeout = 20000): Promise<void> {
    await this.ensureMembersTab();
    await this.d.wait(
      until.elementLocated(this.memberRow(name, `[${MEMBER_REGISTERED_ATTR}="true"]`)),
      timeout,
      `"${name}" never showed as registered`,
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
    if (isNebula) return openMemberPanel(this.d);
    await this.selectMembersTab();
    await this.d.wait(until.elementLocated(byTid(TID.memberList)), config.waitTimeout);
  }

  /** Activate the Members tab without requiring the member list to mount. */
  private async selectMembersTab(): Promise<void> {
    if (isNebula) return openMemberPanel(this.d);
    // Gate on aria-selected, not on DOM presence of the member list: once
    // mounted the pane stays in the DOM (display:none) while the Channels tab
    // is active, so its rows would be located but not interactable.
    await selectTab(this.d, "Members");
  }

  /**
   * Put the local user into the self-muted state. The mute control cycles
   * inactive -> active -> muted, and a fresh connection starts inactive, so the
   * first click only activates voice; a second click mutes.
   */
  async selfMute(): Promise<void> {
    await this.clickSidebarTid(TID.toggleMute);
    await delay(400);
    await this.clickSidebarTid(TID.toggleMute);
  }

  /** Toggle the local user's self-deafen via the sidebar voice control. */
  async selfDeafen(): Promise<void> {
    await this.clickSidebarTid(TID.toggleDeafen);
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
    await this.clickSidebarTid(TID.toggleMute);
  }

  /** Single click of the deafen control. */
  async tapDeafen(): Promise<void> {
    await this.clickSidebarTid(TID.toggleDeafen);
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
    await this.ensureMembersTab();
    const el = await this.d.wait(
      until.elementLocated(By.css(`[data-testid="${TID.memberItem}"][data-clickable="true"]`)),
      10000,
    );
    return readVoiceFlags(el);
  }

  /** Read a peer's voice flags as shown to this client in the Members tab. */
  async peerVoiceFlags(name: string): Promise<VoiceFlags> {
    await this.ensureMembersTab();
    const el = await this.d.wait(until.elementLocated(this.memberRow(name)), config.waitTimeout);
    return readVoiceFlags(el);
  }

  /** Wait until the peer's row reflects the expected voice flags (or throw). */
  async waitForPeerVoice(name: string, expected: VoiceFlags, timeout = config.waitTimeout): Promise<void> {
    await this.ensureMembersTab();
    const row = this.memberRow(name);
    await this.d.wait(async () => {
      const els = await this.d.findElements(row);
      if (els.length === 0) return false;
      const f = await readVoiceFlags(els[0]);
      return f.muted === expected.muted && f.deaf === expected.deaf;
    }, timeout);
  }

  /**
   * End the session with the server (returns to the connect screen).
   *
   * Standard puts a Disconnect button in the channel sidebar and acts on the
   * click. Nebula files it in the self dock's overflow menu and asks first, so
   * the confirmation is answered here - a caller that wanted to leave has
   * already decided.
   */
  async disconnect(): Promise<void> {
    // Another ChannelSidebar control, so it is behind the drawer on a narrow
    // window exactly like the voice toggles.
    await ensureSidebarOpen(this.d);
    if (isNebula) {
      await dismissMenus(this.d);
      const menu = await waitDisplayed(this.d, byTid(TID.selfDockMenu), config.waitTimeout);
      await clickWhenFree(menu);
    }
    const btn = await this.d.wait(until.elementLocated(byTid(TID.disconnectServer)), 10000);
    await clickPossiblyHidden(this.d, btn);
    if (!isNebula) return;
    const confirm = await this.d.wait(
      until.elementLocated(byTid(TID.disconnectConfirm)),
      config.waitTimeout,
      "nebula's leave-server confirmation never appeared",
    );
    // The dock menu's backdrop is still fading while this dialog's is fading
    // in; a click that lands between the two hits the wrong layer.
    await clickWhenFree(confirm);
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

  /**
   * Click a control that lives inside `ChannelSidebar` - the self voice
   * buttons. Two things break them on a narrow window: the sidebar is a closed
   * drawer, and the desktop voice actions are then hidden outright. See
   * `ensureSidebarOpen` and `clickPossiblyHidden`.
   */
  private async clickSidebarTid(id: string, timeout = config.waitTimeout): Promise<void> {
    await ensureSidebarOpen(this.d, timeout);
    const el = await this.d.wait(until.elementLocated(byTid(id)), timeout);
    await this.d.wait(until.elementIsEnabled(el), timeout);
    await clickPossiblyHidden(this.d, el);
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
