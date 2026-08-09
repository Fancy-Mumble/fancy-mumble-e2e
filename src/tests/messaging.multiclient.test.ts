import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";

/**
 * Two real clients, two isolated profiles, one server. Proves the control
 * plane round-trips between users: presence (each sees the other join the
 * default/root channel) and channel text messaging in both directions.
 *
 * This is the scenario that validates the per-client data-dir + per-port
 * isolation in TauriApp.launch({ instance }).
 */
describe("multi-client: presence + messaging", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  const aliceName = `e2e-Alice-${Date.now() % 100000}`;
  const bobName = `e2e-Bob-${Date.now() % 100000}`;

  before(async () => {
    // Distinct instances -> distinct tauri-driver ports + isolated app data,
    // so the two clients hold independent identities (Mumble rejects duplicate
    // names, hence the distinct usernames too).
    [alice, bob] = await TauriApp.launchAll({ instance: 0 }, { instance: 1 });

    await Promise.all([
      alice.connect.connect(config.serverHost, aliceName, { port: config.serverPort }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);

    await Promise.all([
      alice.chat.waitLoaded(config.connectTimeout),
      bob.chat.waitLoaded(config.connectTimeout),
    ]);
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("each client sees the other join the channel", async () => {
    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);
  });

  it("delivers a channel message from Alice to Bob", async () => {
    const token = `e2e-a2b-${Date.now()}`;
    await alice.chat.sendMessage(token);
    await bob.chat.waitForText(token);
  });

  it("delivers a reply from Bob to Alice", async () => {
    const token = `e2e-b2a-${Date.now()}`;
    await bob.chat.sendMessage(token);
    await alice.chat.waitForText(token);
  });
});
