import { execFileSync } from "node:child_process";
import { config } from "../config";

const CONTAINER = process.env.E2E_SERVER_CONTAINER ?? "fancy-e2e-mumble";
// The compose mounts our config here (MUMBLE_CUSTOM_CONFIG_FILE); --set-su-pw
// needs an ini that points at the right database to update the SuperUser hash.
const INI = process.env.E2E_SERVER_INI ?? "/config/mumble-server.ini";

/**
 * Set the SuperUser password on whichever server is under test.
 *
 * Two servers answer to that description and they are administered completely
 * differently, so this tries them in order:
 *
 * 1. **Starling**, over the operator API. It has no Ice and no container to
 *    shell into — its admin plane is HTTP (`GAP-ANALYSIS.md` S6), and
 *    `PUT /v1/accounts/0` is how the SuperUser's password is set.
 * 2. **murmur**, by running `--set-su-pw` inside the container.
 *
 * Starling first, because it is the server being ported to; the fallback keeps
 * the murmur parity runs working unchanged. Without the first branch every test
 * that logs in as SuperUser failed in `before` against a Starling deployment —
 * not because anything was wrong with it, but because the helper was talking to
 * a container that was not the server on the port the client dials.
 *
 * # murmur's own quirk, unchanged
 *
 * The mumble-docker entrypoint configures the password via
 * `mumble-server ... --foreground --set-su-pw <pw>`, and that combination means
 * it never takes effect (SuperUser auth then fails with "Wrong certificate or
 * password"). Running `--set-su-pw` on its own works, and the live server picks
 * the new hash up from the database on the next authentication — no restart.
 */
export function setSuperUserPassword(password: string): void {
  if (setSuperUserPasswordViaOperatorApi(password)) return;

  execFileSync(
    "docker",
    ["exec", CONTAINER, "mumble-server", "--ini", INI, "--set-su-pw", password],
    { stdio: "ignore" },
  );
}

/**
 * The Starling half of {@link setSuperUserPassword}; false if it is not there.
 *
 * Synchronous because its callers are, and they are `before` hooks in eleven
 * files that cannot be made async from here. `fetch` has no synchronous form,
 * so the request runs in a child Node process that this one waits for — no
 * dependency, and nothing to install on a machine that already runs the suite.
 */
function setSuperUserPasswordViaOperatorApi(password: string): boolean {
  const request = `
    const [url, token, password] = process.argv.slice(1);
    const response = await fetch(url + "/v1/accounts/0", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) process.exit(1);
  `;

  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", request, config.operatorApiUrl, config.operatorToken, password],
      { stdio: "ignore", timeout: 15000 },
    );
    return true;
  } catch {
    // Not reachable, not authorised, or not Starling. Either way the caller
    // falls through to the container, which is the only other thing this could
    // be talking to.
    return false;
  }
}

/**
 * Whether the server under test is still up. Used to assert it did not crash
 * (e.g. after deleting a parentless/detached channel, which previously
 * dereferenced a null destination and took murmur down).
 *
 * Starling answers on its operator API's health route; murmur is a container,
 * so its liveness is the container's. Checked in the same order and for the
 * same reason as {@link setSuperUserPassword}.
 */
export function isServerRunning(): boolean {
  if (operatorApiHealthy()) return true;

  try {
    const out = execFileSync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", CONTAINER],
      { encoding: "utf8" },
    );
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Whether Starling's operator API answers its own health route. */
function operatorApiHealthy(): boolean {
  const request = `
    const response = await fetch(process.argv[1] + "/healthz", {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) process.exit(1);
  `;

  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", request, config.operatorApiUrl], {
      stdio: "ignore",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}
