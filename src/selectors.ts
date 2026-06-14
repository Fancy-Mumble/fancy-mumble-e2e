import { By } from "selenium-webdriver";

// Import the *exact* test-id registry shipped with the client UI so selectors
// can never drift from the markup. The client lives here as the `vendor/client`
// git submodule; this import resolves into that submodule.
//
// NOTE: the registry only exists on the client's `feature/e2e-testability`
// commit that this submodule is pinned to. If this import fails, run
// `git submodule update --init --recursive`.
import {
  TID,
  MEMBER_NAME_ATTR,
  SERVER_ID_ATTR,
  CALENDAR_EVENT_TITLE_ATTR,
  CALENDAR_VIEW_ATTR,
} from "../vendor/client/crates/mumble-tauri/ui/src/testids";

/** `By.css` locator for an element carrying the given `data-testid`. */
export const byTid = (id: string): By => By.css(`[data-testid="${id}"]`);

export { TID, MEMBER_NAME_ATTR, SERVER_ID_ATTR, CALENDAR_EVENT_TITLE_ATTR, CALENDAR_VIEW_ATTR };
