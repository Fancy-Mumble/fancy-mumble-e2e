import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { featureMissing } from "../ui-flavour";

/**
 * Admin "Roles" tab: creating a new role via the multi-step wizard
 * (`/admin/roles/new`).
 *
 * A role used to be created (and persisted) the instant "+ Create role" was
 * clicked - `RolesListPanel.handleCreate` appended the new group to local ACL
 * state via `setAcl` and immediately called `save()` from the same handler.
 * `save` was a `useCallback` closed over the *previous* render's `acl`, so
 * the freshly-added group was silently dropped from what got persisted, and
 * navigating straight to `/admin/role/<name>` landed on a "not found" error.
 *
 * The fix replaces the instant create with a wizard: "+ Create role" now
 * only opens `/admin/roles/new`, which keeps the draft role (and any
 * permission edits) in local state across Display -> Permissions -> Members
 * steps, and only calls the (now-fixed) `save()` when "Create role" is
 * clicked on the final step. Cancel/Back at any point discards the draft.
 */
describe("admin: creating a role via the Roles wizard", { skip: featureMissing("roleWizard") }, () => {
  let admin: TauriApp;
  // Set by "steps through Display -> Permissions -> Members..." below; reused
  // by the last test so it doesn't depend on a specific draft name (the
  // default "new_role" may already be taken by an earlier test/run against
  // this shared server fixture).
  let createdRoleName = "";

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();
  });

  after(async () => {
    await admin?.close();
  });

  it("does not persist a role when the wizard is cancelled", async () => {
    await admin.admin.open();
    await admin.admin.openRolesTab();
    await admin.admin.clickCreateRole();
    await admin.admin.waitForWizardReady();

    const draftName = await admin.admin.roleNameInputValue();
    assert.ok(draftName.length > 0, "wizard never showed a draft role name");

    await admin.admin.wizardClickCancel();

    // Cancel must land back on the Roles tab (not e.g. Users) and the
    // cancelled draft must never have been sent to the server.
    assert.match(await admin.driver.getCurrentUrl(), /\/admin\?tab=roles$/);
    assert.equal(
      await admin.admin.hasRoleInList(draftName),
      false,
      `cancelling the wizard still created "${draftName}"`,
    );
  });

  it("steps through Display -> Permissions -> Members and only creates the role on the final step", async () => {
    await admin.admin.open();
    await admin.admin.openRolesTab();
    await admin.admin.clickCreateRole();
    await admin.admin.waitForWizardReady();

    const draftName = await admin.admin.roleNameInputValue();

    // Display (first step): no Prev, has Next.
    assert.equal(await admin.admin.hasRoleInList(draftName), false);

    await admin.admin.wizardClickNext();
    // Permissions (middle step): Prev takes us back to Display.
    await admin.admin.wizardClickPrev();
    assert.equal(
      await admin.admin.roleNameInputValue(),
      draftName,
      "Prev from Permissions didn't return to the Display step with the draft intact",
    );

    await admin.admin.wizardClickNext(); // -> Permissions
    await admin.admin.wizardClickNext(); // -> Members (final step)

    // Still nothing persisted until the final-step "Create role" click.
    assert.equal(
      await admin.admin.hasRoleInList(draftName),
      false,
      "role was persisted before the final step's Create button was clicked",
    );

    await admin.admin.wizardClickCreate();

    const outcome = await admin.admin.waitForRoleEditorSettled();
    assert.equal(outcome, "found", `role editor showed "not found" for "${draftName}" after Create`);
    assert.equal(await admin.admin.roleNameInputValue(), draftName);

    // Create lands on the new role's editor, whose tabs are the role's own
    // (Display/Permissions/Members) - the admin tab strip isn't there, so the
    // way back to the list is Back, which must land on Roles rather than Users.
    await admin.admin.clickTopBack();
    await admin.admin.waitForRoleInList(draftName);
    createdRoleName = draftName;
  });

  it("the wizard's top Back button returns to the Roles tab, not Users", async () => {
    await admin.admin.open();
    await admin.admin.openRolesTab();
    await admin.admin.clickCreateRole();
    await admin.admin.waitForWizardReady();

    await admin.admin.clickTopBack();

    assert.match(await admin.driver.getCurrentUrl(), /\/admin\?tab=roles$/);
  });

  it("the role editor's top Back button returns to the Roles tab, not Users", async () => {
    assert.ok(createdRoleName.length > 0, "no role was created by the earlier wizard test to edit here");
    await admin.admin.open();
    await admin.admin.openRolesTab();
    const row = await admin.admin.waitForRoleInList(createdRoleName);
    await row.click();

    await admin.admin.clickTopBack();

    assert.match(await admin.driver.getCurrentUrl(), /\/admin\?tab=roles$/);
  });
});
