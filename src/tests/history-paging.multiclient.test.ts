import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync } from "node:fs";
import { By, type WebDriver } from "selenium-webdriver";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { binaryContains, serviceMissing, type Gate } from "../util/preconditions";
import { serverMissing } from "../util/suite-server";
import { xpathLiteral } from "../util/xpath";
import { delay } from "../util/wait";

/**
 * Lazy-loaded message history - phase 6 of
 * `docs/MESSAGE-HISTORY-LAZY-LOADING-PLAN.md`, §10.
 *
 * The claim under test is not "history is replayed" - `pchat.multiclient`
 * covers that - but *how much of it is resident*. Opening a channel with a few
 * thousand messages used to fetch one page and then mount every message the
 * host held, growing the window toward the top and never releasing anything -
 * so reading backwards cost DOM without bound and the far edge stayed mounted
 * forever. What a test can see of that is the row count: it must stay under a
 * ceiling however far back somebody reads, and the rows released have to be
 * the ones the reader is moving away from.
 *
 * The second suite covers the other half of the plan, `server_managed`
 * channels: not end-to-end encrypted, the server holds the key and seals the
 * rows at rest, so a client that was not connected - not merely not in the
 * channel, not connected at all - when the messages were sent still reads the
 * whole archive after joining. That is the entire reason the mode exists, and
 * it is the one claim no single-client test can make.
 */

/**
 * The most rows the client may mount at once.
 *
 * `MAX_MOUNTED` in the client's `core/features/chat/chatWindowing.ts`. Copied
 * rather than imported, because this suite drives a *binary*: the number that
 * matters is the one compiled into the client under test, and a constant read
 * out of the source tree beside it would silently follow a refactor that the
 * running build had not picked up.
 */
const WINDOW_CEILING = 300;

/** The server's history page size (`limit: 50` at every client fetch site). */
const SERVER_PAGE = 50;

/**
 * How many messages the archive holds.
 *
 * One server page more than the DOM ceiling, and no more than that. Posting is
 * the expensive part of this suite - see {@link POST_INTERVAL_MS} - but an
 * archive that fits inside the window cannot fail the bounded-DOM assertion,
 * and a test that cannot fail is not evidence. At 350 the reader has to give
 * up the newest 50 rows to reach the oldest one, which is exactly the
 * behaviour the two-sided window introduced.
 */
const MESSAGE_COUNT = WINDOW_CEILING + SERVER_PAGE;

/**
 * How fast the archive can be written.
 *
 * pchat budgets stores at 2/s with a burst of 20, per connection
 * (`starling/crates/services/pchat/src/limits.rs`), and a refused store is
 * answered with `Ack{RATE_LIMITED}` and **not archived** - so posting faster
 * than this does not fill the archive faster, it fills it with holes. The
 * budget is hard-coded in the server, so unlike the gateway's text-message
 * limit it cannot be raised for a test; the suite pays the 3 minutes.
 *
 * 520 ms rather than 500 leaves the burst as headroom for jitter instead of
 * spending it in the first ten seconds.
 */
const POST_INTERVAL_MS = 520;

/** Long enough to launch a client, write the archive, and reconnect. */
const ARCHIVE_SETUP_TIMEOUT_MS = MESSAGE_COUNT * POST_INTERVAL_MS + 5 * 60_000;

/** Long enough to walk the whole archive one page at a time, twice. */
const SCROLL_TIMEOUT_MS = 5 * 60_000;

/** Distinguishes this run's messages, and each message from its neighbours. */
const RUN = Date.now() % 1_000_000;

/**
 * The body of message `index`, zero-padded to a fixed width.
 *
 * The padding is load-bearing: every match here is a `contains()`, so an
 * unpadded `hp-1` would be found inside `hp-10` and a test asking whether the
 * oldest message is mounted would be answered by the eleventh.
 */
function token(index: number): string {
  return `hp-${RUN}-${String(index).padStart(3, "0")}`;
}

/**
 * A *mounted message row* carrying `text`, in either design pack.
 *
 * Deliberately not `chat.messages.hasText`, which asks whether the string is
 * anywhere on the page. Nebula's channel list previews the last message of a
 * channel, so "is the newest message on screen" would be true from the sidebar
 * while the transcript had released the row - and the whole subject here is
 * which rows the transcript is carrying. Standard emits `data-msg-id`, Nebula
 * `data-message-id`; `MessageList.rowByText` knows only the first of those,
 * which is why this is written out rather than reused, and it belongs on that
 * page object the day it learns the second.
 */
function rowWith(text: string): By {
  return By.xpath(
    `//*[@data-msg-id or @data-message-id]` +
      `[contains(normalize-space(string(.)), ${xpathLiteral(text)})]`,
  );
}

/** Whether a message row carrying `text` is mounted right now. */
async function rowMounted(driver: WebDriver, text: string): Promise<boolean> {
  return (await driver.findElements(rowWith(text))).length > 0;
}

interface ScrollProbe {
  /** Whether the row carrying the sought message was mounted in the end. */
  found: boolean;
  /** The most rows mounted at any point on the way. */
  peak: number;
  /** How many scroll steps it took. */
  steps: number;
}

/**
 * Drive the transcript to one end, step by step, until `text` is mounted.
 *
 * This is a measurement as much as a gesture, which is why it lives with the
 * assertions rather than in the page object. Two reasons it cannot be
 * `messages.loadOlder()` in a loop:
 *
 *   - `loadOlder` is defined by the row count *growing*, and once the window
 *     is at its ceiling a page arriving at the head releases as many rows at
 *     the tail. The count then stops changing while the reader is still moving
 *     through the archive, so a growth-shaped wait would time out on a client
 *     that is behaving exactly as designed.
 *   - A ceiling can only be asserted from the peak. A count read after the
 *     scroll settles cannot see the moment the window was widest, which is the
 *     moment that would break the bound.
 */
async function scrollUntilMounted(
  app: TauriApp,
  to: "top" | "bottom",
  text: string,
  { steps = 60, settleMs = 600 }: { steps?: number; settleMs?: number } = {},
): Promise<ScrollProbe> {
  let peak = 0;
  for (let step = 0; step < steps; step++) {
    peak = Math.max(peak, await app.chat.messages.renderedCount());
    if (await rowMounted(app.driver, text)) return { found: true, peak, steps: step };
    try {
      await app.chat.messages.scrollTo(to);
    } catch {
      // The scroller is found by walking up from a row, so a window that is
      // between renders has none. The next pass looks at a settled tree.
    }
    await delay(settleMs);
  }
  return {
    found: await rowMounted(app.driver, text),
    peak: Math.max(peak, await app.chat.messages.renderedCount()),
    steps,
  };
}

/**
 * Overwrite server settings for the run (Starling's operator API).
 *
 * Only the gateway's *text* budget is raised here. The archive is written
 * through pchat, whose budget is hard-coded and paced for instead, but
 * `send_message` still sends the legacy `TextMessage` beside every pchat
 * message and the gateway ships that at 1/s with a burst of 5 - which this
 * suite would exceed on its sixth message.
 */
async function setServerSettings(values: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${config.operatorApiUrl}/v1/config`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.operatorToken}`,
    },
    body: JSON.stringify(values),
  });
  if (!response.ok) {
    throw new Error(`POST /v1/config -> ${response.status} ${await response.text()}`);
  }
}

/**
 * Write `count` messages into `channelId` at the rate the server will accept.
 *
 * Straight through the `send_message` command rather than the composer: this
 * is the same code path a typed message takes from the store down (dual text
 * copy, pchat envelope, own-message store), minus a locate, a DOM write and a
 * click per message - which at 350 messages is the difference between a slow
 * suite and an unusable one.
 *
 * Paced against a fixed schedule rather than by sleeping between sends, so the
 * time each round trip already costs is spent out of the interval instead of
 * added to it.
 */
async function postArchive(app: TauriApp, channelId: number, count: number): Promise<void> {
  const startedAt = Date.now();
  for (let index = 0; index < count; index++) {
    const due = startedAt + index * POST_INTERVAL_MS;
    const wait = due - Date.now();
    if (wait > 0) await delay(wait);
    await app.invoke("send_message", { channelId, body: token(index) });
  }
}

/**
 * The `server_managed` mode has to exist in the client that is being driven.
 *
 * It is the fourth `PchatProtocol`, and a build from before it landed offers
 * no such option in the channel editor - so every case in that suite would
 * fail at a `<select>` that has three entries, describing a missing feature as
 * a broken one. The wire name is what the Rust half serialises
 * (`state/types/serde_helpers.rs`), so its presence in the binary is the
 * question exactly.
 */
function serverManagedUnsupported(): Gate {
  if (!existsSync(config.appBin)) {
    return `the client binary is missing at ${config.appBin}. Build it with \`scripts/build-client.sh\`.`;
  }
  return binaryContains(config.appBin, "server_managed")
    ? false
    : `this client build has no \`server_managed\` channel mode, so the channel ` +
      `editor cannot express one. Rebuild the client from a tree that has ` +
      `phase 3 of docs/MESSAGE-HISTORY-LAZY-LOADING-PLAN.md.`;
}

/** Where the archive suite needs an operator API, and why. */
const operatorApiMissing = (): Gate =>
  serviceMissing(
    config.operatorApiUrl,
    "Starling's operator API",
    "`npm run e2e`, which starts a server with the admin plane enabled",
  );

describe(
  "message history: a long archive is read a page at a time",
  { skip: serverMissing() || operatorApiMissing(), concurrency: 1 },
  () => {
    let alice: TauriApp;
    const channelName = `e2e-history-${RUN}`;
    /** What the transcript mounted when the channel was opened. */
    let openingRows = 0;

    before(async () => {
      setSuperUserPassword("testpassword");
      await setServerSettings({ message_limit: 1000, message_burst: 1000 });

      alice = await TauriApp.launch({ instance: 0 });
      await alice.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      });
      await alice.chat.waitLoaded(config.connectTimeout);

      await alice.sidebar.createSubChannel(0, channelName, {
        pchatProtocol: "fancy_v1_full_archive",
      });
      await alice.sidebar.waitForChannel(channelName);
      await alice.sidebar.joinChannel(channelName);
      const channelId = Number(await alice.sidebar.channelIdByName(channelName));

      await postArchive(alice, channelId, MESSAGE_COUNT);

      // Reconnect before measuring anything. The sender's own store still
      // holds every message it just wrote, so a window measured here would be
      // a window over local memory; after a reconnect the only source of
      // history is the server, which is the case the plan is about.
      await alice.chat.disconnect();
      await alice.connect.waitReady(config.connectTimeout);
      await alice.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      });
      await alice.chat.waitLoaded(config.connectTimeout);
      await alice.sidebar.waitForChannel(channelName);
      await alice.sidebar.joinChannel(channelName);
      // The newest message is the one the first page is anchored to, so its
      // arrival is what says the archive has been opened rather than that the
      // channel has been entered.
      await alice.chat.messages.waitForText(token(MESSAGE_COUNT - 1), 60_000);
    }, { timeout: ARCHIVE_SETUP_TIMEOUT_MS });

    after(async () => {
      // Back to the shipped budgets: the server outlives this file, and a
      // later suite that measures flood control would otherwise measure ours.
      await setServerSettings({ message_limit: 1, message_burst: 5 }).catch(() => {
        /* the run is ending either way; a failed restore must not mask it */
      });
      await alice?.close();
    });

    it("mounts a bounded slice of the archive when the channel opens", async () => {
      openingRows = await alice.chat.messages.renderedCount();

      assert.ok(
        openingRows > 0,
        "the transcript mounted no message rows at all, so nothing below " +
          "measures windowing",
      );
      assert.ok(
        openingRows < MESSAGE_COUNT,
        `opening the channel mounted ${openingRows} of ${MESSAGE_COUNT} messages - ` +
          `the whole archive is resident, which is the cost lazy loading exists ` +
          `to avoid`,
      );
      assert.ok(
        openingRows <= WINDOW_CEILING,
        `opening the channel mounted ${openingRows} rows, over the ${WINDOW_CEILING}-row ` +
          `window ceiling`,
      );

      assert.equal(
        await rowMounted(alice.driver, token(MESSAGE_COUNT - 1)),
        true,
        "the window opens at the tail, so the newest message must be mounted",
      );
      assert.equal(
        await rowMounted(alice.driver, token(0)),
        false,
        `the oldest of ${MESSAGE_COUNT} messages was mounted on open, so the client ` +
          `fetched and mounted the whole archive rather than a page of it`,
      );
    });

    it(
      "mounts older messages as the reader scrolls back through it",
      { timeout: SCROLL_TIMEOUT_MS },
      async () => {
        if (openingRows === 0) openingRows = await alice.chat.messages.renderedCount();

        // One step first, on its own, because "a page arrived" and "the reader
        // got all the way back" are different failures and the first is the one
        // worth naming precisely. A page landing above the reader must not move
        // what they are looking at, so the client pays the height difference
        // back into `scrollTop` - which is why growth, not position, is the
        // signal that history arrived.
        const grown = await alice.chat.messages.loadOlder(60_000);
        assert.ok(
          grown > openingRows,
          `scrolling to the top mounted no further history (${openingRows} rows before, ` +
            `${grown} after)`,
        );

        const walk = await scrollUntilMounted(alice, "top", token(0));
        assert.ok(
          walk.found,
          `the oldest message never mounted after ${walk.steps} scrolls to the top; ` +
            `paging stopped somewhere in the middle of a ${MESSAGE_COUNT}-message archive`,
        );
        assert.ok(
          walk.peak <= WINDOW_CEILING,
          `reading back to the start of the archive mounted ${walk.peak} rows, over the ` +
            `${WINDOW_CEILING}-row ceiling`,
        );
      },
    );

    it(
      "re-attaches to the newest message without ever exceeding the window ceiling",
      { timeout: SCROLL_TIMEOUT_MS },
      async () => {
        // Standing at the oldest message, having arrived there through the
        // previous case.
        assert.equal(
          await rowMounted(alice.driver, token(0)),
          true,
          "precondition: this case reads from the far end of the archive, which the " +
            "previous one leaves the transcript at",
        );
        assert.equal(
          await rowMounted(alice.driver, token(MESSAGE_COUNT - 1)),
          false,
          `${MESSAGE_COUNT} messages fit in the DOM at once with the reader at the far ` +
            `end of them: the window grew toward the top without ever releasing the ` +
            `tail, which is the one-sided behaviour the two-sided window replaced`,
        );

        const walk = await scrollUntilMounted(alice, "bottom", token(MESSAGE_COUNT - 1));
        assert.ok(
          walk.found,
          `the newest message never came back after ${walk.steps} scrolls to the bottom - ` +
            `a reader who scrolled up cannot return to the live tail`,
        );
        assert.ok(
          walk.peak <= WINDOW_CEILING,
          `coming back down mounted ${walk.peak} rows, over the ${WINDOW_CEILING}-row ` +
            `ceiling: the rows above are being kept as well as the rows below`,
        );

        // And the far edge is released again, symmetrically.
        assert.equal(
          await rowMounted(alice.driver, token(0)),
          false,
          "back at the tail, the oldest message is still mounted - the window only " +
            "ever grows, so a long reading session keeps everything it has passed",
        );
      },
    );
  },
);

describe(
  "server-managed history: the server holds the key, so a late joiner reads it",
  { skip: serverMissing() || serverManagedUnsupported(), concurrency: 1 },
  () => {
    let alice: TauriApp;
    let bob: TauriApp | undefined;
    const channelName = `e2e-srvmanaged-${RUN}`;
    const bobName = `e2e-hist-bob-${RUN}`;
    /** Small: this suite is about who can read the archive, not how big it is. */
    const count = 6;
    const body = (index: number): string => `sm-${RUN}-${String(index).padStart(2, "0")}`;

    before(async () => {
      setSuperUserPassword("testpassword");
      alice = await TauriApp.launch({ instance: 0 });
      await alice.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      });
      await alice.chat.waitLoaded(config.connectTimeout);

      await alice.sidebar.createSubChannel(0, channelName, {
        pchatProtocol: "server_managed",
      });
      await alice.sidebar.waitForChannel(channelName);
      await alice.sidebar.joinChannel(channelName);

      for (let index = 0; index < count; index++) {
        // Through the composer, unlike the archive suite. Six messages do not
        // need the fast path, and the composer refreshes the sender's own view
        // - which is what lets this hook prove the messages were archived
        // before Bob is asked to read them, instead of leaving a failed send to
        // surface as a failure of *his* read. Spaced for the gateway's shipped
        // text budget of 1/s, which this suite does not raise.
        if (index > 0) await delay(1_100);
        await alice.chat.composer.send(body(index));
      }
      await alice.chat.messages.waitForText(body(count - 1), 30_000);
    }, { timeout: 6 * 60_000 });

    after(async () => {
      await Promise.allSettled([alice?.close(), bob?.close()]);
    });

    it(
      "reads every message that was sent before it ever connected",
      { timeout: 6 * 60_000 },
      async () => {
        // Launched here, not in `before`: the point of the mode is that a client
        // which was not connected when the messages were sent can still read
        // them, and a client that was sitting on the connect screen the whole
        // time proves less than one that did not exist.
        bob = await TauriApp.launch({ instance: 1 });
        await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
        await bob.chat.waitLoaded(config.connectTimeout);

        await bob.sidebar.waitForChannel(channelName);
        await bob.sidebar.joinChannel(channelName);

        // Every message, not just the newest: a mode whose whole purpose is a
        // readable archive has to hand over the archive, not the tail of it.
        for (let index = 0; index < count; index++) {
          await bob.chat.messages.waitForText(body(index), 30_000);
        }
      },
    );

    it("asks nobody for a key, because there is no key to share", async () => {
      // The end-to-end modes gate a joiner's first read on a member approving
      // the share (`KeyShareWarningDialog`), and the previous case would have
      // hung on that prompt if this mode had one. Asserting it is absent says
      // *why* the read above worked, which is the difference between this mode
      // and `fancy_v1_full_archive`.
      assert.equal(
        await alice.chat.keyShares.approveAll(5_000),
        0,
        "a server-managed channel raised a key-share consent prompt: the client is " +
          "treating it as an end-to-end mode, and its history would then depend on " +
          "a member being online to approve",
      );
      assert.equal(
        await alice.chat.header.hasE2EBadge(),
        false,
        "the header badges a server-managed channel as end-to-end encrypted, which " +
          "is exactly the thing a user must not have to infer wrongly - the server " +
          "can read this channel",
      );
    });
  },
);
