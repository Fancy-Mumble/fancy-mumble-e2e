import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { bridgeMissing } from "../util/preconditions";
import { settleSignalKeys } from "../util/signal";

/**
 * End-to-end Signal Protocol (signal_v1) persistent chat across multiple real
 * clients. Each instance has its OWN identity (cert + Signal keys) via the
 * per-instance FANCY_E2E_DATA_DIR isolation, so sender-key distribution and
 * cross-user decryption are meaningful.
 *
 * These tests exercise the late-joiner sender-key delivery fix (server
 * `sendStoredSenderKeyDistributions`): when a member joins a signal_v1 channel
 * the server hands it the sender keys of everyone already present, so every
 * member can decrypt every other member's messages regardless of join order.
 * Before that fix an earlier member's messages were permanently undecryptable
 * to a later joiner. See the `signal-late-joiner-skdm-gap` memory.
 *
 * Forward secrecy is unaffected: signal_v1 keeps no server-side history, so a
 * late joiner still never receives messages exchanged before it joined.
 *
 * Unlike fancy_v1_full_archive, signal_v1 key sharing is fully automatic - there
 * is NO "Share Key" consent dialog (that is a full-archive feature).
 *
 * Convention: SuperUser (admin, instance 0) creates the signal channel; bob and
 * carol are anonymous participants on instances 1 and 2.
 *
 * The late-joiner SKDM fix is in the published server image, so this runs green
 * against the default ghcr image (no E2E_SERVER_IMAGE override needed).
 */

async function connectAnon(instance: number, name: string): Promise<TauriApp> {
  const app = await TauriApp.launch({ instance });
  await app.connect.connect(config.serverHost, name, { port: config.serverPort });
  await app.chat.waitLoaded();
  return app;
}

async function connectAdmin(): Promise<TauriApp> {
  const app = await TauriApp.launch({ instance: 0 });
  await app.connect.connect(config.serverHost, "SuperUser", {
    port: config.serverPort,
    password: "testpassword",
  });
  await app.chat.waitLoaded();
  return app;
}

describe("signal pchat: full E2E decryption across members", { skip: bridgeMissing() }, () => {
  let admin: TauriApp;
  let bob: TauriApp;
  let carol: TauriApp;
  const channelName = `e2e-sig-${Date.now() % 1000000}`;
  const bobName = `e2e-Bob-${Date.now() % 100000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    // Launch and connect all three concurrently: the JOIN order below is the
    // contract under test, connection order is not.
    [admin, bob, carol] = await TauriApp.launchAll(
      { instance: 0 },
      { instance: 1 },
      { instance: 2 },
    );
    await Promise.all([
      (async () => {
        await admin.connect.connect(config.serverHost, "SuperUser", {
          port: config.serverPort,
          password: "testpassword",
        });
        await admin.chat.waitLoaded();
      })(),
      (async () => {
        await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
        await bob.chat.waitLoaded();
      })(),
      (async () => {
        await carol.connect.connect(config.serverHost, `e2e-Carol-${Date.now() % 100000}`, {
          port: config.serverPort,
        });
        await carol.chat.waitLoaded();
      })(),
    ]);

    // admin creates the channel and joins (earliest member); bob joins next,
    // then carol last. Join order must NOT matter for decryption.
    await admin.sidebar.createSubChannel(0, channelName, { pchatProtocol: "signal_v1" });
    await admin.sidebar.joinChannel(channelName);
    await bob.sidebar.waitForChannel(channelName);
    await bob.sidebar.joinChannel(channelName);
    await carol.sidebar.waitForChannel(channelName);
    await carol.sidebar.joinChannel(channelName);

    await settleSignalKeys([admin, bob, carol]);
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close(), carol?.close()]);
  });

  it("every member decrypts every other member's messages, regardless of join order", async () => {
    // admin and bob both joined BEFORE carol; the late-joiner fix means carol
    // still receives their sender keys and can decrypt them.
    const fromAdmin = `sig-admin-${Date.now()}`;
    await admin.chat.sendMessage(fromAdmin);
    await bob.chat.waitForText(fromAdmin, 25000);
    await carol.chat.waitForText(fromAdmin, 25000);

    const fromBob = `sig-bob-${Date.now()}`;
    await bob.chat.sendMessage(fromBob);
    await admin.chat.waitForText(fromBob, 25000);
    await carol.chat.waitForText(fromBob, 25000);

    const fromCarol = `sig-carol-${Date.now()}`;
    await carol.chat.sendMessage(fromCarol);
    await admin.chat.waitForText(fromCarol, 25000);
    await bob.chat.waitForText(fromCarol, 25000);
  });

  it("a member resumes encrypted messaging after reconnecting and re-joining", async () => {
    await bob.chat.disconnect();
    await bob.connect.waitReady(config.connectTimeout);
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });
    await bob.chat.waitLoaded();
    await bob.sidebar.waitForChannel(channelName);
    await bob.sidebar.joinChannel(channelName);
    await settleSignalKeys([admin, bob]);

    const afterRejoin = `sig-bob-rejoin-${Date.now()}`;
    await bob.chat.sendMessage(afterRejoin);
    await admin.chat.waitForText(afterRejoin, 25000);
    await carol.chat.waitForText(afterRejoin, 25000);

    const toRejoined = `sig-admin-after-${Date.now()}`;
    await admin.chat.sendMessage(toRejoined);
    await bob.chat.waitForText(toRejoined, 25000);
  });
});

describe("signal pchat: forward secrecy for late joiners", { skip: bridgeMissing() }, () => {
  let admin: TauriApp;
  let carol: TauriApp;
  const channelName = `e2e-fs-${Date.now() % 1000000}`;
  const preToken = `fs-pre-${Date.now()}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await connectAdmin();
    await admin.sidebar.createSubChannel(0, channelName, { pchatProtocol: "signal_v1" });
    await admin.sidebar.joinChannel(channelName);
    // Sent while admin is alone - BEFORE any late joiner is present.
    await admin.chat.sendMessage(preToken);
    await admin.chat.waitForText(preToken);
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), carol?.close()]);
  });

  it("a late joiner can't read pre-join history but can read messages sent after joining", async () => {
    carol = await connectAnon(1, `e2e-Carol-${Date.now() % 100000}`);
    await carol.sidebar.waitForChannel(channelName);
    await carol.sidebar.joinChannel(channelName);
    await settleSignalKeys([admin, carol]);

    // signal_v1 keeps no server-side history and carol was not present for the
    // pre-join message, so it must never appear for her (forward secrecy) - the
    // SKDM fix delivers keys, never past ciphertext.
    assert.equal(
      await carol.chat.hasText(preToken),
      false,
      "late joiner must NOT see pre-join E2E history (no server storage + forward secrecy)",
    );

    // But a message admin (an earlier member) sends AFTER carol joins must be
    // decryptable by her - this is the late-joiner SKDM fix.
    const postToken = `fs-post-${Date.now()}`;
    await admin.chat.sendMessage(postToken);
    await carol.chat.waitForText(postToken, 25000);
  });
});

describe("signal pchat: bridge smoke", { skip: bridgeMissing() }, () => {
  let admin: TauriApp;
  const channelName = `e2e-sigsmoke-${Date.now() % 1000000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    admin = await connectAdmin();
    await admin.sidebar.createSubChannel(0, channelName, { pchatProtocol: "signal_v1" });
    await admin.sidebar.joinChannel(channelName);
  });

  after(async () => {
    await Promise.allSettled([admin?.close()]);
  });

  it("loads the signal bridge and shows the E2E banner, and round-trips an own message", async () => {
    // The Signal Protocol banner only renders once the channel is recognised as
    // signal_v1 and the bridge is available.
    await admin.chat.waitForText("encrypted using the Signal Protocol", 20000);

    // A self-sent message must encrypt then decrypt locally (bridge round-trip).
    const token = `sig-smoke-${Date.now()}`;
    await admin.chat.sendMessage(token);
    await admin.chat.waitForText(token, 15000);
  });
});
