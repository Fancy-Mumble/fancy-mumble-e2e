import { By, Key, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { TID, byTid, TAB_ID_ATTR } from "../selectors";
import { config } from "../config";
import { isNebula } from "../ui-flavour";
import { clickWhenFree, dismissMenus, goToChat, waitDisplayed } from "../util/nebula";
import { ensureSidebarOpen, ensureSidebarClosed } from "../util/layout";

/**
 * The admin surface's page ids, shared by both packs (`ADMIN_PAGES` in
 * nebula's `components/admin/capabilities.ts`, the `tabs` array in standard's
 * `pages/admin/index.tsx`). Each is gated on its own permission, so which of
 * them an account sees varies - what does not vary is that seeing any of them
 * means the administration navigation is up.
 */
const ADMIN_PAGE_IDS = [
  "users",
  "roles",
  "bans",
  "acl",
  "emotes",
  "onboarding",
  "serverPlugins",
  "marketplace",
  "fileServer",
  "serverSettings",
  "livery",
  "welcome",
  "auditLog",
] as const;

/**
 * Page object for the admin panel (`/admin`), focused on the "Channels / ACL"
 * tab: its channel tree now lists detached/private channels too, and supports
 * deleting a channel from a right-click context menu.
 */
export class AdminPage {
  constructor(private readonly d: WebDriver) {}

  /**
   * Open the administration surface.
   *
   * Standard has a shield button beside the self voice controls that opens a
   * panel of its own; Nebula files administration inside settings, behind the
   * self dock's overflow menu. Both land on the same navigation.
   */
  async open(): Promise<void> {
    if (isNebula) return this.openNebula();
    // The admin button lives in the channel sidebar (main chat view). If we're on
    // another page (e.g. Friends, which swaps in its own sidebar), click the
    // active server tab in the left rail to return to the server view first.
    // The rail sits outside the sidebar, so an open drawer's backdrop takes
    // this click; the admin button below sits inside it and needs the
    // opposite. On a wide window both calls are no-ops.
    await ensureSidebarClosed(this.d);
    const tabs = await this.d.findElements(By.css('[role="tab"][aria-selected="true"]'));
    if (tabs.length > 0) {
      await tabs[0].click();
      await this.d.sleep(400);
    }
    await ensureSidebarOpen(this.d);
    const btn = await this.d.wait(until.elementLocated(byTid(TID.adminPanel)), 10000);
    await btn.click();
  }

  /**
   * Nebula's route in: administration is a section of the settings screen, and
   * the only door to it is the self dock's overflow menu. So this has to be on
   * the chat screen first - the dock is drawn beneath the channel column, and
   * neither is there while the connect or settings screen is up.
   */
  private async openNebula(): Promise<void> {
    if ((await this.d.findElements(this.byAdminTab())).length > 0) return;
    await goToChat(this.d);
    await dismissMenus(this.d);
    const menu = await waitDisplayed(this.d, byTid(TID.selfDockMenu), config.waitTimeout);
    await clickWhenFree(menu);
    const admin = await waitDisplayed(
      this.d,
      byTid(TID.adminPanel),
      config.waitTimeout,
      "the self dock's menu offered no server administration (not an admin?)",
    );
    await clickWhenFree(admin);
    await this.d.wait(
      async () => (await this.d.findElements(this.byAdminTab())).length > 0,
      config.waitTimeout,
      "the administration navigation never appeared",
    );
  }

  /**
   * Proof that the *administration* navigation is up, not merely a navigation.
   *
   * Nebula's admin entries share a column with the ordinary settings pages, so
   * "some tab exists" is true on the settings screen either way - it has to be
   * an *admin* page id. Any of them, not one: every entry is gated on its own
   * permission, so an account that can read the audit log but not administer
   * sees only "Audit log". Gating on Users cost the audit suite three tests
   * that way.
   */
  private byAdminTab(): By {
    return By.css(ADMIN_PAGE_IDS.map((id) => `[${TAB_ID_ATTR}="${id}"]`).join(","));
  }

  /**
   * The navigation entry that opens admin page `id` ("acl", "roles",
   * "serverSettings", "auditLog", ...).
   *
   * By the page id rather than by its caption: the two packs word these
   * differently (and shape the navigation differently - Standard has a tab
   * strip, Nebula a section of the settings column), but they agree on the
   * ids, which are also the one part that does not move when a caption is
   * retranslated.
   */
  private byTab(id: string): By {
    return By.css(`[${TAB_ID_ATTR}="${id}"]`);
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
        const [tab] = await this.d.findElements(this.byTab("acl"));
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
        const [tab] = await this.d.findElements(this.byTab("roles"));
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
   * Leave the admin surface for the conversation.
   *
   * Standard's is the chevron every `TabbedPage` carries (Settings, Admin, the
   * role editor, the wizard); Nebula's is the settings column's back link.
   * Only one such control is on screen at a time in either pack.
   */
  async clickTopBack(): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(byTid(TID.adminBack)),
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

  /**
   * Switch to the "Server settings" tab, and confirm it took.
   *
   * Same confirm-the-click shape as {@link openRolesTab}, and confirmed by the
   * one thing the pane always has if it has anything: the Save button. The
   * settings themselves come from the server's own schema, so asserting on any
   * particular field here would tie the page object to a server version.
   *
   * Deliberately **not** confirmed by the tab looking selected. The pane can
   * open and still be empty - which is the whole failure this exists to catch:
   * against Starling the screen showed "Server settings aren't available" for
   * as long as the client had no way to ask for them.
   */
  async openServerSettingsTab(): Promise<void> {
    const onSettings = async () => (await this.d.findElements(this.bySettingsSave())).length > 0;
    await this.d.wait(
      async () => {
        if (await onSettings()) return true;
        const [tab] = await this.d.findElements(this.byTab("serverSettings"));
        if (!tab) return false;
        try {
          await tab.click();
        } catch {
          return false; // re-render mid-click; the next pass re-finds it
        }
        // The snapshot arrives on an event after the query, so the pane opens
        // on "Loading…" and fills in a moment later.
        return onSettings();
      },
      config.waitTimeout,
      "the Server settings tab never showed its save button",
    );
  }

  /** Whether the pane is telling the user there are no settings to show. */
  async serverSettingsUnavailable(): Promise<boolean> {
    const found = await this.d.findElements(
      By.xpath("//*[contains(text(), \"Server settings aren't available\")]"),
    );
    return found.length > 0;
  }

  /** The labels of the settings the server offered, in the order shown. */
  async serverSettingLabels(): Promise<string[]> {
    const fields = await this.d.findElements(By.css("[aria-label]"));
    const labels = await Promise.all(fields.map(async (field) => field.getAttribute("aria-label")));
    return labels.filter((label): label is string => Boolean(label));
  }

  /**
   * Type `value` into the setting whose label is `label`.
   *
   * Two kinds of control answer to a label here. A setting the server calls
   * markup is edited in a WYSIWYG field, which is a `contenteditable` and not
   * an input: `clear()` throws on one, so what stands in for it is selecting
   * what is already there and typing over it.
   */
  async setServerSetting(label: string, value: string): Promise<void> {
    const field = await this.d.wait(until.elementLocated(this.bySettingLabel(label)), 10000);
    if (await isTextInput(field)) {
      await field.clear();
      await field.sendKeys(value);
      return;
    }
    await field.click();
    await this.d.actions().keyDown(Key.CONTROL).sendKeys("a").keyUp(Key.CONTROL).perform();
    await field.sendKeys(value);
  }

  /**
   * What the setting labelled `label` currently reads as.
   *
   * The **text**, not the markup: a rich field holds `<p>hello</p>` for what an
   * operator typed as "hello", so comparing markup would assert on the editor's
   * normalisation rather than on the value.
   */
  async serverSettingValue(label: string): Promise<string> {
    const field = await this.d.wait(until.elementLocated(this.bySettingLabel(label)), 10000);
    if (await isTextInput(field)) return (await field.getAttribute("value")) ?? "";
    return (await field.getText()).trim();
  }

  /** Save the settings, and wait for the server to confirm the round trip. */
  async saveServerSettings(): Promise<void> {
    const save = await this.d.wait(until.elementLocated(this.bySettingsSave()), 10000);
    await save.click();
    // The button disables again once nothing differs from the snapshot the
    // server sent back, which is the only signal that the save round-tripped
    // rather than being accepted and dropped.
    await this.d.wait(
      async () => {
        const [button] = await this.d.findElements(this.bySettingsSave());
        return Boolean(button) && !(await button.isEnabled());
      },
      config.waitTimeout,
      "the server never confirmed the settings save",
    );
  }

  /** One setting's control, found by the label the server gave it. */
  private bySettingLabel(label: string): By {
    return By.css(`[aria-label="${cssAttrEscape(label)}"]`);
  }

  /** The settings pane's save button, whose label carries a pending count. */
  private bySettingsSave(): By {
    return By.xpath("//button[starts-with(normalize-space(.), 'Save changes')]");
  }
}

/** Whether a control carries its value in the `value` attribute. */
async function isTextInput(field: WebElement): Promise<boolean> {
  const tag = (await field.getTagName()).toLowerCase();
  return tag === "input" || tag === "textarea";
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
