import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

/**
 * Two identities reading one `fancy_v1_full_archive` channel.
 *
 * The gap this closes: every other pchat suite drives one identity, or asserts
 * only on what the *sender* can see, and a sender can always read its own
 * messages. That left the whole point of an archive channel - a second person
 * reading it - unmeasured, and a real defect sat behind the gap for months.
 * Each client derived its own archive key on join (HKDF over its *own* identity
 * seed, so never the same key twice), then reported itself as a holder, which
 * suppressed the consent prompt that would have shared the real one. Ciphertext
 * arrived and failed to open with `aead::Error` while `has_key` was true, so
 * both ends looked healthy and nothing readable crossed between them.
 *
 * Cross-client decryption is therefore asserted here directly, and the consent
 * step is part of the test rather than a workaround: sharing an archive key is
 * deliberately gated on the holder agreeing (`KeyShareWarningDialog`).
 */
describe("pchat cross-client: a second identity reads the archive", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  const channelName = `e2e-pchat-x-${Date.now() % 1000000}`;
  const bobName = `e2e-pchat-xbob-${Date.now() % 100000}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    [alice, bob] = await TauriApp.launchAll({ instance: 0 }, { instance: 1 });
    await Promise.all([
      alice.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);
    await Promise.all([
      alice.chat.waitLoaded(config.connectTimeout),
      bob.chat.waitLoaded(config.connectTimeout),
    ]);

    await alice.sidebar.createSubChannel(0, channelName, {
      pchatProtocol: "fancy_v1_full_archive",
    });
    await alice.sidebar.waitForChannel(channelName);
    await bob.sidebar.waitForChannel(channelName);
    await alice.sidebar.joinChannel(channelName);
    await bob.sidebar.joinChannel(channelName);
    await alice.chat.waitForMember(bobName);
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("shares the archive key on consent, and the peer decrypts what follows", async () => {
    // Alice is the only holder: Bob joined a channel he did not create, so he
    // must be given the key rather than inventing one.
    const approved = await alice.chat.approveKeyShares();
    assert.ok(
      approved > 0,
      "the key holder was never asked to share the archive key - the joiner " +
        "most likely minted a key of its own and reported itself a holder, " +
        "which withdraws the prompt",
    );

    const token = `pchat-x-${Date.now()}`;
    await alice.chat.sendMessage(token);
    await alice.chat.waitForText(token);
    await bob.chat.waitForText(token);
  });

  it("carries messages both ways once the key is shared", async () => {
    const fromBob = `pchat-x-bob-${Date.now()}`;
    await bob.chat.sendMessage(fromBob);
    await bob.chat.waitForText(fromBob);
    await alice.chat.waitForText(fromBob);
  });
});
