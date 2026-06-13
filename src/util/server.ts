import { execFileSync } from "node:child_process";

const CONTAINER = process.env.E2E_SERVER_CONTAINER ?? "fancy-e2e-mumble";
const INI = process.env.E2E_SERVER_INI ?? "/data/mumble_server_config.ini";

/**
 * Set the server's SuperUser password on the running container.
 *
 * The mumble-docker entrypoint configures it via `mumble-server ... --foreground
 * --set-su-pw <pw>`, and the `--foreground` combination means the password does
 * not actually take effect (SuperUser auth then fails with "Wrong certificate or
 * password"). Running `--set-su-pw` on its own works, and the live server picks
 * the new hash up from the DB on the next auth - no restart needed. Call this
 * before any test that logs in as SuperUser.
 */
export function setSuperUserPassword(password: string): void {
  execFileSync(
    "docker",
    ["exec", CONTAINER, "mumble-server", "--ini", INI, "--set-su-pw", password],
    { stdio: "ignore" },
  );
}
