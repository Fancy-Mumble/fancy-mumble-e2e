import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killTree } from "./proc";
import { delay } from "./wait";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (fancy-mumble-e2e/). `src/util/` is two levels down. */
const repoRoot = path.resolve(thisDir, "..", "..");

const exe = process.platform === "win32" ? "starling.exe" : "starling";

/**
 * The Starling binary under test.
 *
 * Defaults to the vendored crate's debug build, which is what
 * `cargo build -p starling` produces. CI overrides it to point at a release
 * build; nothing here depends on which.
 */
const STARLING_BIN = process.env.E2E_STARLING_BIN ??
  path.join(repoRoot, "vendor", "starling", "target", "debug", exe);

/**
 * The port this server binds — 64738, not one the OS picked.
 *
 * It used to be an ephemeral port, on the reasoning that a server per test
 * cannot race another test's traffic. That is the right instinct and the wrong
 * port: **the connect wizard only offers a port field in expert mode**
 * (`src/pages/connect.page.ts`), so a client driven through it always dials
 * 64738 and never reaches an instance on any other number. The suite then
 * asserted on the log of a server no client had spoken to — "did it key the
 * client with XChaCha20" against a process that had no clients — which can
 * only fail, and fails describing the wrong server.
 *
 * Bound on 127.0.0.1 specifically. A murmur fixture in Docker publishes 64738
 * over IPv6 on this machine, and the two coexist because the client dials
 * `127.0.0.1` by default (`config.serverHost`).
 */
const STARLING_PORT = Number(process.env.E2E_STARLING_PORT ?? "64738");

/**
 * A running Starling server, on a port nobody else is using.
 *
 * The murmur fixture is a Docker container shared by the whole suite; Starling
 * is a single binary, so a test can have its own instance on its own port. That
 * matters more than convenience: these tests assert on what the server *did*,
 * and a shared server carrying another test's traffic makes those assertions
 * race.
 */
export class StarlingServer {
  private constructor(
    readonly port: number,
    private readonly proc: ChildProcess,
    private readonly dataDir: string,
    private readonly output: string[],
  ) {}

  /** Whether a Starling binary exists to test. */
  static available(): boolean {
    return existsSync(STARLING_BIN);
  }

  /** Where the binary is expected, for a skip message that says what to build. */
  static get binary(): string {
    return STARLING_BIN;
  }

  /**
   * Start a server and wait until it is accepting connections.
   *
   * Starling generates its own self-signed certificate on first run, into
   * `starling-data/` relative to its working directory — hence the temporary
   * directory, so instances never share a key or race to write one.
   *
   * # Why a config file and not a flag
   *
   * This used to spawn `starling --port N`, and **that flag has never
   * existed**. The binary takes `<component> [--config <file>]` or
   * `--all-in-one [--config <file>]` and nothing else, so every start printed
   * its usage and exited — which nobody saw, because the only suite that calls
   * this is skipped unless `E2E_SERVER_IMPL=starling` is set, and setting that
   * is exactly what nobody had done. The port therefore goes where Starling
   * actually reads one: a TOML written next to the data directory.
   *
   * All three ports move together on purpose. `listen_tcp` is the control
   * connection, `virtual_servers[].port` is what the server reports about
   * itself, and voice's `udp_listen` is the socket audio goes to — murmur binds
   * TCP and UDP on one number and clients assume it, so leaving voice on the
   * default would send every datagram to whatever else owns 64738.
   */
  static async start(): Promise<StarlingServer> {
    const port = STARLING_PORT;
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "starling-e2e-"));
    const output: string[] = [];

    const http = await freePort();
    const configFile = path.join(dataDir, "starling.toml");
    writeFileSync(configFile, config(port, http), "utf8");

    const proc = spawn(STARLING_BIN, ["--all-in-one", "--config", configFile], {
      cwd: dataDir,
      env: {
        ...process.env,
        // Voice at debug, because the line naming the negotiated cipher is a
        // `tracing::debug!` — at plain `info` it does not exist, and the test
        // that asserts on it fails describing a cipher choice that was in fact
        // correct. Everything else stays at info; voice logs nothing per packet.
        RUST_LOG: process.env.E2E_STARLING_LOG ?? "info,starling_voice=debug",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    proc.stdout?.on("data", (chunk) => output.push(String(chunk)));
    proc.stderr?.on("data", (chunk) => output.push(String(chunk)));

    const server = new StarlingServer(port, proc, dataDir, output);
    await server.waitUntilListening();
    return server;
  }

  /** Everything the server has written to stdout and stderr so far. */
  get log(): string {
    return this.output.join("");
  }

  /**
   * Whether the voice port bound.
   *
   * Starling degrades to tunnelling audio over TCP when it cannot bind UDP, so
   * a test asserting on the UDP path has to know which it got — otherwise a
   * silently tunnelled run passes a test that was meant to prove UDP works.
   *
   * Matched on the line the server actually writes. This used to look for
   * `"voice port open"`, which Starling has never printed — so the assertion
   * that depends on it could only ever fail, and only for anyone who got far
   * enough to run it.
   */
  get voicePortOpen(): boolean {
    return this.log.includes("voice bound its own UDP socket");
  }

  /** Whether the process is still up. */
  get running(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /**
   * Stop the server and clean up its data directory.
   *
   * Waits for the port to actually go quiet rather than for a fixed 200 ms.
   * Windows takes longer than that to tear a listener down, and the next run
   * then failed to bind with `os error 10048` — which surfaces as three
   * unrelated assertions failing about a server that never started, several
   * minutes and one whole GUI suite away from the cause.
   */
  async stop(): Promise<void> {
    killTree(this.proc.pid);
    await released(this.port);
    try {
      rmSync(this.dataDir, { recursive: true, force: true });
    } catch {
      /* best effort: Windows may still hold the log file */
    }
  }

  /** Poll the control port until the TLS listener accepts. */
  private async waitUntilListening(timeout = 20_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!this.running) {
        throw new Error(`Starling exited during startup:\n${this.log}`);
      }
      if (await accepts(this.port)) return;
      await delay(150);
    }
    throw new Error(`Starling did not listen on ${this.port} within ${timeout} ms:\n${this.log}`);
  }
}

/**
 * The shipped deployment TOML with every port moved out of the way.
 *
 * **Derived rather than written.** `--config` replaces the configuration
 * outright — `Config::load` deserialises the file over `Config::default()` and
 * never merges `with_defaults`, so a hand-written fixture naming only the ports
 * produces a server with an empty service map: no routes, no rate-limit
 * buckets, and a client that handshakes into a server which answers nothing.
 * Starting from the file the project ships also means this fixture cannot drift
 * from production about which service owns which wire type, which is the one
 * disagreement that would make these tests prove the wrong thing.
 *
 * Three ports move together and for different reasons. `listen_tcp` is the
 * control connection; `virtual_servers[].port` is what the server reports about
 * itself; and voice's `udp_listen` is where audio actually goes — murmur binds
 * TCP and UDP on one number and every Mumble client sends its datagrams to
 * whatever port it made TCP to, so a voice socket left on the default is a
 * server that handshakes perfectly and carries no audio.
 *
 * The two HTTP listeners move as well. They are unrelated to the protocol under
 * test, and a fixed 8080 collides with the previous instance that has not
 * finished releasing it — which fails as a *server* start-up error, several
 * assertions away from the cause.
 *
 * # The endpoints are rewritten, not kept
 *
 * The shipped file names `unix:` sockets, and the documentation says
 * `--all-in-one` ignores endpoints. It does not: an endpoint is still required
 * and still validated, so on Windows every service fails to start with *"is not
 * an endpoint: write http://host:port, pipe:name or inproc:name"* and the
 * gateway then serves a port with nothing behind it. `inproc:` is what
 * all-in-one actually uses and is the same on every platform.
 */
function config(port: number, http: number): string {
  const template = readFileSync(
    path.join(repoRoot, "vendor", "starling", "starling.example.toml"),
    "utf8",
  );
  return template
    .replace(/^all_in_one = false$/m, "all_in_one = true")
    .replace(/^port = 64738$/m, `port = ${port}`)
    .replace(/^listen_tcp = "0\.0\.0\.0:64738"$/m, `listen_tcp = "127.0.0.1:${port}"`)
    .replace(/^udp_listen = "0\.0\.0\.0:64738"/m, `udp_listen = "127.0.0.1:${port}"`)
    .replace(/^listen = "0\.0\.0\.0:8080"$/m, `listen = "127.0.0.1:${http}"`)
    .replace(/^listen = "127\.0\.0\.1:8081"$/m, `listen = "127.0.0.1:${http + 1}"`)
    .replace(/^endpoint = "unix:\/run\/starling\/(.*)\.sock"$/gm, 'endpoint = "inproc:$1"');
}

/**
 * Wait until nothing is accepting on `port` any more.
 *
 * Bounded, and it gives up quietly: a port still held after this is a problem
 * for whoever tries to bind it next, and that failure names the port. Throwing
 * here would replace it with a teardown error in a test that had already
 * finished.
 */
async function released(port: number, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await accepts(port))) return;
    await delay(100);
  }
}

/** Whether something accepts a TCP connection on `port`. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

/**
 * A port the OS says is free.
 *
 * Binding zero and reading back what was assigned, then closing. There is a
 * window in which something else could take it, which is why the caller starts
 * the server immediately — the alternative, a fixed port, collides with a
 * previous run that has not finished releasing it.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}
