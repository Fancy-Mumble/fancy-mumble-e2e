import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID, KEBAB_ITEM_ATTR, FORUM_TOPIC_ATTR, FORUM_THREAD_TITLE_ATTR } from "../selectors";
import { xpathLiteral } from "../util/xpath";
import { config } from "../config";

/**
 * Page object for the per-channel forum split view (ForumsPanel.tsx): the
 * Category -> Topic -> Thread -> Posts board layered on top of the
 * FancyForum* wire messages (server PR "feat/forums-and-scheduled-messages").
 *
 * The board index (default taxonomy) always renders, so `open()` succeeding
 * does NOT prove server support - the first real server round-trip is a
 * thread create (server assigns the post id and broadcasts it back).
 */
export class ForumPage {
  constructor(private readonly d: WebDriver) {}

  /** Open the forum split view via the chat header's kebab menu. */
  async open(): Promise<void> {
    const kebab = await this.d.wait(until.elementLocated(byTid(TID.chatHeaderKebab)), config.waitTimeout);
    await kebab.click();
    const item = await this.d.wait(
      until.elementLocated(By.css(`[data-testid="${TID.kebabMenuItem}"][${KEBAB_ITEM_ATTR}="forums"]`)),
      10000,
    );
    await item.click();
    await this.d.wait(until.elementLocated(byTid(TID.forumPanel)), config.waitTimeout);
  }

  /** Whether the panel is currently mounted. */
  async isOpen(): Promise<boolean> {
    return (await this.d.findElements(byTid(TID.forumPanel))).length > 0;
  }

  /** Click a topic row (e.g. "General Discussion") on the board index. */
  async openTopic(topic: string): Promise<void> {
    const row = await this.d.wait(
      until.elementLocated(By.css(`[data-testid="${TID.forumTopicRow}"][${FORUM_TOPIC_ATTR}="${topic}"]`)),
      config.waitTimeout,
    );
    await row.click();
    await this.d.wait(until.elementLocated(byTid(TID.forumNewThread)), 10000);
  }

  /**
   * Create a thread in the currently open topic. Resolves once the thread row
   * appears in the topic listing - i.e. after the server assigned the post id
   * and broadcast the root post back to this client (the full round-trip).
   */
  async createThread(title: string, body: string): Promise<void> {
    const toggle = await this.d.wait(until.elementLocated(byTid(TID.forumNewThread)), 10000);
    await toggle.click();
    const titleInput = await this.d.wait(until.elementLocated(byTid(TID.forumThreadTitleInput)), 10000);
    await titleInput.sendKeys(title);
    const bodyInput = await this.d.findElement(byTid(TID.forumThreadBodyInput));
    await bodyInput.sendKeys(body);
    const submit = await this.d.findElement(byTid(TID.forumThreadSubmit));
    await this.d.wait(until.elementIsEnabled(submit), 5000);
    await submit.click();
    await this.waitForThread(title);
  }

  /** Locator for a thread row by its decoded display title. */
  private threadRow(title: string): By {
    return By.css(`[data-testid="${TID.forumThreadRow}"][${FORUM_THREAD_TITLE_ATTR}="${title}"]`);
  }

  /** Wait until a thread with `title` is listed in the open topic. */
  async waitForThread(title: string, timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      until.elementLocated(this.threadRow(title)),
      timeout,
      `thread "${title}" never appeared in the topic listing`,
    );
  }

  /** Whether a thread with `title` is currently listed. */
  async hasThread(title: string): Promise<boolean> {
    return (await this.d.findElements(this.threadRow(title))).length > 0;
  }

  /** The reply count shown on a thread's row (`data-reply-count`). */
  async threadReplyCount(title: string): Promise<number> {
    const row = await this.d.wait(until.elementLocated(this.threadRow(title)), 10000);
    return Number(await row.getAttribute("data-reply-count"));
  }

  /**
   * Wait until the thread row's reply count reaches `count`. The count is
   * server-computed on thread listings, so a stale row can linger between
   * requesting a refresh and the fetch response landing - poll, don't read
   * once.
   */
  async waitForThreadReplyCount(title: string, count: number, timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      async () => {
        try {
          return (await this.threadReplyCount(title)) === count;
        } catch {
          return false;
        }
      },
      timeout,
      `thread "${title}" never showed reply count ${count}`,
    );
  }

  /** Open a listed thread and wait for its posts to load. */
  async openThread(title: string): Promise<void> {
    const row = await this.d.wait(until.elementLocated(this.threadRow(title)), config.waitTimeout);
    await row.click();
    await this.d.wait(until.elementLocated(byTid(TID.forumReplyInput)), config.waitTimeout);
    await this.d.wait(until.elementLocated(byTid(TID.forumPost)), config.waitTimeout);
  }

  /**
   * Wait until a post whose text contains `text` is visible in the open
   * thread view (covers both live broadcasts and post-fetch renders).
   */
  async waitForPost(text: string, timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      until.elementLocated(this.postContaining(text)),
      timeout,
      `post containing "${text}" never appeared in the thread view`,
    );
  }

  /** Whether a post containing `text` is currently rendered. */
  async hasPost(text: string): Promise<boolean> {
    return (await this.d.findElements(this.postContaining(text))).length > 0;
  }

  /** Wait until no post containing `text` remains rendered (post deleted). */
  async waitForPostGone(text: string, timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      async () => (await this.d.findElements(this.postContaining(text))).length === 0,
      timeout,
      `post containing "${text}" never disappeared`,
    );
  }

  private postContaining(text: string): By {
    return By.xpath(
      `//*[@data-testid="${TID.forumPost}"][contains(normalize-space(string(.)), ${xpathLiteral(text)})]`,
    );
  }

  /**
   * Click the per-post action button `buttonTid` on the post containing
   * `text`. Located as ONE compound xpath (post -> button) and retried on
   * staleness: live forum broadcasts re-render the post list, which can
   * invalidate a previously located element between lookup and click.
   */
  private async clickPostAction(text: string, buttonTid: string): Promise<void> {
    const sel = By.xpath(
      `//*[@data-testid="${TID.forumPost}"][contains(normalize-space(string(.)), ${xpathLiteral(text)})]` +
        `//button[@data-testid="${buttonTid}"]`,
    );
    const deadline = Date.now() + config.waitTimeout;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const btn = await this.d.wait(until.elementLocated(sel), config.waitTimeout);
        await this.d.wait(until.elementIsVisible(btn), 5000);
        await btn.click();
        return;
      } catch (e) {
        lastErr = e;
        if (e instanceof Error && /stale element/i.test(e.message)) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`clickPostAction(${buttonTid}) kept failing`);
  }

  /** Reply in the open thread. Resolves once the reply is rendered. */
  async reply(body: string): Promise<void> {
    const input = await this.d.wait(until.elementLocated(byTid(TID.forumReplyInput)), 10000);
    await input.click();
    await input.sendKeys(body);
    const submit = await this.d.findElement(byTid(TID.forumReplySubmit));
    await this.d.wait(until.elementIsEnabled(submit), 5000);
    await submit.click();
    await this.waitForPost(body);
  }

  /**
   * Inline-edit the post containing `findText`, replacing its body with
   * `newBody`. Resolves once the edited body is rendered.
   */
  async editPost(findText: string, newBody: string): Promise<void> {
    await this.clickPostAction(findText, TID.forumPostEdit);
    const bodyInput = await this.d.wait(until.elementLocated(byTid(TID.forumEditBodyInput)), 10000);
    await bodyInput.clear();
    await bodyInput.sendKeys(newBody);
    const save = await this.d.findElement(byTid(TID.forumEditSave));
    await this.d.wait(until.elementIsEnabled(save), 5000);
    await save.click();
    await this.waitForPost(newBody);
  }

  /** Delete the post containing `findText` via its per-post delete button. */
  async deletePost(findText: string): Promise<void> {
    await this.clickPostAction(findText, TID.forumPostDelete);
  }

  /** Quote the post containing `findText` into the reply composer. */
  async quotePost(findText: string): Promise<void> {
    await this.clickPostAction(findText, TID.forumPostQuote);
  }

  /** Current text of the reply composer (e.g. after quoting). */
  async replyDraft(): Promise<string> {
    const input = await this.d.wait(until.elementLocated(byTid(TID.forumReplyInput)), 10000);
    return (await input.getAttribute("value")) ?? "";
  }

  /** Type into the in-topic thread search box. */
  async searchThreads(query: string): Promise<void> {
    const input = await this.d.wait(until.elementLocated(byTid(TID.forumSearchInput)), 10000);
    await input.clear();
    await input.sendKeys(query);
  }

  /** Titles of the thread rows currently listed (in display order). */
  async listedThreadTitles(): Promise<string[]> {
    const rows = await this.d.findElements(byTid(TID.forumThreadRow));
    const titles = await Promise.all(rows.map((r) => r.getAttribute(FORUM_THREAD_TITLE_ATTR)));
    return titles.map((t) => t ?? "");
  }

  /** Navigate one level up (thread -> topic -> board index). */
  async back(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.forumBack)), 10000);
    await btn.click();
  }

  /** Re-fetch the board (and the open thread, if any) from the server. */
  async refresh(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.forumRefresh)), 10000);
    await btn.click();
  }
}
