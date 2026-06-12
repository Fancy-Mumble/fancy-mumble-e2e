import { spawnSync } from "node:child_process";

/**
 * Kill a process and its whole subtree. tauri-driver spawns the native
 * WebDriver (and the app) as children, so a plain `kill(pid)` would orphan
 * them. On Windows we use `taskkill /T`; on POSIX we signal the process
 * group (the driver is spawned `detached`, giving it its own group).
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
