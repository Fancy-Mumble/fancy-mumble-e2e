import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

/** The minimal Qt client is a workspace-excluded crate, built separately. */
export function qt6uiMissing(): Gate {
  return once("qt6ui", () =>
    existsSync(config.qt6uiBin)
      ? false
      : `qt6ui is not built at ${config.qt6uiBin}. Build it with ` +
        `\`scripts/build-client.sh\` (it is skipped by SKIP_QT6UI=1).`,
  );
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
