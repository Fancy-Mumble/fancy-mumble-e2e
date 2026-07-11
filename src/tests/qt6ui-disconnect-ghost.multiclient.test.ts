import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { Qt6UiClient } from "../util/qt6ui";
import { delay } from "../util/wait";

/**
 * Regression: disconnecting in the minimal Qt UI must actually close the
 * server session - no ghost user left behind.
 *
 * Background (client bug, vendor/client/crates/qt6ui + mumble-protocol):
 * qt6ui's `AppCore::disconnect` fired the graceful `Disconnect` command
 * asynchronously and immediately ABORTED the protocol event-loop task. The
 * event loop's sub-tasks (TCP reader/writer, keep-alive ping loop) are
 * separate tokio tasks whose JoinHandles live on the event loop's stack, and
 * dropping a JoinHandle *detaches* the task instead of aborting it - so the
 * abort leaked them. The leaked writer kept the TCP socket open and the
 * leaked ping loop kept answering the server's keep-alive every 15 s: from
 * the server's point of view the user was still online, forever. Not even
 * the ping timeout could reap the session, because pings kept flowing.
 *
 * Scenario: an observer (full Tauri client) and the Qt client join the same
 * server; the observer sees the Qt user appear; the Qt user disconnects
 * through the same Backend invokable the UI's disconnect button calls; the
 * user must then vanish from the observer's roster within seconds (TCP close
 * -> immediate UserRemove), and stay gone.
 *
 * The Qt client is driven via its env-gated e2e control channel
 * (FANCY_QT6UI_E2E_PORT, see the crate's src/e2e.rs and src/util/qt6ui.ts) -
 * QML is invisible to WebDriver.
 */
describe("qt6ui: disconnect leaves no ghost session on the server", () => {
  let observer: TauriApp;
  let qt: Qt6UiClient;
  const sfx = Date.now() % 100000;
  const observerName = `e2e-ghost-observer-${sfx}`;
  const qtName = `e2e-ghost-qt-${sfx}`;

  before(async () => {
    observer = await TauriApp.launch({ instance: 0 });
    await observer.connect.connect(config.serverHost, observerName, {
      port: config.serverPort,
    });
    await observer.chat.waitLoaded();
    qt = await Qt6UiClient.launch({ instance: 0 });
  });

  after(async () => {
    await qt?.close();
    await observer?.close();
  });

  it("removes the user from the server when the Qt UI disconnects", async () => {
    // Qt client joins; both clients land in the root channel.
    await qt.connect(config.serverHost, config.serverPort, qtName);
    await qt.waitForStatus("connected");
    await observer.chat.waitForMember(qtName);

    // Disconnect through the UI's code path. The client-side status flips
    // to "disconnected" immediately (it always did - the bug was that the
    // server-side session lived on).
    await qt.disconnect();
    await qt.waitForStatus("disconnected", 10000);

    // Core regression assertion: the server must drop the session promptly.
    // A graceful disconnect closes the TCP connection, so the server emits
    // UserRemove right away - 15 s is generous. With the bug, the leaked
    // ping loop kept the session alive indefinitely and this times out.
    await observer.chat.waitForMemberGone(qtName, 15000);

    // The session must STAY gone (guard against a flappy remove/re-add,
    // e.g. an unwanted auto-reconnect after teardown).
    await delay(3000);
    await observer.chat.waitForMemberGone(qtName, 1000);
  });
});
