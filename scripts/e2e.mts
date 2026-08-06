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
import { existsSync, statSync } from "node:fs";
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

/** Every test file, minus the ones that bring their own server. */
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
    .filter((file) => !PRIVATE_SERVER.includes(file));
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
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
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

/** What is about to be measured, so a run can be read back and believed. */
function announce(): void {
  for (const [what, where] of [
    ["client", config.appBin],
    ["starling", process.env.E2E_STARLING_BIN ??
      path.join(repoRoot, "vendor", "starling", "target", "release", "starling.exe")],
  ] as const) {
    if (!existsSync(where)) {
      console.error(`e2e: no ${what} binary at ${where}`);
      process.exit(1);
    }
    console.log(`e2e: ${what}  ${where}  (built ${statSync(where).mtime.toISOString()})`);
  }
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
  await server.stop();
  console.log("e2e: Starling stopped");
}
process.exit(code);
