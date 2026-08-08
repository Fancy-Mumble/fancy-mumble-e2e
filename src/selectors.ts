import { By } from "selenium-webdriver";

// Re-export the *exact* test-id registry shipped with the client UI so selectors
// can never drift from the markup. The client lives here as the `vendor/client`
// git submodule; this re-export resolves into that submodule.
//
// NOTE: the registry only exists on the client's `feature/e2e-testability`
// commit that this submodule is pinned to. If this import fails, run
// `git submodule update --init --recursive`.
import { TID as CLIENT_TID } from "../vendor/client/crates/mumble-tauri/ui/src/core/testids";

export {
  MEMBER_NAME_ATTR,
  SERVER_ID_ATTR,
  CALENDAR_EVENT_TITLE_ATTR,
  CALENDAR_VIEW_ATTR,
  STREAM_SOURCE_TITLE_ATTR,
  BROADCASTER_NAME_ATTR,
} from "../vendor/client/crates/mumble-tauri/ui/src/core/testids";

// Forum / kebab attribute keys, declared locally (NOT re-exported from the
// client) so this module keeps loading when the checked-out client branch
// predates the forums feature: a re-export of a missing named export throws
// at import time and would take the whole suite down. Values must match the
// client's testids.ts on feat/forums-and-scheduled-messages.
export const KEBAB_ITEM_ATTR = "data-item-id";
export const FORUM_TOPIC_ATTR = "data-topic";
export const FORUM_THREAD_TITLE_ATTR = "data-thread-title";

// Test ids for features the checked-out client does not ship, same reasoning
// and same source branch as the attribute keys above. Forums and scheduled
// messages have no markup at all in the current UI - the rework left no `forum`
// component behind, and "scheduled" now means meeting *rooms* - so these cannot
// be re-exported from the client's registry.
//
// Declaring them keeps two properties that both matter. `forum.page.ts` and
// `scheduled.page.ts` typecheck, so the suite is not carrying 39 permanent
// errors that hide the next real one. And the pages then look for a *named*
// selector: before this, `TID.forumPanel` was `undefined` at runtime and every
// forum test failed against `[data-testid="undefined"]`, which reads as a
// harness bug rather than as an absent feature.
//
// Values follow the client's kebab-case convention, so when the feature does
// land the spread below silently prefers the client's own definition.
const ABSENT_FROM_CLIENT = {
  chatHeaderKebab: "chat-header-kebab",
  kebabMenuItem: "kebab-menu-item",
  forumBack: "forum-back",
  forumEditBodyInput: "forum-edit-body-input",
  forumEditSave: "forum-edit-save",
  forumNewThread: "forum-new-thread",
  forumPanel: "forum-panel",
  forumPost: "forum-post",
  forumPostDelete: "forum-post-delete",
  forumPostEdit: "forum-post-edit",
  forumPostQuote: "forum-post-quote",
  forumRefresh: "forum-refresh",
  forumReplyInput: "forum-reply-input",
  forumReplySubmit: "forum-reply-submit",
  forumSearchInput: "forum-search-input",
  forumThreadBodyInput: "forum-thread-body-input",
  forumThreadRow: "forum-thread-row",
  forumThreadSubmit: "forum-thread-submit",
  forumThreadTitleInput: "forum-thread-title-input",
  forumTopicRow: "forum-topic-row",
  scheduledBodyInput: "scheduled-body-input",
  scheduledError: "scheduled-error",
  scheduledItem: "scheduled-item",
  scheduledItemCancel: "scheduled-item-cancel",
  scheduledPanel: "scheduled-panel",
  scheduledRefresh: "scheduled-refresh",
  scheduledSubmit: "scheduled-submit",
  scheduledTimeInput: "scheduled-time-input",
} as const;

/// The registry the page objects use: the client's, widened by the ids above.
///
/// The client comes *second* on purpose. The moment it ships one of these, its
/// value wins and this file stops being consulted for it - which is the only
/// direction that cannot go stale silently.
export const TID = { ...ABSENT_FROM_CLIENT, ...CLIENT_TID };

/** `By.css` locator for an element carrying the given `data-testid`. */
export const byTid = (id: string): By => By.css(`[data-testid="${id}"]`);
