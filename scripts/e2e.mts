/**
 * Run the e2e suite against Starling.
 *
 * `vendor/server` is obsolete, so this replaces the Docker-compose lifecycle
 * `run-local.ps1` wrapped: one Starling for the whole run, started before the
 * tests and stopped after, on the port the client actually dials.
 *
 * # What it does not do
 *
 * Build anything. A run that quietly rebuilt would hide the trap that has cost
 * this suite the most time: a stale release binary, passing tests against code
 * from days ago. Both binaries are named in the output at start-up, with their
 * timestamps, so a run can be read back and trusted.
 *
 * Usage:
 *   node --import tsx scripts/e2e.mts [file ...]
 *   node --import tsx scripts/e2e.mts --private   # only the private-server files
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StarlingServer } from "../src/util/starling";
import { config } from "../src/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Files that start a Starling of their own and read its log.
 *
 * They cannot run beside the shared server: it owns 64738, and a second
 * instance's voice service cannot bind the same UDP port — the symptom is
 * `no in-process service named "voice"` and a gateway retrying for the whole
 * test. So they get their own pass, with nothing else listening.
 */
const PRIVATE_SERVER = [
  "src/tests/starling-refused-login.multiclient.test.ts",
  "src/tests/starling-voice.multiclient.test.ts",
];

/**
 * Files this run refuses to start, by basename, from `E2E_SKIP`.
 *
 * The suite's own preconditions skip what a machine cannot do, but they cannot
 * see what a machine does *badly*: the screen-share fps floors are real
 * assertions that a software-rendered display fails on merit. Named here, they
 * stay opt-out for the nightly and mandatory everywhere else.
 *
 *   E2E_SKIP=screenshare.gpu.test.ts,screenshare.performance.test.ts
 */
const skipped = new Set(
  (process.env.E2E_SKIP ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);

/** Every test file, minus the ones that bring their own server or are skipped. */
function sharedFiles(): string[] {
  const listing = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(require('node:fs').readdirSync('src/tests').join('\\n'))"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return listing.stdout
    .split("\n")
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `src/tests/${name}`)
    .filter((file) => !PRIVATE_SERVER.includes(file))
    .filter((file) => !skipped.has(path.basename(file)));
}

/**
 * Run `node --test` over `files`, and hand back its exit code.
 *
 * `operatorApi` is passed through the environment rather than written into
 * `config.ts`, because the port is chosen at start-up: the suite has to be
 * told where this run's server is, and a hard-coded 8081 is the thing that
 * broke when two runs shared a machine.
 */
function runTests(files: string[], operatorApi?: string): Promise<number> {
  return new Promise((resolve) => {
    // A ceiling per test, so one wedged test cannot hold the whole run. A
    // tauri-driver that fails to rebind its port leaves a test waiting on a
    // WebDriver session that never arrives, and node:test has no timeout of its
    // own — the run then sits for hours on one file. The default clears the
    // slowest real tests (audio resampling, voice fidelity, ~45 s) with room to
    // spare, and E2E_TEST_TIMEOUT raises it where legitimate work runs longer.
    const testTimeout = process.env.E2E_TEST_TIMEOUT ?? "240000";
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "--test", "--test-concurrency=1", `--test-timeout=${testTimeout}`, ...files],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          E2E_SERVER_IMPL: "starling",
          ...(operatorApi ? { E2E_OPERATOR_API_URL: operatorApi } : {}),
        },
      },
    );
    proc.once("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * The commit a tree is at, plus a `+dirty` marker for uncommitted changes.
 *
 * A sweep is evidence about a *state*, and a state that cannot be named cannot
 * be compared to the next one. Two sweeps that disagree are only interesting
 * once you know whether the code differed - the 2026-08-08 session lost hours
 * to a "regression" that was an uncommitted tree plus a missing build artifact.
 */
function describeTree(dir: string): string {
  try {
    const at = (args: string[]) =>
      spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout.trim();
    const head = at(["rev-parse", "--short", "HEAD"]);
    if (!head) return "no git";
    return at(["status", "--porcelain"]) ? `${head}+dirty` : head;
  } catch {
    return "no git";
  }
}

/** What is about to be measured, so a run can be read back and believed. */
function announce(): void {
  const starlingExe = process.platform === "win32" ? "starling.exe" : "starling";
  for (const [what, where] of [
    ["client", config.appBin],
    ["starling", process.env.E2E_STARLING_BIN ??
      path.join(repoRoot, "vendor", "starling", "target", "debug", starlingExe)],
  ] as const) {
    if (!existsSync(where)) {
      console.error(`e2e: no ${what} binary at ${where}`);
      process.exit(1);
    }
    console.log(`e2e: ${what}  ${where}  (built ${statSync(where).mtime.toISOString()})`);
  }
  // The trees those binaries came from, and the harness driving them.
  console.log(
    `e2e: trees  harness ${describeTree(repoRoot)}` +
      `  client ${describeTree(path.join(repoRoot, "vendor", "client"))}` +
      `  starling ${describeTree(path.join(repoRoot, "vendor", "starling"))}` +
      `  waits ${config.waitTimeout}ms`,
  );
  // A run that quietly covered less than it looks like is worse than a red one.
  if (skipped.size) console.log(`e2e: skipping  ${[...skipped].join(" ")}`);
}

const argv = process.argv.slice(2);
const only = argv.filter((arg) => !arg.startsWith("--"));
announce();

if (argv.includes("--private")) {
  // No shared server: these start their own.
  process.exit(await runTests(only.length ? only : PRIVATE_SERVER));
}

const files = only.length ? only : sharedFiles();
console.log(`e2e: starting Starling for ${files.length} file(s)`);
const server = await StarlingServer.start();
const operatorApi = `http://127.0.0.1:${server.operatorPort}`;
console.log(
  `e2e: Starling listening on ${config.serverHost}:${config.serverPort}` +
    `, operator API on ${operatorApi}`,
);

let code = 1;
try {
  code = await runTests(files, operatorApi);
} finally {
  // Always, including on a thrown start-up error: a server left running holds
  // 64738 and the next run fails to bind, several minutes and one confusing
  // failure away from the cause.
  // The server's own account of the run, kept where the TAP is.
  //
  // It was discarded until now: a red suite left the harness's story and none
  // of the server's, so "the message never arrived" and "the message arrived
  // and was refused" looked identical from outside. Written always, not only
  // on failure - a green run's log is what the next red one gets compared to.
  try {
    writeFileSync(path.join(repoRoot, ".tmp", "starling.log"), server.log, "utf8");
    console.log(`e2e: server log  ${path.join(repoRoot, ".tmp", "starling.log")}`);
  } catch {
    /* best effort: a missing log must not fail the run that produced it */
  }
  await server.stop();
  console.log("e2e: Starling stopped");
}
process.exit(code);
