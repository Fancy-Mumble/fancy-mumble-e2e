import { By, until, type WebDriver } from "selenium-webdriver";
import { TID } from "../selectors";
import { config } from "../config";

/**
 * Page object for the Friends page (`/friends`, FriendsPage.tsx). A friend's
 * online state is resolved by the backend via the user's TLS cert hash over the
 * live user list (`find_user_by_hash`), so it reflects presence independently of
 * which channel the friend is in - in particular it stays "online" for a friend
 * sitting in a hidden channel the viewer cannot see.
 */
export class FriendsPage {
  constructor(private readonly d: WebDriver) {}

  /** Navigate to the Friends page via the left server-tabs Friends button. */
  async open(): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(By.css('[aria-label="Friends"]')),
      10000,
    );
    await btn.click();
    // The list may be momentarily empty while online state resolves; just wait
    // for the page to mount (a friend row, or the empty-state, will follow).
    await this.d.sleep(300);
  }

  /**
   * Open a friend's chat by clicking their row (waits for it to appear first).
   * Also opens the self-chat: "yourself" is listed as a friend under your own
   * name, so `clickFriend(ownName)` opens your private E2E self-chat.
   */
  async clickFriend(name: string): Promise<void> {
    const row = await this.d.wait(until.elementLocated(this.byFriend(name)), config.waitTimeout);
    await row.click();
  }

  private byFriend(name: string): By {
    return By.css(`[data-testid="${TID.friendRow}"][data-friend-name="${cssAttrEscape(name)}"]`);
  }

  /** Whether the friend `name` is currently listed (regardless of online state). */
  async hasFriend(name: string): Promise<boolean> {
    return (await this.d.findElements(this.byFriend(name))).length > 0;
  }

  /**
   * Wait until friend `name` is shown ONLINE (`data-online="true"`). The dot is
   * green only once `find_user_by_hash` resolves them on a connected server.
   */
  async waitForFriendOnline(name: string, timeout = 20000): Promise<void> {
    await this.d.wait(
      async () => {
        const els = await this.d.findElements(this.byFriend(name));
        if (els.length === 0) return false;
        return (await els[0].getAttribute("data-online").catch(() => null)) === "true";
      },
      timeout,
      `friend "${name}" never showed as online on the Friends page`,
    );
  }

  /**
   * Wait until friend `name` is shown OFFLINE (`data-online="false"`). Online
   * state is re-resolved on a slow interval, so allow a generous timeout after
   * the friend actually disconnects.
   */
  async waitForFriendOffline(name: string, timeout = 30000): Promise<void> {
    await this.d.wait(
      async () => {
        const els = await this.d.findElements(this.byFriend(name));
        if (els.length === 0) return false;
        return (await els[0].getAttribute("data-online").catch(() => null)) === "false";
      },
      timeout,
      `friend "${name}" never showed as offline on the Friends page`,
    );
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
