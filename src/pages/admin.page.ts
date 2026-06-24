import { By, until, type WebDriver } from "selenium-webdriver";
import { TID } from "../selectors";

/**
 * Page object for the admin panel (`/admin`), focused on the "Channels / ACL"
 * tab: its channel tree now lists detached/private channels too, and supports
 * deleting a channel from a right-click context menu.
 */
export class AdminPage {
  constructor(private readonly d: WebDriver) {}

  /** Open the admin panel via the shield button in the channel sidebar. */
  async open(): Promise<void> {
    // The admin button lives in the channel sidebar (main chat view). If we're on
    // another page (e.g. Friends, which swaps in its own sidebar), click the
    // active server tab in the left rail to return to the server view first.
    const tabs = await this.d.findElements(By.css('[role="tab"][aria-selected="true"]'));
    if (tabs.length > 0) {
      await tabs[0].click();
      await this.d.sleep(400);
    }
    const btn = await this.d.wait(
      until.elementLocated(By.css('[aria-label="Admin panel"]')),
      10000,
    );
    await btn.click();
  }

  /** Switch to the "Channels / ACL" tab (matched by its unique label). */
  async openAclTab(): Promise<void> {
    const tab = await this.d.wait(
      until.elementLocated(By.xpath("//button[contains(normalize-space(.), 'Channels / ACL')]")),
      10000,
    );
    await tab.click();
  }

  private byAclChannel(name: string): By {
    return By.css(
      `[data-testid="${TID.aclChannelItem}"][data-channel-name="${cssAttrEscape(name)}"]`,
    );
  }

  /** Wait until the ACL tree contains a channel row named `name`. */
  async waitForAclChannel(name: string, timeout = 15000) {
    return this.d.wait(until.elementLocated(this.byAclChannel(name)), timeout);
  }

  /** Whether an ACL tree row named `name` is currently present. */
  async hasAclChannel(name: string): Promise<boolean> {
    return (await this.d.findElements(this.byAclChannel(name))).length > 0;
  }

  /** Right-click the channel row `name`, then delete it (confirming). */
  async deleteAclChannel(name: string): Promise<void> {
    const row = await this.waitForAclChannel(name);
    await this.d.actions().contextClick(row).perform();
    const del = await this.d.wait(
      until.elementLocated(By.css(`[data-testid="${TID.aclDeleteChannel}"]`)),
      8000,
    );
    await del.click();
    const confirm = await this.d.wait(
      until.elementLocated(By.css(`[data-testid="${TID.aclDeleteConfirm}"]`)),
      8000,
    );
    await confirm.click();
  }

  /** Wait until the channel row `name` is gone from the ACL tree. */
  async waitForAclChannelGone(name: string, timeout = 15000): Promise<void> {
    await this.d.wait(
      async () => (await this.d.findElements(this.byAclChannel(name))).length === 0,
      timeout,
      `ACL channel "${name}" never disappeared from the tree`,
    );
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
