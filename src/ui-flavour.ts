import { config } from "./config";
import type { Gate } from "./util/preconditions";

/**
 * The client's UI design packs, as far as this suite is concerned.
 *
 * The client ships three (`ui/registry.ts`): standard, nebula and aurora. Only
 * the first two are named here - aurora carries no test ids at all, so a suite
 * pointed at it would not fail on an assertion, it would wait out every
 * element it will never see. Naming it would promise a coverage that does not
 * exist.
 */
const UI_FLAVOURS = ["standard", "nebula"] as const;
type UiFlavour = (typeof UI_FLAVOURS)[number];

function resolveFlavour(): UiFlavour {
  const requested = config.uiDesign;
  if ((UI_FLAVOURS as readonly string[]).includes(requested)) return requested as UiFlavour;
  throw new Error(
    `E2E_UI_DESIGN=${requested} is not a design pack this suite drives ` +
      `(expected one of: ${UI_FLAVOURS.join(", ")}).`,
  );
}

/**
 * The pack this run drives, from `E2E_UI_DESIGN` (default `standard`).
 *
 * `app.ts` passes it to the client as the `?ui=` launch override, which beats
 * the stored preference - so every client this run launches renders the pack
 * named here, whatever a fresh profile would otherwise default to.
 */
const uiFlavour: UiFlavour = resolveFlavour();

/**
 * What the page objects branch on.
 *
 * A boolean rather than a table of variants: the packs differ in a handful of
 * flows, not in most of them, and the branches read better beside the code
 * they qualify than gathered somewhere else. Where a *value* differs, it is
 * looked up instead - see {@link menuLabel}.
 */
export const isNebula = uiFlavour === "nebula";

/**
 * Features a design pack either has or does not have.
 *
 * These are *client* gaps, not harness ones: nebula ships no calendar, no
 * scheduled-message panel, no forum and no role wizard, so the suites that
 * drive them have nothing to drive. Gating them here makes that a one-line
 * skip with a reason rather than 20 timed-out waits, and the matrix is the
 * one place to look when a pack grows a feature.
 */
const FEATURES = [
  "calendar",
  "scheduledMessages",
  "forums",
  "roleWizard",
] as const;
export type Feature = (typeof FEATURES)[number];

const SUPPORTED: Record<UiFlavour, ReadonlySet<Feature>> = {
  standard: new Set<Feature>(FEATURES),
  // Verified 2026-09-05 against the pinned client: `ui/nebula` has no
  // component mentioning any of these, and none of their test ids appear in
  // its markup.
  nebula: new Set<Feature>(),
};

/** Whether the running pack ships `feature`. */
function supports(feature: Feature): boolean {
  return SUPPORTED[uiFlavour].has(feature);
}

/**
 * A skip reason when the running pack ships none of `features`, `false`
 * otherwise - the {@link Gate} shape `describe`'s `skip` option takes, so it
 * composes with the server-side gates in `util/preconditions`:
 *
 *     describe("meetings", { skip: featureMissing("calendar") || bridgeMissing() }, ...)
 *
 * Skipping rather than failing, for the same reason those gates skip: a pack
 * that has not built the feature yet is a known state of the client, and a red
 * run cannot tell that apart from a broken one.
 */
export function featureMissing(...features: Feature[]): Gate {
  const missing = features.filter((feature) => !supports(feature));
  if (missing.length === 0) return false;
  return (
    `the ${uiFlavour} design pack has no ${missing.join(" / ")}, so this suite has ` +
    `nothing to drive. Run it with E2E_UI_DESIGN=standard, or add the feature to ` +
    `the pack and update SUPPORTED in src/ui-flavour.ts.`
  );
}

/**
 * Context-menu captions that differ between the packs.
 *
 * The user and channel context menus carry no test ids in either pack, so the
 * suite has always addressed their items by caption (test mode forces English,
 * which is what makes that deterministic). Nebula words several of them
 * differently - it says where a moderation action takes effect, and where a new
 * channel goes - so the caption is the one thing that has to be looked up
 * rather than hard-coded at the call site.
 */
const MENU = {
  createSubChannel: { standard: "Create Sub-channel", nebula: "New channel here" },
  muteUser: { standard: "Mute", nebula: "Mute on server" },
  deafenUser: { standard: "Deafen", nebula: "Deafen on server" },
  prioritySpeaker: { standard: "Priority speaker", nebula: "Priority speaker" },
  // Opens the confirmation; the dialog's own button says "Register" in both.
  registerUser: { standard: "Register", nebula: "Register on server\u2026" },
  // Nebula names the destination; Standard says only what the verb is. Matched
  // by prefix at the call site, so one entry covers pin and unpin.
  pinMessage: { standard: "Pin", nebula: "Pin to channel" },
  unpinMessage: { standard: "Unpin", nebula: "Unpin from channel" },
} as const satisfies Record<string, Record<UiFlavour, string>>;

/** The running pack's caption for a context-menu action. */
export function menuLabel(action: keyof typeof MENU): string {
  return MENU[action][uiFlavour];
}
