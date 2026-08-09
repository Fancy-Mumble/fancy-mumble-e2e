import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { TauriApp } from "../app";
import { presenceUnsupported, type Gate } from "../util/preconditions";
import { DiscordIpcClient, FakeDiscord, makeIsolatedRuntimeDir, slotAddress } from "../util/discord-ipc";

/**
 * Discord rich presence: the client hosts Discord's own local IPC endpoint so
 * activity published by other applications is visible here too.
 *
 * This is the half no unit test can reach. `crates/fancy-presence` has its own
 * integration tests, but they drive the library directly - they cannot show
 * that the *shipped binary* binds the socket, that the Tauri commands are
 * registered, or that preferences reach the listener. Everything here goes
 * through the real app process and a real socket.
 *
 * The three behaviours worth guarding, in order of how badly they fail:
 *
 *  1. An application's activity reaches the client at all.
 *  2. A Discord client that starts *later* still receives everything. Getting
 *     this wrong does not break us - it silently breaks Discord, on a user's
 *     machine, for every other app they run.
 *  3. Turning the feature off releases the socket. It if does not, the next
 *     enable lands on slot 1, where nothing is ever delivered, and the feature
 *     appears to work while observing nothing.
 *
 * No Mumble server is needed: presence is local-machine state and the listener
 * runs whether or not the client is connected.
 */

/**
 * Discord's IPC slots live in `XDG_RUNTIME_DIR` on POSIX, so pointing the app
 * at a throwaway one gives the test its own namespace. Windows has no
 * equivalent - the pipe namespace is global - so the test there would fight
 * the developer's real Discord for slot 0 and, if it won, silently take over
 * their presence for the duration. Not worth it.
 */
const unisolatable: Gate =
  process.platform === "win32" &&
  "Discord's IPC namespace is global on Windows (named pipes), so this test cannot " +
    "isolate itself from a running Discord client. Covered on Linux/macOS, and by " +
    "the crate's own tests, which do run on Windows.";

/** A plausible-looking application id. Never resolved - artwork is off. */
const APP_ID = "379286085710381999";

/**
 * Skip for either reason, checked in milliseconds: a namespace we cannot
 * isolate, or a client that predates the feature.
 */
const skip: Gate = unisolatable || presenceUnsupported();

describe("Discord rich presence: the client hosts Discord's IPC endpoint", { skip }, () => {
  let app: TauriApp;
  let runtimeDir: string;
  const openClients: DiscordIpcClient[] = [];

  /** Presence status as reported by the backend. */
  const status = async () =>
    (await app.invoke<{ status: PresenceStatus }>("presence_snapshot")).status;

  /** Live entries as reported by the backend. */
  const entries = async () =>
    (await app.invoke<{ entries: PresenceEntry[] }>("presence_snapshot")).entries;

  interface PresenceStatus {
    enabled: boolean;
    bridgeState: string | null;
    slot: number | null;
  }
  interface PresenceEntry {
    applicationId: string;
    displayName: string;
    pid: number | null;
    activity: { details?: string; state?: string; timestamps?: { start?: number } };
  }

  /** Poll until `check` passes, so tests never race the backend's event loop. */
  async function until(what: string, check: () => Promise<boolean>, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function connectClient(slot = 0): Promise<DiscordIpcClient> {
    const client = await DiscordIpcClient.connect(slotAddress(runtimeDir, slot));
    openClients.push(client);
    return client;
  }

  before(async () => {
    runtimeDir = makeIsolatedRuntimeDir();
    app = await TauriApp.launch({ instance: 0, extraEnv: { XDG_RUNTIME_DIR: runtimeDir } });
  });

  after(async () => {
    await Promise.allSettled([app?.close()]);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Artwork resolution off throughout: it is the one part that reaches the
    // network, and a CDN lookup has no business deciding whether this passes.
    await app.invoke("presence_set_enabled", { enabled: true, resolveArtwork: false });
    await until("a clean listener", async () => (await entries()).length === 0);
  });

  afterEach(async () => {
    for (const client of openClients.splice(0)) client.close();
    await app.invoke("presence_set_enabled", { enabled: false, resolveArtwork: false });
  });

  it("takes Discord's first slot and serves an application's activity", async () => {
    const current = await status();
    assert.equal(current.enabled, true);
    assert.equal(current.slot, 0, "must take slot 0 - clients stop at the first that answers");
    assert.equal(current.bridgeState, "standalone", "no Discord is running in this runtime dir");
    assert.ok(existsSync(slotAddress(runtimeDir, 0)), "the IPC socket should exist on disk");

    const client = await connectClient();
    const ready = await client.handshake(APP_ID);
    assert.equal(ready.evt, "READY", "a standalone listener must answer the handshake itself");
    assert.ok(ready.data?.user, "client libraries reject a READY with no user object");

    // Seconds, not milliseconds: several client libraries send them that way
    // and the backend is expected to normalise.
    const startSeconds = Math.floor(Date.now() / 1000) - 90;
    const response = await client.setActivity(
      {
        details: "Reticulating splines",
        state: "In a test",
        timestamps: { start: startSeconds },
      },
      { pid: 4321, nonce: "e2e-nonce-1" },
    );
    assert.equal(response.nonce, "e2e-nonce-1", "a library blocks forever without its nonce back");

    await until("the activity to be observed", async () => (await entries()).length === 1);
    const [entry] = await entries();
    assert.equal(entry.applicationId, APP_ID);
    assert.equal(entry.activity.details, "Reticulating splines");
    assert.equal(entry.activity.state, "In a test");
    assert.equal(entry.pid, 4321);
    assert.equal(
      entry.activity.timestamps?.start,
      startSeconds * 1000,
      "second-precision timestamps should be promoted to milliseconds",
    );
  });

  it("drops an application's activity when it disconnects", async () => {
    const client = await connectClient();
    await client.handshake(APP_ID);
    await client.setActivity({ details: "Briefly here" });
    await until("the activity to appear", async () => (await entries()).length === 1);

    client.close();

    await until("the activity to be withdrawn", async () => (await entries()).length === 0);
  });

  it("clears the entry when an application publishes an empty activity", async () => {
    const client = await connectClient();
    await client.handshake(APP_ID);
    await client.setActivity({ details: "Playing" });
    await until("the activity to appear", async () => (await entries()).length === 1);

    // A `SET_ACTIVITY` with no activity is how an application goes idle.
    await client.setActivity(undefined, { nonce: "e2e-clear" });

    await until("the activity to be cleared", async () => (await entries()).length === 0);
  });

  it("forwards to a Discord client that starts later, and still observes it", async () => {
    // Discord launches after us, so it walks past our slot 0 onto slot 1 -
    // exactly as a client library would.
    const discord = await FakeDiscord.listen(slotAddress(runtimeDir, 1));
    try {
      await until("the bridge to attach", async () => (await status()).bridgeState === "bridged");

      const client = await connectClient();
      const ready = await client.handshake(APP_ID);
      assert.equal(
        ready.data?.user?.username,
        "real-discord",
        "a bridged client must receive Discord's own READY, not our synthetic one",
      );

      await client.setActivity({ details: "Visible to both" }, { nonce: "e2e-bridged" });

      const forwarded = await discord.waitFor((body) => body?.cmd === "SET_ACTIVITY");
      assert.equal(
        forwarded.args.activity.details,
        "Visible to both",
        "Discord must receive the activity unmodified",
      );
      assert.equal(forwarded.nonce, "e2e-bridged", "and with the application's own nonce");

      // The point of the whole design: Discord is unaffected and we saw it too.
      await until("the activity to be observed", async () => (await entries()).length === 1);
      assert.equal((await entries())[0].activity.details, "Visible to both");
    } finally {
      await discord.close();
    }
  });

  it("catches a late Discord up without disturbing the running application", async () => {
    const client = await connectClient();
    await client.handshake(APP_ID);
    await client.setActivity({ details: "Started before Discord" }, { nonce: "e2e-early" });
    await until("the activity to appear", async () => (await entries()).length === 1);

    const discord = await FakeDiscord.listen(slotAddress(runtimeDir, 1));
    try {
      await until("the bridge to attach", async () => (await status()).bridgeState === "bridged");

      const replayed = await discord.waitFor((body) => body?.cmd === "SET_ACTIVITY");
      assert.equal(
        replayed.args.activity.details,
        "Started before Discord",
        "Discord should be caught up with the activity it missed",
      );
      assert.ok(
        discord.received.some((body) => body?.client_id !== undefined),
        "the application's handshake should have been replayed into Discord",
      );

      // The application already had its READY and already had that nonce
      // answered; the catch-up must not reach it as a second of either.
      await assert.rejects(
        () => client.nextFrame(1500),
        /timed out/,
        "the application saw a stray frame after the bridge attached",
      );
    } finally {
      await discord.close();
    }
  });

  it("stands aside when Discord already holds the first slot", async () => {
    // Give the slot back, then let "Discord" take it before we restart.
    await app.invoke("presence_set_enabled", { enabled: false, resolveArtwork: false });
    const discord = await FakeDiscord.listen(slotAddress(runtimeDir, 0));
    try {
      const restarted = await app.invoke<PresenceStatus>("presence_set_enabled", {
        enabled: true,
        resolveArtwork: false,
      });

      assert.equal(restarted.slot, 1, "must not displace whoever holds slot 0");
      assert.equal(
        restarted.bridgeState,
        "blocked",
        "and must report that it is receiving nothing, rather than looking healthy",
      );

      // The occupant is untouched: a client can still reach it.
      const probe = await DiscordIpcClient.connect(slotAddress(runtimeDir, 0));
      const ready = await probe.handshake(APP_ID);
      assert.equal(ready.data?.user?.username, "real-discord", "Discord's endpoint must still work");
      probe.close();
    } finally {
      await discord.close();
    }
  });

  it("releases the slot when switched off, so re-enabling gets it back", async () => {
    await app.invoke("presence_set_enabled", { enabled: false, resolveArtwork: false });

    const off = await status();
    assert.equal(off.enabled, false);
    assert.equal(off.slot, null);
    assert.equal(
      existsSync(slotAddress(runtimeDir, 0)),
      false,
      "the socket must not outlive the listener, or the next start lands on slot 1",
    );

    const back = await app.invoke<PresenceStatus>("presence_set_enabled", {
      enabled: true,
      resolveArtwork: false,
    });
    assert.equal(back.slot, 0, "an immediate re-enable must reclaim slot 0");
  });
});
