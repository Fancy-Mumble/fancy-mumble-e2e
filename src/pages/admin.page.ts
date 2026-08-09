import { By, until, type WebDriver } from "selenium-webdriver";
import { TID, byTid } from "../selectors";
import { config } from "../config";

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

  /**
   * Switch to the "Channels / ACL" tab, and confirm it took.
   *
   * Same shape as {@link openRolesTab}, for the same reason: under load a
   * single click can be swallowed by a re-render, and the failure then lands
   * one wait later as "channel row never appeared" — a message about the tree,
   * for a tab that never opened. Confirmed by the pane's own content (the ACL
   * tree always renders at least the root channel row).
   */
  async openAclTab(): Promise<void> {
    const onAcl = async () =>
      (await this.d.findElements(By.css(`[data-testid="${TID.aclChannelItem}"]`))).length > 0;
    await this.d.wait(
      async () => {
        if (await onAcl()) return true;
        const [tab] = await this.d.findElements(
          By.xpath("//button[contains(normalize-space(.), 'Channels / ACL')]"),
        );
        if (!tab) return false;
        try {
          await tab.click();
        } catch {
          return false; // re-render mid-click; the next pass re-finds it
        }
        return onAcl();
      },
      config.waitTimeout,
      "the Channels / ACL tab never showed its channel tree",
    );
  }

  /**
   * Switch to the "Roles" tab, and confirm it took.
   *
   * A single unverified click was the flake here: under load the click can be
   * swallowed by a re-render, the panel stays on Users, and the failure lands
   * 15 s later in `waitForWizardReady` as "the wizard never rendered its name
   * field" - a message about the wizard, for a tab that never opened.
   *
   * Confirmed by the pane's own content, because the two obvious signals are
   * not available: these tab buttons carry no `aria-selected`, and the URL
   * stays `/admin` until a *back* navigation adds `?tab=roles`. The create
   * button is what the caller needs next anyway, so waiting for it is both the
   * check and the precondition.
   */
  async openRolesTab(): Promise<void> {
    const onRoles = async () =>
      (await this.d.findElements(byTid(TID.rolesCreateButton))).length > 0;
    await this.d.wait(
      async () => {
        if (await onRoles()) return true;
        const [tab] = await this.d.findElements(By.xpath("//button[normalize-space(.)='Roles']"));
        if (!tab) return false;
        try {
          await tab.click();
        } catch {
          return false; // re-render mid-click; the next pass re-finds it
        }
        return onRoles();
      },
      config.waitTimeout,
      "the Roles tab never showed its create button",
    );
  }

  /** Click "+ Create role" on the Roles tab (must already be open). */
  async clickCreateRole(): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(byTid(TID.rolesCreateButton)),
      10000,
    );
    await btn.click();
  }

  /**
   * Wait for the role editor (`/admin/role/:name`) to settle on either
   * outcome: its Display sub-tab's name field ("found"), or the "Role
   * {{name}} not found." placeholder ("not-found").
   */
  async waitForRoleEditorSettled(timeout = 10000): Promise<"found" | "not-found"> {
    await this.d.wait(async () => {
      const found = await this.d.findElements(byTid(TID.roleNameInput));
      const notFound = await this.d.findElements(byTid(TID.roleEditorNotFound));
      return found.length > 0 || notFound.length > 0;
    }, timeout, "role editor never settled (neither the name field nor the 'not found' message appeared)");
    const notFound = await this.d.findElements(byTid(TID.roleEditorNotFound));
    return notFound.length > 0 ? "not-found" : "found";
  }

  /**
   * Wait until the new-role wizard has seeded its draft and rendered the
   * Display step's name field. The wizard can only pick the draft name once
   * the root ACL arrives, so the field is absent for a beat after the click -
   * reading it without waiting is a race.
   */
  async waitForWizardReady(timeout = config.waitTimeout): Promise<void> {
    await this.d.wait(
      until.elementLocated(byTid(TID.roleNameInput)),
      timeout,
      "new-role wizard never rendered its name field",
    );
  }

  /** Current value of the role editor's Display-tab name field. */
  async roleNameInputValue(): Promise<string> {
    const input = await this.d.findElement(byTid(TID.roleNameInput));
    return (await input.getAttribute("value")) ?? "";
  }

  private byRoleListRow(name: string): By {
    return By.css(
      `[data-testid="${TID.roleListRow}"][data-role-name="${cssAttrEscape(name)}"]`,
    );
  }

  /** Whether a role row named `name` is currently present on the Roles tab list. */
  async hasRoleInList(name: string): Promise<boolean> {
    return (await this.d.findElements(this.byRoleListRow(name))).length > 0;
  }

  /** Wait until the Roles tab list contains a role row named `name`. */
  async waitForRoleInList(name: string, timeout = 10000) {
    return this.d.wait(until.elementLocated(this.byRoleListRow(name)), timeout);
  }

  // -- New-role wizard (`/admin/roles/new`) --------------------------------

  /** Click the wizard's "Next" step button. */
  async wizardClickNext(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.roleWizardNext)), 10000);
    await btn.click();
  }

  /** Click the wizard's "Previous" step button. */
  async wizardClickPrev(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.roleWizardPrev)), 10000);
    await btn.click();
  }

  /** Click the wizard's final-step "Create role" button (persists the draft). */
  async wizardClickCreate(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.roleWizardCreate)), 10000);
    await btn.click();
  }

  /** Click the wizard's "Cancel" button (discards the draft). */
  async wizardClickCancel(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.roleWizardCancel)), 10000);
    await btn.click();
  }

  /**
   * Click the top chevron "Go back" button shared by every `TabbedPage`
   * (Settings, Admin, the role editor, the new-role wizard). Only one such
   * page is ever on screen at a time, so the aria-label alone is unambiguous.
   */
  async clickTopBack(): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(By.css('[aria-label="Go back"]')),
      10000,
    );
    await btn.click();
  }

  private byAclChannel(name: string): By {
    return By.css(
      `[data-testid="${TID.aclChannelItem}"][data-channel-name="${cssAttrEscape(name)}"]`,
    );
  }

  /** Wait until the ACL tree contains a channel row named `name`. */
  async waitForAclChannel(name: string, timeout = config.waitTimeout) {
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
  async waitForAclChannelGone(name: string, timeout = config.waitTimeout): Promise<void> {
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
