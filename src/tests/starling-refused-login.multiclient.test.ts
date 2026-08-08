import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";
import { StarlingServer } from "../util/starling";
import { delay } from "../util/wait";

/**
 * A refused login must leave nothing behind.
 *
 * The reported bug, from the side the user actually saw it. Starling sent the
 * `Reject` and never closed the socket, so the client reported
 * "Server connection rejected: Wrong certificate or password" and then sat
 * there - still connected, still drawing the root channel it had been sent,
 * still pinging, and thirty seconds later announcing it was switching to TCP
 * because its UDP probe had failed. A session that is half present: no audio,
 * no roster, nothing it can do, and no disconnect either.
 *
 * # Why this exists next to the Rust test
 *
 * `crates/starling/src/e2e.rs` already asserts the server hangs up, against a
 * real deployment over real TLS. That covers the fix. It does **not** cover
 * what this file does, which is the client's *resulting state*: the server
 * closing the socket and the client noticing it has been closed are two
 * different things, and the symptom in the report was entirely about the
 * second. A raw-protocol client cannot show that, because it has no notion of
 * being "half connected" - only a real client with a status, a channel tree
 * and a reconnect timer does.
 *
 * # Why the connection is made through the backend rather than the wizard
 *
 * `attemptRawConnect` takes an explicit port, and the connect wizard only
 * offers one in expert mode. That also keeps this suite off 64738 entirely, so
 * it never competes with whatever else is using the shared fixture.
 */

/** How long to watch the status after the rejection before believing it. */
const SETTLE_MS = 8_000;

const skip = !StarlingServer.available()
  ? `no Starling binary at ${StarlingServer.binary} - build it with ` +
    `\`cargo build -p starling --manifest-path vendor/starling/Cargo.toml\``
  : false;

describe("Starling refuses a login cleanly", { concurrency: 1, skip }, () => {
  let server: StarlingServer;
  let app: TauriApp;

  before(async () => {
    server = await StarlingServer.start();
    app = await TauriApp.launch({ instance: 0 });
  });

  after(async () => {
    await Promise.allSettled([app?.close()]);
    await server?.stop();
  });

  it("tells the client why it was refused", async () => {
    // SuperUser is registered on every deployment and has a password, so
    // presenting none is a refusal that needs no set-up - and it is the exact
    // refusal in the report.
    const outcome = await app.attemptRawConnect(config.serverHost, server.port, "SuperUser");

    assert.equal(
      outcome.connected,
      false,
      "the client was admitted as SuperUser without the password",
    );
    assert.ok(
      outcome.reason !== null,
      `the client was refused with no reason to show the user. Server log:\n${server.log}`,
    );
  });

  it("closes the connection instead of leaving it half open", async () => {
    // The assertion this file exists for, and it took two attempts to find one
    // that is actually worth anything.
    //
    // The obvious probe - poll the client's `get_status` and require it never
    // reads "connected" - **passes with the bug present**. The client's status
    // was never the broken part: it reports the rejection correctly either
    // way. What lingered was the *socket*, which is why the symptom in the
    // report was a client that had been told it was rejected and then went on
    // pinging and announcing a switch to TCP half a minute later.
    //
    // So the discriminating signal is the server closing the connection, and
    // it has to be looked for on the server's own record.
    //
    // Matched against **the connection that was refused**, not against any
    // disconnect at all. A bare `/client disconnected/` passes with the bug
    // present, because the client reaches this server twice: it dials once,
    // rejects the self-signed certificate, drops that connection - logging a
    // disconnect - and reconnects to accept it. That is the "Reconnecting."
    // line in the original report, and matching it would have made this test
    // green against the very build it exists to catch.
    const refused = /login refused conn=(\d+)/.exec(server.log);
    assert.ok(
      refused,
      `the server never recorded a refusal, so there is nothing to check. ` +
        `Log:\n${server.log}`,
    );
    const conn = refused[1];

    // And matched on **who** closed it, which is the last place this test
    // could have fooled itself. A disconnect for the refused connection shows
    // up either way, because this client tears down its own socket when it is
    // rejected. The gateway names the initiator in the reason it logs:
    // `disconnected by the server` when a service asked for it, against
    // `peer closed` or `connection reset` when the client went first.
    //
    // Only the first of those is the fix. Without it the server never asks,
    // and whether the connection lingers is left entirely to the client's
    // goodwill - which is exactly how the reported session stayed half open
    // for half a minute, pinging, on a client that took a different path.
    const closed = new RegExp(
      `client disconnected conn=${conn}\\b[^\\n]*reason=disconnected by the server`,
    );
    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline) {
      if (closed.test(server.log)) return;
      await delay(500);
    }

    assert.fail(
      `the server refused conn=${conn} and never closed it itself - whether the connection ` +
        `goes away is left to the client, and a client that does not oblige is left half ` +
        `open, holding its slot, never reaped because it keeps pinging. ` +
        `Server log:\n${server.log}`,
    );
  });

  it("records the refusal for the operator, and survives it", async () => {
    // The refusal has to be answerable from the log alone: "nobody can log in"
    // is otherwise a support conversation with no evidence in it.
    assert.match(
      server.log,
      /login refused/,
      `the server did not record the refusal. Log:\n${server.log}`,
    );
    assert.ok(server.running, `Starling exited during the test:\n${server.log}`);
  });
});
