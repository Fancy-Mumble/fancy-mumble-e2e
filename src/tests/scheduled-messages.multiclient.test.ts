import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";

/**
 * Two real clients exercising scheduled channel messages end-to-end against
 * the server's FancyScheduledMessage* implementation (server-side store +
 * delivery timer): schedule round-trip (pending row = server ack + list),
 * cancel, client-side time validation, and the actual timed delivery of the
 * message into the channel for BOTH clients.
 *
 * The delivery test schedules ~1.5 min ahead (the datetime-local input has
 * minute resolution, so the effective lead time is 30-90 s) and waits for
 * the message to arrive as a regular channel text message - the full
 * store -> timer -> broadcast path. Total suite runtime is therefore
 * dominated by that single wait.
 */
describe("multi-client: scheduled messages", () => {
  let alice: TauriApp;
  let bob: TauriApp;
  const aliceName = `e2e-SchedA-${Date.now() % 100000}`;
  const bobName = `e2e-SchedB-${Date.now() % 100000}`;
  const stamp = Date.now();

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

    await alice.scheduled.open();
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  });

  it("rejects a delivery time in the past before contacting the server", async () => {
    await alice.scheduled.setBody(`e2e past ${stamp}`);
    await alice.scheduled.setDeliveryInMinutes(-5);
    await alice.scheduled.submit();
    const err = await alice.scheduled.waitForError();
    assert.ok(err.length > 0, "expected a validation error for a past delivery time");
  });

  it("schedules a message (server ack) and cancels it", async () => {
    const text = `e2e cancel-me ${stamp}`;
    await alice.scheduled.schedule(text, 10);
    await alice.scheduled.cancel(text);

    // The cancel must have round-tripped: a server-side list re-fetch still
    // shows no pending row.
    await alice.scheduled.refresh();
    await new Promise((r) => setTimeout(r, 1500));
    await alice.scheduled.waitForPendingGone(text, 5000);
  });

  it("delivers the scheduled message to the channel at the due time", async () => {
    const text = `e2e scheduled-delivery ${stamp}`;
    await alice.scheduled.schedule(text, 1.5);

    // Effective lead time is 30-90 s (minute truncation); allow for delivery
    // timer granularity on top.
    await bob.chat.waitForText(text, 150000);
    await alice.chat.waitForText(text, 15000);

    // After delivery the message must leave the pending list on a re-fetch.
    await alice.scheduled.refresh();
    await alice.scheduled.waitForPendingGone(text, 15000);
  });
});
