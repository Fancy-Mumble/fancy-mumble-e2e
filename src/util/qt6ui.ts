import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config";
import { killTree } from "./proc";
import { delay } from "./wait";

/**
 * Launch and drive the minimal native Qt6 client (`vendor/client/crates/
 * qt6ui`). The QML UI is invisible to WebDriver, so the app exposes an
 * env-gated control channel instead: with `FANCY_QT6UI_E2E_PORT` set it
 * listens on localhost and maps line commands onto the *same* `Backend`
 * invokables the QML UI calls (see the crate's `src/e2e.rs`).
 *
 * Protocol: one command line in, one reply line out.
 *   connect <host> <port> <username> [password]  -> ok | err <why>
 *   disconnect                                   -> ok | err <why>
 *   status                                       -> status <value> | err <why>
 */
export class Qt6UiClient {
  private pending: Array<(line: string) => void> = [];
  private buffered = "";

  private constructor(
    private readonly proc: ChildProcess,
    private readonly sock: net.Socket,
    private readonly dataDir: string,
  ) {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buffered += chunk;
      for (;;) {
        const nl = this.buffered.indexOf("\n");
        if (nl < 0) break;
        const line = this.buffered.slice(0, nl).replace(/\r$/, "");
        this.buffered = this.buffered.slice(nl + 1);
        this.pending.shift()?.(line);
      }
    });
    sock.on("error", () => {
      /* surfaced as reply timeouts on the callers */
    });
  }

  static async launch(opts: { instance?: number } = {}): Promise<Qt6UiClient> {
    const instance = opts.instance ?? 0;
    const controlPort = config.qt6uiControlPort + instance;
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-qt6ui-"));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FANCY_QT6UI_E2E_PORT: String(controlPort),
      // Same isolation contract as the Tauri client: fresh config dir per
      // instance (no real saved servers / identities).
      FANCY_E2E_DATA_DIR: dataDir,
    };
    // The Qt (MinGW) runtime DLLs are not on the ambient PATH - and worse,
    // stray MSVC Qt6 DLLs from unrelated tools may be. Prepend the kit's bin
    // dir so the loader resolves the right ones.
    if (process.platform === "win32") {
      env.PATH = `${config.qtBinDir};${env.PATH ?? ""}`;
    }

    const proc = spawn(config.qt6uiBin, [], { env, stdio: "ignore" });
    const failed = new Promise<never>((_, reject) => {
      proc.once("error", (e) => reject(new Error(`qt6ui failed to start: ${e.message}`)));
      proc.once("exit", (code) => reject(new Error(`qt6ui exited early (code ${code})`)));
    });

    try {
      const sock = await Promise.race([connectControl(controlPort), failed]);
      const client = new Qt6UiClient(proc, sock, dataDir);
      proc.removeAllListeners("error");
      proc.removeAllListeners("exit");
      return client;
    } catch (e) {
      killTree(proc.pid);
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      throw e;
    }
  }

  /** Send one command line and await its single reply line. */
  private send(cmd: string, timeoutMs = 10000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(settle);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`qt6ui control: no reply to "${cmd}" within ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = (line: string): void => {
        clearTimeout(timer);
        resolve(line);
      };
      this.pending.push(settle);
      this.sock.write(`${cmd}\n`);
    });
  }

  private async sendOk(cmd: string): Promise<void> {
    const reply = await this.send(cmd);
    if (reply !== "ok") throw new Error(`qt6ui control: "${cmd}" -> ${reply}`);
  }

  /** Connect to a server (drives Backend.connect_to_server, like the UI). */
  async connect(host: string, port: number, username: string, password = ""): Promise<void> {
    await this.sendOk(`connect ${host} ${port} ${username}${password ? ` ${password}` : ""}`);
  }

  /** Disconnect (drives Backend.disconnect_from_server, like the UI button). */
  async disconnect(): Promise<void> {
    await this.sendOk("disconnect");
  }

  /** The Backend's `status` property ("connecting", "connected", ...). */
  async status(): Promise<string> {
    const reply = await this.send("status");
    if (!reply.startsWith("status ")) throw new Error(`qt6ui control: status -> ${reply}`);
    return reply.slice("status ".length);
  }

  /** Poll until `status` reports `want` or the timeout elapses. */
  async waitForStatus(want: string, timeoutMs = 20000): Promise<void> {
    const start = Date.now();
    let last = "";
    while (Date.now() - start < timeoutMs) {
      last = await this.status();
      if (last === want) return;
      await delay(250);
    }
    throw new Error(`qt6ui: status stayed "${last}" (wanted "${want}") after ${timeoutMs}ms`);
  }

  /** Kill the app and remove its isolated data dir. */
  async close(): Promise<void> {
    this.sock.destroy();
    killTree(this.proc.pid);
    try {
      rmSync(this.dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Connect to the app's control port, retrying while the app boots (the
 * listener starts from QML Component.onCompleted, a second or two in).
 */
async function connectControl(port: number, timeoutMs = 20000): Promise<net.Socket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const sock = net.connect({ host: "127.0.0.1", port }, () => resolve(sock));
        sock.once("error", reject);
      });
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`qt6ui control port ${port} not reachable after ${timeoutMs}ms`);
      }
      await delay(250);
    }
  }
}
