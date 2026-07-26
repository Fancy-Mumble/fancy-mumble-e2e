import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
   */
  static async start(): Promise<StarlingServer> {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "starling-e2e-"));
    const output: string[] = [];

    const proc = spawn(STARLING_BIN, ["--port", String(port)], {
      cwd: dataDir,
      env: { ...process.env, RUST_LOG: process.env.E2E_STARLING_LOG ?? "info" },
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
   */
  get voicePortOpen(): boolean {
    return this.log.includes("voice port open");
  }

  /** Whether the process is still up. */
  get running(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** Stop the server and clean up its data directory. */
  async stop(): Promise<void> {
    killTree(this.proc.pid);
    // Give the process a moment to release the port before the next test binds.
    await delay(200);
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
