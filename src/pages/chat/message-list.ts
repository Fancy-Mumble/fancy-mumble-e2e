import { By, error, until, type WebDriver } from "selenium-webdriver";
import { TID } from "../../selectors";
import { config } from "../../config";
import { xpathLiteral } from "../../util/xpath";
import { cssAttrEscape } from "../../util/css";
import { isNebula } from "../../ui-flavour";

/**
 * The transcript: Standard's `ChatMessageList.tsx`, Nebula's `MessageList.tsx`,
 * and the `MessageRow`s inside it.
 *
 * Everything here is a *read* of what the transcript is currently rendering -
 * which text arrived, who it is attributed to, how much of it is mounted, and
 * where it is scrolled. Acting on a single message (pin, react) is
 * {@link import("./message-actions").MessageActions}; writing one is
 * {@link import("./composer").ChatComposer}.
 */
export class MessageList {
  constructor(private readonly d: WebDriver) {}

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

  /** Whether `text` is currently rendered anywhere (no waiting). */
  async hasText(text: string): Promise<boolean> {
    const xp = By.xpath(`//*[contains(normalize-space(string(.)), ${xpathLiteral(text)})]`);
    return (await this.d.findElements(xp)).length > 0;
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

  /** Wait until a rendered message is attributed to `sender`. */
  async waitForFrom(sender: string, timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      until.elementLocated(this.senderRow(sender)),
      timeout,
      `no message attributed to "${sender}" appeared`,
    );
  }

  /** Whether any currently rendered message is attributed to `sender`. */
  async hasFrom(sender: string): Promise<boolean> {
    return (await this.d.findElements(this.senderRow(sender))).length > 0;
  }

  /** Count the currently rendered messages attributed to `sender`. */
  async countFrom(sender: string): Promise<number> {
    return (await this.d.findElements(this.senderRow(sender))).length;
  }

  /** Wait until exactly `count` messages from `sender` are rendered. */
  async waitForCountFrom(sender: string, count: number, timeout = 20000): Promise<void> {
    await this.d.wait(
      async () => (await this.countFrom(sender)) === count,
      timeout,
      `expected exactly ${count} sender labels for "${sender}"`,
    );
  }

  /**
   * How many message rows are mounted right now, from any sender.
   *
   * Distinct from {@link countFrom}, which counts sender *labels* and so counts
   * consecutive-sender groups rather than messages. This is the number a
   * windowing assertion needs: how much DOM the chat is actually carrying.
   *
   * The two UI packs disagree about the attribute - Standard emits
   * `data-msg-id` and Nebula `data-message-id` - so both are counted, and a row
   * carrying both is counted once.
   */
  async renderedCount(): Promise<number> {
    return await this.d.executeScript<number>(
      `return new Set(
         [...document.querySelectorAll("[data-msg-id],[data-message-id]")]
       ).size;`,
    );
  }

  /** Where the transcript is scrolled, or `null` if nothing is scrollable. */
  async scrollPosition(): Promise<{ top: number; height: number; client: number } | null> {
    return await this.d.executeScript(
      MessageList.scrollerScript(
        `return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };`,
      ),
    );
  }

  /**
   * Scroll the transcript to `to`, in pixels or by keyword.
   *
   * Returns the resulting position so a caller can assert on movement rather
   * than assume it: a scroller that refuses to move is the failure mode a
   * paging test is most likely to hit, and a silent no-op looks like a pass.
   */
  async scrollTo(to: number | "top" | "bottom"): Promise<number> {
    const target =
      to === "top" ? "0" : to === "bottom" ? "el.scrollHeight" : String(Math.round(to));
    const top = await this.d.executeScript<number | null>(
      MessageList.scrollerScript(`el.scrollTop = ${target}; return el.scrollTop;`),
    );
    if (top === null) throw new Error("no scrollable transcript was found");
    return top;
  }

  /**
   * Scroll to the top and wait until more history has been mounted.
   *
   * The two-step is deliberate. A page arriving above the reader must not move
   * what they are reading, so the client pays the height difference back into
   * `scrollTop` in the same frame - which means "did a page arrive" cannot be
   * answered by watching the scroll position. The row count is what changes.
   */
  async loadOlder(timeout = 20000): Promise<number> {
    const before = await this.renderedCount();
    await this.scrollTo("top");
    let seen = before;
    await this.d.wait(
      async () => {
        seen = await this.renderedCount();
        return seen > before;
      },
      timeout,
      `expected more than ${before} rows after scrolling to the top`,
    );
    return seen;
  }

  /** Wait until no more than `max` message rows are mounted. */
  async waitForRenderedAtMost(max: number, timeout = 20000): Promise<void> {
    let seen = -1;
    await this.d.wait(
      async () => {
        seen = await this.renderedCount();
        return seen <= max;
      },
      timeout,
      `expected at most ${max} rendered rows, still seeing ${seen}`,
    );
  }

  /**
   * Wait for the read-receipt state rendered on a message bubble
   * (`ReadReceiptIndicator` / `readreceipt/`, which draws inside the row).
   */
  async waitForReadReceipt(messageText: string, expectedTitle = "Read"): Promise<void> {
    const message = MessageList.rowByText(messageText);
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

  /**
   * The row carrying `messageText`, addressed the way a per-message gesture
   * needs it: by `data-msg-id`, which is what wires the context menu.
   *
   * Shared with {@link import("./message-actions").MessageActions} so the pin
   * and reaction paths cannot drift apart on how a message is found.
   */
  static rowByText(messageText: string): By {
    return By.xpath(
      `//*[@data-msg-id][contains(normalize-space(.), ${xpathLiteral(messageText)})]`,
    );
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

  /**
   * The element that actually scrolls the transcript.
   *
   * Found rather than named: neither pack gives the scroller a test id, and its
   * depth differs between them. The rule is the one the media-scroll probe
   * arrived at - walk up from a message row to the first ancestor that both
   * overflows and is allowed to scroll.
   */
  private static scrollerScript(body: string): string {
    return `const row = document.querySelector("[data-msg-id],[data-message-id]");
            if (!row) return null;
            let el = row.parentElement;
            while (el) {
              const oy = getComputedStyle(el).overflowY;
              if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(oy)) break;
              el = el.parentElement;
            }
            if (!el) return null;
            ${body}`;
  }
}
