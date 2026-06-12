import { TauriApp } from "../app";
import { config } from "../config";

/**
 * Voice *UI state* across two clients (no real audio). Alice toggles her
 * self-mute / self-deafen; Bob's view of Alice's user row must reflect it,
 * proving the mute/deafen control plane round-trips through the server into
 * every client's UI.
 *
 * Audio *fidelity* (does sound actually flow) is intentionally out of scope -
 * that is covered by the client's mumble-protocol integration/audio_quality
 * tests.
 */
describe("multi-client: voice UI state", function () {
  this.timeout(360000);

  let alice: TauriApp;
  let bob: TauriApp;
  const aliceName = `e2e-Alice-${Date.now() % 100000}`;
  const bobName = `e2e-Bob-${Date.now() % 100000}`;

  before(async () => {
    alice = await TauriApp.launch({ instance: 0 });
    bob = await TauriApp.launch({ instance: 1 });

    await alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort });
    await bob.connect.connect(config.serverHost, bobName, { port: config.serverPort });

    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);

    // Make sure both are in the channel and can see each other before toggling.
    await bob.chat.waitForMember(aliceName);
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("reflects Alice's self-mute on Bob's user list", async () => {
    await alice.chat.selfMute();
    await bob.chat.waitForMemberMuted(aliceName);
  });

  it("reflects Alice's self-deafen on Bob's user list", async () => {
    await alice.chat.selfDeafen();
    await bob.chat.waitForMemberDeaf(aliceName);
  });
});
