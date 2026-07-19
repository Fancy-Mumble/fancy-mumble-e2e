import { By } from "selenium-webdriver";

// Re-export the *exact* test-id registry shipped with the client UI so selectors
// can never drift from the markup. The client lives here as the `vendor/client`
// git submodule; this re-export resolves into that submodule.
//
// NOTE: the registry only exists on the client's `feature/e2e-testability`
// commit that this submodule is pinned to. If this import fails, run
// `git submodule update --init --recursive`.
export {
  TID,
  MEMBER_NAME_ATTR,
  SERVER_ID_ATTR,
  CALENDAR_EVENT_TITLE_ATTR,
  CALENDAR_VIEW_ATTR,
  STREAM_SOURCE_TITLE_ATTR,
  BROADCASTER_NAME_ATTR,
} from "../vendor/client/crates/mumble-tauri/ui/src/testids";

// Forum / kebab attribute keys, declared locally (NOT re-exported from the
// client) so this module keeps loading when the checked-out client branch
// predates the forums feature: a re-export of a missing named export throws
// at import time and would take the whole suite down. Values must match the
// client's testids.ts on feat/forums-and-scheduled-messages.
export const KEBAB_ITEM_ATTR = "data-item-id";
export const FORUM_TOPIC_ATTR = "data-topic";
export const FORUM_THREAD_TITLE_ATTR = "data-thread-title";

/** `By.css` locator for an element carrying the given `data-testid`. */
export const byTid = (id: string): By => By.css(`[data-testid="${id}"]`);
