import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * A private X server for the capture suites.
 *
 * # Why a display of its own
 *
 * Screen-share tests are the only suites whose *subject* is the desktop, which
 * makes them the only ones a shared desktop can silently corrupt: another
 * agent's client window overlapping the board, a screensaver, a notification
 * toast - all of it lands in the captured frames. On this rig several sessions
 * drive clients on `:0` at once, so "what was on screen" is not a property the
 * test controls.
 *
 * A dedicated Xvfb also *restores* a capability the desktop took away.
 * XWayland's root window cannot be read (`XGetImage` -> `BadMatch`), so an
 * entire-screen share captures nothing there; a real X server has a real root
 * window, and both whole-screen and per-window capture work on it.
 *
 * # The window-list problem
 *
 * Xvfb ships no window manager, and window *enumeration* is a window-manager
 * service: `xcap` (like every enumerator) reads `_NET_CLIENT_LIST_STACKING`
 * from the root window, which nothing publishes when nothing manages windows.
 * Rather than pull in a WM for one property, {@link publishWindow} writes it -
 * xcap requests the property with `ATOM_NONE`, i.e. it accepts any type and
 * reinterprets the 32-bit values as window ids, so an `xprop`-written list is
 * indistinguishable from a real one.
 *
 * Focus, the other thing a WM provides, does not matter here: the capture
 * suites connect anonymously and every input they need is DOM-injected (see
 * `util/astral.ts`). A suite that types real keys would need more than this.
 */

/** Display number for the capture server; `:99` matches the runner's existing
 *  convention for per-instance Xvfb displays. */
const CAPTURE_DISPLAY = process.env.E2E_CAPTURE_DISPLAY ?? ":99";

/** Geometry big enough for two maximized clients plus a full-HD board. */
const GEOMETRY = process.env.E2E_CAPTURE_GEOMETRY ?? "2560x1440x24";

let resolved: string | null | undefined;

/** Whether a command exists on PATH. */
function have(bin: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The display the capture suites should run on, starting one if needed, or
 * `null` when this machine cannot provide it (no Xvfb, no xdotool/xprop).
 * Callers fall back to the ambient display, where window capture still works
 * through XWayland and only whole-screen capture is unavailable.
 *
 * Memoised, and the server is deliberately left running between suites: it
 * costs nothing idle, and a per-file runner would otherwise pay the start-up
 * for every file.
 */
export function captureDisplay(): string | null {
  if (resolved !== undefined) return resolved;
  resolved = start();
  return resolved;
}

function start(): string | null {
  if (process.platform !== "linux") return null;
  // Opt-in while the ambient-desktop path is the measured one: `E2E_XVFB=1`,
  // or naming a display explicitly with `E2E_CAPTURE_DISPLAY`.
  if (!process.env.E2E_XVFB && !process.env.E2E_CAPTURE_DISPLAY) return null;
  if (!have("Xvfb") || !have("xdotool") || !have("xprop")) return null;

  const socket = `/tmp/.X11-unix/X${CAPTURE_DISPLAY.replace(":", "")}`;
  if (existsSync(socket)) return CAPTURE_DISPLAY;

  const proc = spawn("Xvfb", [CAPTURE_DISPLAY, "-screen", "0", GEOMETRY, "-nolisten", "tcp"], {
    stdio: "ignore",
    detached: true,
  });
  proc.unref();

  // Wait for the socket rather than a fixed sleep: X is ready when it is
  // listening, and that is typically well under a second.
  try {
    execFileSync("sh", ["-c", `for i in $(seq 1 100); do [ -e ${socket} ] && exit 0; sleep 0.1; done; exit 1`], {
      timeout: 15000,
      stdio: "ignore",
    });
  } catch {
    return null;
  }
  return CAPTURE_DISPLAY;
}

/**
 * Make `title`'s window visible to source enumeration on the capture display.
 *
 * No-op when running on the ambient desktop, where the window manager already
 * publishes the list. Serialised through a promise chain because the property
 * is read-modify-written and suites launch their boards concurrently.
 */
let publishTurn: Promise<void> = Promise.resolve();
export function publishWindow(title: string): Promise<void> {
  const display = captureDisplay();
  if (!display) return Promise.resolve();
  publishTurn = publishTurn.then(() => {
    try {
      const ids = execFileSync("xdotool", ["search", "--name", title], {
        encoding: "utf8",
        env: { ...process.env, DISPLAY: display },
        timeout: 5000,
      })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (ids.length === 0) return;

      const existing = readClientList(display);
      const merged = [...new Set([...existing, ...ids.map((id) => `0x${Number(id).toString(16)}`)])];
      execFileSync(
        "xprop",
        [
          "-root",
          "-f", "_NET_CLIENT_LIST_STACKING", "32a",
          "-set", "_NET_CLIENT_LIST_STACKING", merged.join(", "),
        ],
        { env: { ...process.env, DISPLAY: display }, timeout: 5000, stdio: "ignore" },
      );
    } catch {
      /* enumeration is best-effort; the suite's own assertion reports the miss */
    }
  });
  return publishTurn;
}

/** Window ids currently published on `display`, as `0x...` strings. */
function readClientList(display: string): string[] {
  try {
    const out = execFileSync("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"], {
      encoding: "utf8",
      env: { ...process.env, DISPLAY: display },
      timeout: 5000,
    });
    const eq = out.indexOf("=");
    if (eq < 0) return [];
    return out
      .slice(eq + 1)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^0x[0-9a-f]+$/i.test(s));
  } catch {
    return [];
  }
}
