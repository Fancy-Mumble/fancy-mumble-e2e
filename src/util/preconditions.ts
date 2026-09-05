import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { isStarling } from "./suite-server";

/**
 * Preconditions a suite needs before it can measure anything.
 *
 * # Why this exists
 *
 * A suite that cannot pass on this machine should say so in milliseconds, not
 * spend minutes proving it. Before these gates, a run against a server without
 * the calendar plugin still drove two clients through a full launch and then
 * sat on a 15 s element wait per assertion — 588 s of one sweep (66% of all
 * in-test time) was failing tests burning timeouts for conclusions that were
 * knowable up front.
 *
 * Worse than the time: the score lied. "Fails" from a missing container, a
 * missing `.so` and an unimplemented server plugin all landed in the same
 * number as real defects, so no amount of fixing moved it visibly. A gated
 * suite skips **with a reason that names the fix**, which keeps the failure
 * count honest — every red left is a real defect.
 *
 * # How to use one
 *
 * Every gate returns a skip reason, or `false` when the precondition holds -
 * exactly the shape `describe`'s `skip` option takes:
 *
 * ```ts
 * describe("calendar: ...", { skip: pluginMissing("fancy-calendar") }, () => { ... });
 * ```
 *
 * They run at module load, so they must stay synchronous and cheap. Probes are
 * memoised per process; a per-file runner pays each one once.
 */

/** A reason to skip, or `false` when the suite can run. */
export type Gate = string | false;

const memo = new Map<string, Gate>();
function once(key: string, probe: () => Gate): Gate {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const value = probe();
  memo.set(key, value);
  return value;
}

// -- Artifact gates ---------------------------------------------------
//
// The client is assembled from three separate builds, and the two optional
// ones fail *silently*: a missing bridge degrades to "E2E unavailable" rather
// than erroring, so ten suites went red for an artifact reason that looked
// like a server bug. `scripts/build-client.sh` produces a complete artifact;
// these gates make an incomplete one say so.

/** The Signal bridge must sit next to the binary (the loader looks there). */
export function bridgeMissing(): Gate {
  return once("bridge", () => {
    const lib = process.platform === "win32" ? "signal_bridge.dll" : "libsignal_bridge.so";
    const beside = path.join(path.dirname(config.appBin), lib);
    return existsSync(beside) || existsSync(path.join(path.dirname(config.appBin), "signal-bridge", lib))
      ? false
      : `${lib} is not next to the client binary, so the client runs with no Signal ` +
        `bridge and every E2E assertion fails for a build reason. Build it with ` +
        `\`scripts/build-client.sh\`.`;
  });
}

/**
 * Discord rich presence needs a client built after the feature landed.
 *
 * Same reasoning as the artifact gates above, and the same failure shape: a
 * stale binary answers `presence_set_enabled` with "Command not found", which
 * fails every case in the suite and reads exactly like a broken feature. This
 * turns it into one skip that names the rebuild.
 */
export function presenceUnsupported(): Gate {
  return once("presence", () => {
    if (!existsSync(config.appBin)) {
      return `the client binary is missing at ${config.appBin}. Build it with \`scripts/build-client.sh\`.`;
    }
    return binaryContains(config.appBin, "presence_set_enabled")
      ? false
      : `this client build predates Discord rich presence - it registers no ` +
        `\`presence_set_enabled\` command, so every case here would fail for a build ` +
        `reason rather than a product one. Rebuild with \`scripts/build-client.sh\`.`;
  });
}

/**
 * Whether a (large, binary) file contains an ASCII needle.
 *
 * Chunked with an overlap rather than read whole: the debug client binary is
 * ~800 MB and `readFileSync` on it would cost more than the suite it gates.
 */
export function binaryContains(file: string, needle: string): boolean {
  const pattern = Buffer.from(needle, "latin1");
  const chunkSize = 4 * 1024 * 1024;
  const overlap = pattern.length - 1;
  const buffer = Buffer.alloc(chunkSize + overlap);
  const fd = openSync(file, "r");
  try {
    let carried = 0;
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, carried, chunkSize, position);
      if (read === 0) return false;
      position += read;
      const end = carried + read;
      if (buffer.subarray(0, end).includes(pattern)) return true;
      // Carry the tail forward so a match straddling a chunk boundary is
      // still seen on the next pass.
      carried = Math.min(overlap, end);
      buffer.copy(buffer, 0, end - carried, end);
    }
  } finally {
    closeSync(fd);
  }
}

/** The minimal Qt client is a workspace-excluded crate, built separately. */
export function qt6uiMissing(): Gate {
  return once("qt6ui", () =>
    existsSync(config.qt6uiBin)
      ? false
      : `qt6ui is not built at ${config.qt6uiBin}. Build it with ` +
        `\`scripts/build-client.sh\` (it is skipped by SKIP_QT6UI=1).`,
  );
}

/**
 * Sharing the desktop's audio needs PipeWire and a sink whose monitor has
 * something on it, so the suite plays a tone through the machine's speakers.
 * That is audible to whoever is sitting there, which is why it is opt-in
 * rather than part of an ordinary run.
 */
export function desktopAudioShareUnavailable(): Gate {
  return once("desktop-audio", () => {
    if (!process.env.E2E_DESKTOP_AUDIO) {
      return "desktop-audio sharing is opt-in: set E2E_DESKTOP_AUDIO=1 (it plays " +
        "a short tone on this machine's default output).";
    }
    if (process.platform !== "linux") {
      return "desktop-audio capture is implemented for Linux/PipeWire so far.";
    }
    try {
      execFileSync("pw-play", ["--help"], { stdio: "ignore", timeout: 8000 });
      return false;
    } catch {
      return "the tone this suite plays needs `pw-play` (PipeWire) on PATH.";
    }
  });
}

/** The checkerboard helper the screen-share fidelity suites capture. */
export function tkinterMissing(): Gate {
  return once("tkinter", () => {
    const python = process.env.E2E_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    try {
      execFileSync(python, ["-c", "import tkinter"], { stdio: "ignore", timeout: 8000 });
      return false;
    } catch {
      return `the checkerboard helper needs python3 + Tkinter (Linux: ` +
        `\`sudo apt install python3-tk\`), which draws the window these tests capture.`;
    }
  });
}

/**
 * ENTIRE-SCREEN capture needs a session a test can drive.
 *
 * Window capture and whole-screen capture fail differently on a Wayland
 * desktop, so they gate separately:
 *
 *   - A **window** is capturable through XWayland: the media suites run their
 *     clients with an X11 identity (see `util/capture-env.ts`), xcap takes its
 *     xcb path, and `XGetImage` on another client's window returns real
 *     pixels. Verified on this rig.
 *   - The **root window** is not. XWayland's root is a bounding box no
 *     compositor paints into, and `XGetImage` on it fails with `BadMatch`
 *     (X error 8, opcode 73) - so an "entire screen" share captures nothing
 *     no matter how the client is configured.
 *
 * The other path to a whole screen is the portal, and its dialog is drawn by
 * the compositor: WebDriver cannot see it, and `PortalSession::open` waits on
 * it unbounded. So on a Wayland session this suite cannot be measured at all,
 * which is a fact about the desktop rather than a defect in the product.
 */
export function entireScreenCaptureUnavailable(): Gate {
  return once("entire-screen", () => {
    if (process.platform !== "linux") return false;
    const wayland =
      (process.env.XDG_SESSION_TYPE ?? "").toLowerCase() === "wayland" ||
      Boolean(process.env.WAYLAND_DISPLAY);
    return wayland
      ? `this is a Wayland session, where an entire-screen capture is not ` +
        `reachable from a test: XWayland's root window cannot be read ` +
        `(XGetImage -> BadMatch), and the portal route draws a compositor ` +
        `dialog WebDriver cannot answer. Window shares are unaffected. Run ` +
        `this suite from an X11 session (or a nested X server) to measure it.`
      : false;
  });
}

// -- Local infrastructure gates ---------------------------------------

/** Whether an HTTP service answers, synchronously (see `serverReachable`). */
function httpReachable(url: string, timeoutMs = 2500): boolean {
  const probe = `
    const url = new URL(process.argv[1]);
    const http = require("node:" + (url.protocol === "https:" ? "https" : "http"));
    const req = http.get(url, (res) => { res.resume(); process.exit(0); });
    req.setTimeout(Number(process.argv[2]), () => { req.destroy(); process.exit(1); });
    req.once("error", () => process.exit(1));
  `;
  try {
    execFileSync(process.execPath, ["-e", probe, url, String(timeoutMs)], {
      stdio: "ignore",
      timeout: timeoutMs + 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gate a suite on a local service being up.
 *
 * `howToStart` is the whole point: the message a developer reads should name
 * the command that makes the suite run, not merely state that a fetch failed.
 */
export function serviceMissing(url: string, what: string, howToStart: string): Gate {
  return once(`http:${url}`, () =>
    httpReachable(url) ? false : `${what} is not reachable at ${url}. Start it with: ${howToStart}`,
  );
}

/** The admin UI (channelviewer compose profile). */
export function adminUiMissing(): Gate {
  return serviceMissing(
    "http://127.0.0.1:5007",
    "the admin UI",
    'docker compose -f fixtures/docker-compose.e2e.yml --profile channelviewer up -d --wait',
  );
}

/** The channelviewer Flask API (channelviewer compose profile). */
export function channelViewerMissing(): Gate {
  return serviceMissing(
    "http://127.0.0.1:5005",
    "the channel viewer API",
    'docker compose -f fixtures/docker-compose.e2e.yml --profile channelviewer up -d --wait',
  );
}

/** mumble-user-manager's API + its mail catcher. */
export function userManagerMissing(): Gate {
  return (
    serviceMissing(config.userManagerUrl, "the user-manager API", "its own compose stack (see fixtures/LOCAL-STACK.md)") ||
    serviceMissing(config.mailpitUrl, "the Mailpit catcher", "its own compose stack (see fixtures/LOCAL-STACK.md)")
  );
}

/** A named Docker container (the murmur fixture the parity suites drive). */
export function containerMissing(name: string, howToStart: string): Gate {
  return once(`docker:${name}`, () => {
    try {
      const out = execFileSync("docker", ["ps", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
        encoding: "utf8",
        timeout: 8000,
      });
      return out.includes(name) ? false : `the ${name} container is not running. Start it with: ${howToStart}`;
    } catch {
      return `Docker is not available, so the ${name} container cannot be checked. Start it with: ${howToStart}`;
    }
  });
}

// -- Server capability gates -------------------------------------------

/**
 * Gate a suite on a server-side plugin the server under test may not have.
 *
 * Starling implements no Fancy plugins yet — `friends.open`/`friends.room` and
 * the calendar surface appear nowhere in its source — so those suites measure
 * an unimplemented feature rather than a defect, and belong on the roadmap
 * rather than in the failure count.
 *
 * Deliberately declared rather than probed: the server advertises plugins to a
 * *connected client*, and launching one costs ~16 s before a gate could read
 * it. `E2E_SERVER_PLUGINS` is the switch to flip the day Starling ships one:
 *
 * ```sh
 * E2E_SERVER_PLUGINS=fancy-calendar,fancy-friends npm run e2e
 * ```
 *
 * Against murmur + the fancy plugin set, plugins are assumed present, because
 * that is the stack those suites were written against.
 */
export function pluginMissing(plugin: string): Gate {
  return once(`plugin:${plugin}`, () => {
    if (!isStarling()) return false;
    const declared = (process.env.E2E_SERVER_PLUGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return declared.includes(plugin)
      ? false
      : `Starling does not implement the ${plugin} plugin, so this suite measures a ` +
        `roadmap feature rather than a defect. Run it with ` +
        `E2E_SERVER_PLUGINS=${plugin} once the server ships it.`;
  });
}
