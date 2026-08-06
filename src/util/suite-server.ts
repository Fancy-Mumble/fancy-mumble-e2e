import { execFileSync } from "node:child_process";
import { config } from "../config";

/**
 * The one server the whole suite talks to.
 *
 * # Why this exists
 *
 * The suite was written against the C++ fork in Docker: `run-local.ps1` brought
 * a container up on 64738, every test connected to it, and `util/server.ts`
 * administered it by `docker exec`. `vendor/server` is obsolete now, so the
 * default has to be Starling — and Starling is a binary, not a container, so
 * nothing about the old lifecycle applies.
 *
 * The lifecycle lives in `scripts/e2e.mts`, which starts one Starling before
 * the run and stops it after. This module is what a *test* uses to find out
 * whether that server is there, and it deliberately knows nothing about how it
 * was started: a developer who has their own Starling running on 64738 gets
 * exactly the same suite behaviour as CI.
 *
 * # Why one server and not one per test
 *
 * Because the client always dials 64738. The connect wizard only offers a port
 * field in expert mode, so a per-test instance on an ephemeral port is an
 * instance no driven client can reach — the suite would assert on the logs of a
 * server nobody had spoken to. `util/starling.ts` still spawns a private
 * instance for the two tests that read a server's own log, and those must not
 * run alongside the shared one; `scripts/e2e.mts` keeps them apart.
 */

/** How the suite decides which server it is talking to. */
export type ServerImpl = "starling" | "murmur";

/**
 * Which server the suite is running against.
 *
 * Starling is the default now. `E2E_SERVER_IMPL=murmur` is what a parity run
 * sets, and it is the only way to get the old behaviour — a default that
 * silently fell back to the fork would make an unported feature look ported.
 */
export function serverImpl(): ServerImpl {
  return (process.env.E2E_SERVER_IMPL ?? "starling").toLowerCase() === "murmur"
    ? "murmur"
    : "starling";
}

/** Whether the suite is measuring Starling. */
export function isStarling(): boolean {
  return serverImpl() === "starling";
}

/**
 * Skip a test that can only be run against murmur, and say so.
 *
 * For the parity tests: they drive murmur's Ice admin port, which Starling
 * replaced with the operator API (`GAP-ANALYSIS.md` S6). Running them against
 * Starling does not measure a gap in it, so a failure there would be noise.
 * Silence would be worse: a test that quietly does not run is one nobody
 * notices has stopped covering anything.
 */
export function murmurOnly(what: string): string | false {
  return isStarling()
    ? `${what} drives murmur's Ice admin port, which Starling does not have ` +
      `(operator API instead). Run it with E2E_SERVER_IMPL=murmur and the ` +
      `Docker fixture up.`
    : false;
}

/**
 * Whether something is accepting on the control port, synchronously.
 *
 * Synchronous because `before` hooks across the suite are, and asynchronous
 * probes cannot be reached from them. The cost is one short-lived child
 * process per call, which happens once per file.
 */
export function serverReachable(): boolean {
  const probe = `
    const net = require("node:net");
    const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
    socket.setTimeout(2000, () => { socket.destroy(); process.exit(1); });
    socket.once("connect", () => { socket.destroy(); process.exit(0); });
    socket.once("error", () => process.exit(1));
  `;
  try {
    execFileSync(
      process.execPath,
      ["-e", probe, config.serverHost, String(config.serverPort)],
      { stdio: "ignore", timeout: 8000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The reason to skip, or false when the suite can run.
 *
 * One message, in one place, so forty files do not each invent their own way of
 * saying the server is missing — and so the message names the command that
 * fixes it rather than leaving a timeout on `chat-composer-input` as the only
 * clue, which is what the suite did before: the client sat on the connect
 * screen for 45 seconds and the failure named a CSS selector.
 */
export function serverMissing(): string | false {
  if (serverReachable()) return false;
  return isStarling()
    ? `no server on ${config.serverHost}:${config.serverPort}. Start one with ` +
      `\`npm run e2e\`, which brings Starling up for the whole run.`
    : `no server on ${config.serverHost}:${config.serverPort}. Start the Docker ` +
      `fixture with \`docker compose -f fixtures/docker-compose.e2e.yml up -d --wait\`.`;
}
