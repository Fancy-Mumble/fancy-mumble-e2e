import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";

/**
 * Two real clients exercising the per-channel forum end-to-end against the
 * server's FancyForum* implementation (server PR
 * "feat(forums+scheduled): server protocol, DB tables, handlers, delivery
 * timer"): thread create round-trip (server assigns the post id and
 * broadcasts the root), cross-client visibility, replies, live edit
 * broadcast, quote-into-reply, in-topic search, and author deletes (reply
 * and whole thread).
 *
 * All threads are created in the default "General Discussion" topic of the
 * root channel; tokens are timestamped so reruns against a persistent
 * server DB stay unambiguous. Pin/lock moderation is NOT covered: it needs
 * Write permission on the channel (channel admin), which anonymous e2e
 * users don't hold - the server treats pin/lock as a root-title edit, so
 * the wire path is covered by the edit test anyway.
 */
describe("multi-client: channel forums", { skip: "blocked: forums are not merged into the client yet - every id this file drives (forumPanel, forumThreadRow, forumPost, chatHeaderKebab, ...) lives in ABSENT_FROM_CLIENT in src/selectors.ts, so all 12 fail in `before` rather than on an assertion" }, () => {
  let alice: TauriApp;
  let bob: TauriApp;
  const aliceName = `e2e-ForumA-${Date.now() % 100000}`;
  const bobName = `e2e-ForumB-${Date.now() % 100000}`;
  const stamp = Date.now();

  const TOPIC = "General Discussion";
  const threadTitle = `e2e thread ${stamp}`;
  const threadBody = `root post body ${stamp}`;
  const replyBody = `bob reply ${stamp}`;
  const editedBody = `root post EDITED ${stamp}`;

  before(async () => {
    alice = await TauriApp.launch({ instance: 0 });
    bob = await TauriApp.launch({ instance: 1 });

    await alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });

    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);
    // The fixture server ships plugins; answer the trust prompt before it
    // click-intercepts the header kebab.
    await alice.chat.allowServerPlugins();
    await bob.chat.allowServerPlugins();
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("opens the forum panel onto the default board index", async () => {
    await alice.forum.open();
    // The default taxonomy renders even on an empty board; entering a topic
    // proves the panel is interactive.
    await alice.forum.openTopic(TOPIC);
  });

  it("creates a thread (server assigns the id and echoes the root post)", async () => {
    // createThread resolves only once the thread row is listed, which
    // requires the server's FancyForumPost broadcast back to the author -
    // the first full forum round-trip.
    await alice.forum.createThread(threadTitle, threadBody);
  });

  it("shows the thread to a second client", async () => {
    await bob.forum.open();
    await bob.forum.openTopic(TOPIC);
    await bob.forum.waitForThread(threadTitle);
  });

  it("delivers a reply into the author's open thread view", async () => {
    // Alice keeps the thread open; Bob replies. The reply must arrive at
    // Alice via the server's live broadcast (no manual refresh).
    await alice.forum.openThread(threadTitle);
    await alice.forum.waitForPost(threadBody);

    await bob.forum.openThread(threadTitle);
    await bob.forum.waitForPost(threadBody);
    await bob.forum.reply(replyBody);

    await alice.forum.waitForPost(replyBody);
  });

  it("reflects the reply count on a re-fetched thread listing", async () => {
    // reply_count is computed by the server on thread listings only, so
    // navigate back and re-fetch rather than trusting local state. The stale
    // pre-refresh row lingers until the response lands, hence the poll.
    await bob.forum.back();
    await bob.forum.refresh();
    await bob.forum.waitForThreadReplyCount(threadTitle, 1);
  });

  it("quotes a post into the reply composer", async () => {
    // Bob is back on the topic listing after the reply-count test.
    await bob.forum.openThread(threadTitle);
    await bob.forum.quotePost(threadBody);
    const draft = await bob.forum.replyDraft();
    assert.match(draft, /> /, "quoted body should be prefixed with '> '");
    assert.ok(draft.includes(threadBody), "draft should contain the quoted body");
  });

  it("broadcasts an inline edit to the other client", async () => {
    // Alice has had the thread open since the reply test; Bob re-opened it
    // for the quote test. The edit must reach Bob without a manual refresh.
    await alice.forum.editPost(threadBody, editedBody);
    await bob.forum.waitForPost(editedBody);
  });

  it("filters threads with the in-topic search", async () => {
    // The fixture DB persists across runs, so match on the full timestamped
    // titles - a generic prefix would also hit earlier runs' threads.
    const otherTitle = `zz search decoy ${stamp}`;
    await alice.forum.back(); // thread -> topic listing
    await alice.forum.createThread(otherTitle, `decoy body ${stamp}`);

    await alice.forum.searchThreads(otherTitle);
    let titles = await alice.forum.listedThreadTitles();
    assert.deepEqual(titles, [otherTitle]);

    await alice.forum.searchThreads(threadTitle);
    titles = await alice.forum.listedThreadTitles();
    assert.deepEqual(titles, [threadTitle]);

    // Back to the unfiltered listing, then into the thread for later tests.
    await alice.forum.searchThreads(" ");
    await alice.forum.openThread(threadTitle);
  });

  it("lets the author delete a reply, removing it for both clients", async () => {
    // Bob authored the reply; delete from his open thread view. Alice has
    // the same thread open - the removal must reach her as a broadcast.
    await bob.forum.deletePost(replyBody);
    await bob.forum.waitForPostGone(replyBody);
    await alice.forum.waitForPostGone(replyBody);
  });

  it("lets the author delete the whole thread, removing it from the listing", async () => {
    await alice.forum.deletePost(editedBody); // root post -> whole thread
    // Deleting the root closes the thread view back onto the topic listing.
    await alice.forum.refresh();
    await alice.driver.wait(
      async () => !(await alice.forum.hasThread(threadTitle)),
      15000,
      "deleted thread still listed for its author",
    );

    await bob.forum.back();
    await bob.forum.refresh();
    await bob.driver.wait(
      async () => !(await bob.forum.hasThread(threadTitle)),
      15000,
      "deleted thread still listed for the second client",
    );
  });
});
