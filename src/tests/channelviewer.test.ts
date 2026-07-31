import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Channel viewer (ZeroC Ice) reads the live server's channel tree.
 *
 * The cloned Flask channel viewer (vendor/channelviewer) talks to the server
 * over the **Ice** admin interface. The server's `Channel` struct gained a
 * `hidden` field; Ice marshals structs positionally with NO versioning, so a
 * stale slice mis-unmarshals every `getChannels` reply and the viewer breaks.
 *
 * This drives the *current* viewer (slice synced to the server + rebuilt) against
 * the Ice-enabled server and asserts both halves of the fix:
 *   - it returns the channel tree with no Ice marshalling error, AND
 *   - hidden/private channels are filtered out of the public output.
 *
 * Setup - Ice is enabled in fixtures/mumble-server.ini and the viewer is started
 * via the `channelviewer` compose profile. The server image MUST match the source
 * the viewer's slice was synced to: use the suite's mumble-server:dev (the compose
 * default :latest is older and sends a 7-field Channel that mis-unmarshals against
 * the hidden-aware slice - the very drift this guards):
 *   E2E_SERVER_IMAGE=mumble-server:dev docker compose \
 *     -f fixtures/docker-compose.e2e.yml --profile channelviewer up -d --wait
 *
 * The viewer's HTTP API is on the host at E2E_CHANNELVIEWER_PORT (default 5005).
 */

const VIEWER_URL =
  process.env.E2E_CHANNELVIEWER_URL ?? `http://localhost:${process.env.E2E_CHANNELVIEWER_PORT ?? "5005"}`;

interface ViewerChannel {
  readonly id: number;
  readonly name: string;
  readonly parent: number;
}

/**
 * Fetch the viewer's flat channel list, polling until it serves a 200 (the
 * viewer container may still be establishing its first Ice connection). Throws
 * an actionable error if it never comes up.
 */
async function fetchViewerChannels(timeoutMs = 30000): Promise<ViewerChannel[]> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${VIEWER_URL}/api/v1/channels`);
      if (res.ok) return (await res.json()) as ViewerChannel[];
      lastErr = new Error(`viewer returned HTTP ${res.status}: ${await res.text()}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `channel viewer not reachable at ${VIEWER_URL} (${lastErr}). Start it with:\n` +
      `  docker compose -f fixtures/docker-compose.e2e.yml --profile channelviewer up -d --wait`,
  );
}

interface SnapshotNode {
  readonly name: string;
  readonly channels: SnapshotNode[];
}
interface Snapshot {
  readonly root: SnapshotNode;
}

/** All channel names in a snapshot tree (depth-first). */
function snapshotChannelNames(snapshot: Snapshot): string[] {
  const names: string[] = [];
  const walk = (node: SnapshotNode) => {
    names.push(node.name);
    node.channels.forEach(walk);
  };
  walk(snapshot.root);
  return names;
}

/** Open the SSE stream and return the first pushed snapshot (skipping keepalive
 *  comments), then abort. Proves the server-push path end-to-end. */
async function readFirstSseSnapshot(timeoutMs = 20000): Promise<Snapshot> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${VIEWER_URL}/api/v1/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (dataLine) return JSON.parse(dataLine.slice("data:".length).trim()) as Snapshot;
      }
    }
    throw new Error("SSE stream ended without a data frame");
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

describe("channel viewer (Ice): reads channels, filters hidden", () => {
  let admin: TauriApp;
  const sfx = Date.now() % 100000;
  const publicName = `cv-public-${sfx}`;
  const hiddenName = `cv-hidden-${sfx}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await TauriApp.launch({ instance: 0 });
    await admin.connect.connect(config.serverHost, "SuperUser", {
      port: config.serverPort,
      password: "testpassword",
    });
    await admin.chat.waitLoaded();
    // One normal and one hidden channel under root, so the viewer has something
    // to render and something it must filter.
    await admin.sidebar.createSubChannel(0, publicName);
    await admin.sidebar.createSubChannel(0, hiddenName, { hidden: true });
    await admin.sidebar.waitForChannel(publicName);
    await admin.sidebar.waitForChannel(hiddenName);
  });

  after(async () => {
    await Promise.allSettled([admin?.close()]);
  });

  it("returns the channel tree over Ice with hidden channels filtered out", async () => {
    const channels = await fetchViewerChannels();
    const names = channels.map((c) => c.name);

    // The marshalling fix: a non-empty channel list comes back (root + the public
    // channel) with no Ice unmarshalling error. Pre-fix `getChannels` throws.
    assert.ok(channels.length > 0, "viewer returned no channels - Ice marshalling failed?");
    assert.ok(
      names.includes(publicName),
      `public channel "${publicName}" missing from viewer output (got: ${names.join(", ")})`,
    );

    // The hidden filter: the private channel must NOT be exposed by the viewer.
    assert.ok(
      !names.includes(hiddenName),
      `hidden channel "${hiddenName}" leaked into the public viewer output`,
    );
  });

  it("pushes a live snapshot over SSE (real-time path), still hidden-filtered", async () => {
    // Ensure the snapshot has caught up to the channels created in `before`.
    await fetchViewerChannels();
    const snapshot = await readFirstSseSnapshot();
    const names = snapshotChannelNames(snapshot);
    assert.ok(
      names.includes(publicName),
      `SSE snapshot missing "${publicName}" (got: ${names.join(", ")})`,
    );
    assert.ok(
      !names.includes(hiddenName),
      `hidden channel "${hiddenName}" leaked into the SSE snapshot`,
    );
  });

  it("serves an online-user history series for the charts", async () => {
    const res = await fetch(`${VIEWER_URL}/api/v1/stats/history`);
    assert.equal(res.ok, true, `stats/history HTTP ${res.status}`);
    const series = (await res.json()) as { t: number; online: number }[];
    assert.ok(Array.isArray(series) && series.length > 0, "stats history should be non-empty");
    assert.equal(typeof series[0].t, "number");
    assert.equal(typeof series[0].online, "number");
  });
});
