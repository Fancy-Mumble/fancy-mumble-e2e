/**
 * A Starling a phone can reach, for driving the client by hand.
 *
 * The suite's server is deliberately loopback-only (`src/util/starling.ts`),
 * because every client the suite drives runs on this machine. An Android
 * client does not: the emulator reaches the host through `10.0.2.2`, and a
 * physical phone through the host's LAN address. Neither routes to
 * `127.0.0.1`, so a manual Android session against the suite's own server
 * fails at connect with nothing to look at.
 *
 * This starts the same server through the same code path - one config, no
 * second copy to drift - with the bind and advertise hosts overridden, sets a
 * SuperUser password you can actually log in with, and then stays up until
 * Ctrl+C.
 *
 *     npm run server:android
 *
 * Environment:
 *   ANDROID_SERVER_PASSWORD  SuperUser password (default: superuser)
 *   E2E_STARLING_BIND        interface to bind (default: 0.0.0.0)
 *   E2E_STARLING_ADVERTISE   address to put in SDP/download URLs
 *                            (default: this host's LAN address)
 */
import { createSocket } from "node:dgram";

/**
 * The address a phone on the LAN dials.
 *
 * Asked of the routing table rather than read off the interface list. This
 * machine has seven IPv4 addresses - two Hyper-V switches, a VPN, three
 * link-local and one real Ethernet - and "the first non-internal one" picks
 * the Hyper-V switch (10.99.0.1), which no phone can reach. Connecting a UDP
 * socket assigns no traffic and sends no packet; it just makes the kernel
 * choose a route and bind the source address that route uses, which is the one
 * an outside device would answer to.
 */
async function lanAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const done = (value: string | null) => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    socket.once("error", () => done(null));
    try {
      // 8.8.8.8 is a routing landmark, not a destination - nothing is sent to it.
      socket.connect(53, "8.8.8.8", () => {
        try {
          done(socket.address().address ?? null);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

const lan = await lanAddress();
const password = process.env.ANDROID_SERVER_PASSWORD ?? "superuser";

// Set before the imports below: both modules read their configuration at
// import time, so a dynamic import is what lets these take effect.
process.env.E2E_STARLING_BIND ??= "0.0.0.0";
process.env.E2E_STARLING_ADVERTISE ??= lan ?? "127.0.0.1";
process.env.E2E_OPERATOR_TOKEN ??= "e2e-token";

const { StarlingServer } = await import("../src/util/starling");

if (!StarlingServer.available()) {
  console.error(
    `No Starling binary at ${StarlingServer.binary}.\n` +
      `Build one: cd vendor/starling && cargo build -p starling`,
  );
  process.exit(1);
}

console.log("starting Starling...");
const server = await StarlingServer.start();

// Only now is the operator API's port known - it is ephemeral, like every
// other port the harness hands out.
process.env.E2E_OPERATOR_API_URL = `http://127.0.0.1:${server.operatorPort}`;
const { setSuperUserPassword } = await import("../src/util/server");
setSuperUserPassword(password);

const emulator = `10.0.2.2:${server.port}`;
console.log(`
Starling is up.

  Android emulator   host: 10.0.2.2      port: ${server.port}
  Phone on the LAN   host: ${lan ?? "(no LAN address found)"}${lan ? `      port: ${server.port}` : ""}
  This machine       host: 127.0.0.1     port: ${server.port}

  SuperUser password: ${password}
  Operator API:       ${process.env.E2E_OPERATOR_API_URL} (bearer ${process.env.E2E_OPERATOR_TOKEN})

The emulator's ${emulator} is the host's loopback, so nothing else has to be
forwarded. A physical phone needs the LAN address above, and the firewall on
this machine has to allow inbound ${server.port}.

Ctrl+C to stop.
`);

let printed = 0;
const pump = setInterval(() => {
  const log = server.log;
  if (log.length > printed) {
    process.stdout.write(log.slice(printed));
    printed = log.length;
  }
}, 250);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(pump);
  console.log("\nstopping Starling...");
  await server.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
