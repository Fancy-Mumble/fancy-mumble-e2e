import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killTree } from "./proc";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (fancy-mumble-e2e/). `src/util` is two levels down. */
const repoRoot = path.resolve(thisDir, "..", "..");
const scriptPath = path.join(repoRoot, "fixtures", "checkerboard.py");

/** `python` on Windows, `python3` elsewhere; override with E2E_PYTHON. */
const pythonBin = process.env.E2E_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

export interface CheckerboardOptions {
  /** Window title (matched by the capture-source picker). Must be unique. */
  readonly title: string;
  /** 0 = green at cell(0,0), 1 = purple at cell(0,0). Distinguishes instances. */
  readonly phase: 0 | 1;
  readonly cols?: number;
  readonly rows?: number;
  readonly cell?: number;
  readonly x?: number;
  readonly y?: number;
  /** Flip the board's phase every N ms (OS-level motion for delivery-health
   *  tests - webview rAF animation throttles when the window is occluded). */
  readonly animateMs?: number;
  /** With animateMs: randomise every cell per tick (incompressible content
   *  that drives the encoder to real multi-Mbit/s output for load tests). */
  readonly noise?: boolean;
}

/** A running checkerboard helper window. */
export class CheckerboardWindow {
  readonly cols: number;
  readonly rows: number;

  private constructor(
    private readonly proc: ChildProcess,
    readonly title: string,
    readonly phase: 0 | 1,
    cols: number,
    rows: number,
  ) {
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * Spawn the Tk checkerboard window and resolve once it prints its
   * `checkerboard-ready` line (so the window exists before we try to capture
   * it). Rejects if the helper exits early (e.g. missing python3-tk / no display).
   */
  static async launch(opts: CheckerboardOptions): Promise<CheckerboardWindow> {
    const cols = opts.cols ?? 8;
    const rows = opts.rows ?? 6;
    const args = [
      scriptPath,
      "--title", opts.title,
      "--phase", String(opts.phase),
      "--cols", String(cols),
      "--rows", String(rows),
      "--cell", String(opts.cell ?? 64),
      "--x", String(opts.x ?? 120),
      "--y", String(opts.y ?? 120),
      "--animate-ms", String(opts.animateMs ?? 0),
      ...(opts.noise ? ["--noise"] : []),
    ];
    const proc = spawn(pythonBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onData = (buf: Buffer) => {
        if (!settled && buf.toString().includes("checkerboard-ready")) {
          settled = true;
          resolve();
        }
      };
      proc.stdout?.on("data", onData);
      let stderr = "";
      proc.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
      proc.once("error", (e) => {
        if (!settled) { settled = true; reject(new Error(`failed to spawn ${pythonBin}: ${e.message}`)); }
      });
      proc.once("exit", (code) => {
        if (!settled) {
          settled = true;
          reject(new Error(
            `checkerboard helper exited early (code=${code}) before becoming ready. ` +
            `Is python + Tkinter installed (Linux: apt-get install python3-tk) and a display available?\n${stderr}`,
          ));
        }
      });
      setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("checkerboard helper did not become ready within 10s")); }
      }, 10000).unref?.();
    });

    return new CheckerboardWindow(proc, opts.title, opts.phase, cols, rows);
  }

  /** Close the helper window. */
  close(): void {
    killTree(this.proc.pid);
  }
}
