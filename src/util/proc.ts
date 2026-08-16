import { spawnSync } from "node:child_process";

/** Block the thread; `killTree` is synchronous and used from `after` hooks. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether a process (or group) still exists. Signal 0 only tests for it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal a process group, falling back to the bare pid. */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Kill a process and its whole subtree. tauri-driver spawns the native
 * WebDriver (and the app) as children, so a plain `kill(pid)` would orphan
 * them. On Windows we use `taskkill /T`; on POSIX we signal the process
 * group (the driver is spawned `detached`, giving it its own group).
 *
 * SIGTERM is asked first and SIGKILL follows if the process is still there.
 * Starling used to ignore the polite signal in effect - it drained, then sat
 * on the streams its own services were waiting to see closed - and leaked a
 * server per run, a dozen of them by the end of a working day, each holding
 * its data dir. It exits in milliseconds now (`starling-runtime`'s drain), so
 * the grace period is for processes that shut down cleanly and the escalation
 * is what it always should have been: the thing that never has to happen.
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  signal(pid, "SIGTERM");
  for (let waited = 0; waited < 2000; waited += 100) {
    sleepSync(100);
    if (!alive(pid)) return;
  }
  signal(pid, "SIGKILL");
}
