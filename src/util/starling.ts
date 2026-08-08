import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
    /**
     * Where its operator API listens.
     *
     * On an ephemeral port, like everything else here, so two runs on one
     * machine do not collide. The runner exports it as `E2E_OPERATOR_API_URL`
     * so the tests find it; nothing hard-codes 8081 any more.
     */
    readonly operatorPort: number = 0,
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
    writeFileSync(configFile, config(port, http, dataDir), "utf8");

    const proc = spawn(STARLING_BIN, ["--all-in-one", "--config", configFile], {
      cwd: dataDir,
      env: {
        ...process.env,
        // Voice at debug, because the line naming the negotiated cipher is a
        // `tracing::debug!` — at plain `info` it does not exist, and the test
        // that asserts on it fails describing a cipher choice that was in fact
        // correct. Everything else stays at info; voice logs nothing per packet.
        RUST_LOG: process.env.E2E_STARLING_LOG ?? "info,starling_voice=debug",
        // The operator API's bearer token, which its config names by
        // environment variable rather than holding in plaintext. Without it
        // the API refuses every request, and the suite's SuperUser setup —
        // which eleven files depend on in `before` — fails against a server
        // that is otherwise perfectly healthy.
        STARLING_ADMIN_TOKEN: process.env.E2E_OPERATOR_TOKEN ?? "e2e-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    proc.stdout?.on("data", (chunk) => output.push(String(chunk)));
    proc.stderr?.on("data", (chunk) => output.push(String(chunk)));

    const server = new StarlingServer(port, proc, dataDir, output, http + 1);
    await server.waitUntilListening();
    await server.waitUntilSuperuserProvisioned();
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

  /**
   * Wait until the virtual server's SuperUser account exists.
   *
   * `--all-in-one` spawns each service as a detached task and opens the
   * gateway's TLS listener — which {@link waitUntilListening} catches — before
   * `userdata` has run `ensure_superuser`. For that window the only SuperUser
   * record is the random-password one userdata is still writing, and a test
   * that sets the password there loses the race: userdata announces its
   * generated password after storing it, so the operator-API update sent first
   * is overwritten, and every SuperUser login then fails with WrongUserPw.
   *
   * The announcement is logged only once the account is written, so waiting for
   * it means a later password-set lands on an existing record and holds. A fresh
   * data dir — which every run uses — always logs the line; if it somehow does
   * not, give up quietly and let the caller proceed rather than fail the run.
   */
  private async waitUntilSuperuserProvisioned(timeout = 20_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!this.running) {
        throw new Error(`Starling exited during startup:\n${this.log}`);
      }
      if (this.log.includes("superuser account created")) return;
      await delay(150);
    }
  }
}

/**
 * The configuration this run needs, as a delta.
 *
 * **Written, not derived.** `Config::load` builds `with_defaults` and then
 * overlays the file onto it, so everything not named here - the service map,
 * the routing table, the rate-limit buckets - comes from the defaults. This
 * used to be a copy of `starling.example.toml` with a dozen regex edits
 * applied, back when `--config` replaced the defaults outright and a partial
 * file produced a server with an empty service map.
 *
 * That derivation broke silently the day the example was rewritten as its own
 * delta: `all_in_one = false` and the whole `[services.operator-api]` block
 * stopped existing, every `.replace()` matched nothing, and the run got a
 * server with no admin plane. The visible symptom was eleven `before` hooks
 * failing to set the SuperUser password, several minutes and one misleading
 * error away from the cause. A file we write cannot drift out from under us
 * like that.
 *
 * Three ports move together and for different reasons. `listen_tcp` is the
 * control connection; `virtual_servers[].port` is what the server reports about
 * itself; and voice's `udp_listen` is where audio actually goes - murmur binds
 * TCP and UDP on one number and every Mumble client sends its datagrams to
 * whatever port it made TCP to, so a voice socket left on the default is a
 * server that handshakes perfectly and carries no audio.
 */
function config(port: number, http: number, dataDir: string): string {
  const auditLog = path.join(dataDir, "operator-audit.log").replace(/\\/g, "/");
  return `# Written by the e2e harness; overlaid on Starling's built-in defaults.
[runtime]
all_in_one = true
data_dir = "${dataDir.replace(/\\/g, "/")}"

[gateway]
listen_tcp = "127.0.0.1:${port}"

[services.voice]
udp_listen = "127.0.0.1:${port}"

[[virtual_servers]]
id = 1
port = ${port}

[services.web]
listen = "127.0.0.1:${http}"

# The only administrative surface Starling has, and how the suite sets the
# SuperUser password. Ships disabled, which is right for a deployment and
# wrong here.
[services.operator-api]
enabled = true
listen = "127.0.0.1:${http + 1}"
tier = "optional"

[services.operator-api.auth]
mode = "token"

[services.operator-api.auth.token]
tokens = [{ value_env = "STARLING_ADMIN_TOKEN", scopes = ["*"] }]

# Ships as /var/log/starling with fail_closed = true, which a non-root runner
# cannot write - every operator-API call then 503s, including the SuperUser
# setup eleven files depend on.
[services.operator-api.audit]
path = "${auditLog}"
fail_closed = true
`;
}

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
