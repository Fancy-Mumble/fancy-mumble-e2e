import { spawn, type ChildProcess } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Builder, Capabilities, type WebDriver } from "selenium-webdriver";
import { config } from "./config";
import { waitForHttp } from "./util/wait";

/**
 * Spawn a `tauri-driver` instance on `port`. tauri-driver is a thin
 * WebDriver proxy: it starts the platform's native WebDriver
 * (WebKitWebDriver on Linux, msedgedriver on Windows) and forwards the
 * Tauri-specific `tauri:options` capability to launch the app binary.
 *
 * `env` is inherited by the launched app, which is how we isolate two
 * concurrent clients onto separate data directories (see app.ts).
 */
export async function startTauriDriver(
  port: number,
  nativePort: number,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  // --native-port MUST differ from --port: tauri-driver listens on `port` and
  // hands the native driver (msedgedriver) `nativePort`. Its default native
  // port is 4445, so if `port` is left at 4445 the native driver fails to bind
  // (WSAEADDRINUSE) and the session floods with connection errors.
  const args = ["--port", String(port), "--native-port", String(nativePort)];
  if (config.nativeDriver) args.push("--native-driver", config.nativeDriver);

  // Route tauri-driver's (and the native driver's) noisy output to a log file
  // so the console isn't flooded with "connection closed" lines and the real
  // session error stays readable. Inspect .tmp/tauri-driver-<port>.log on
  // failure.
  const logDir = path.join(process.cwd(), ".tmp");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `tauri-driver-${port}.log`);
  const logFd = openSync(logPath, "w");
  console.error(`[tauri-driver] :${port} -> logging to ${logPath}`);

  const proc = spawn(config.tauriDriverBin, args, {
    env,
    stdio: ["ignore", logFd, logFd],
    // Own process group on POSIX so killTree() can signal the whole tree.
    detached: process.platform !== "win32",
  });
  proc.on("error", (e) => {
    console.error(
      `[tauri-driver] failed to spawn "${config.tauriDriverBin}": ${e.message}\n` +
        `Install it with: cargo install tauri-driver --locked`,
    );
  });

  // tauri-driver exposes a standard WebDriver server; /status returns 200 once
  // it (and its native driver) are ready. If it dies early - almost always a
  // missing native driver (msedgedriver / WebKitWebDriver) - fail fast with an
  // actionable message instead of waiting out the HTTP timeout.
  const ready = waitForHttp(`http://127.0.0.1:${port}/status`, 20000);
  const earlyExit = new Promise<never>((_, reject) => {
    proc.once("exit", (code, signal) =>
      reject(
        new Error(
          `tauri-driver exited early (code=${code}, signal=${signal}) before the ` +
            `WebDriver endpoint came up. The native WebDriver is almost certainly ` +
            `missing: Windows needs msedgedriver on PATH (or set E2E_NATIVE_DRIVER); ` +
            `Linux needs WebKitWebDriver (apt-get install webkit2gtk-driver).`,
        ),
      ),
    );
  });
  try {
    await Promise.race([ready, earlyExit]);
  } catch (e) {
    proc.removeAllListeners("exit");
    throw e;
  }
  return proc;
}

/** Open a WebDriver session against a running tauri-driver, launching the app. */
export async function buildWebDriver(port: number, appBin: string): Promise<WebDriver> {
  const caps = new Capabilities();
  caps.set("tauri:options", { application: appBin });
  caps.setBrowserName("wry");

  // The session POST can hang indefinitely when tauri-driver can't reach the
  // native driver. Bound it so we fail fast with an actionable message instead
  // of hanging until the test runner cancels with an opaque error.
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `WebDriver session creation timed out after ${config.sessionTimeout}ms on port ${port}. ` +
              `tauri-driver could not establish a session with the native driver - check ` +
              `.tmp/tauri-driver-${port}.log (e.g. msedgedriver bind/port errors).`,
          ),
        ),
      config.sessionTimeout,
    );
    t.unref?.();
  });

  // Default keep-alive client (reuses one connection); a non-keep-alive client
  // churns a fresh socket per request and can exhaust the Windows ephemeral
  // port pool (WSAENOBUFS / 10055). build() establishes the session lazily;
  // getSession() forces and awaits the NEW_SESSION handshake so the timeout
  // above can bound it.
  const driver = new Builder()
    .usingServer(`http://127.0.0.1:${port}/`)
    .withCapabilities(caps)
    .build();
  try {
    await Promise.race([driver.getSession(), timeout]);
    return driver;
  } catch (e) {
    // node:test can swallow before-hook rejections, so log the real cause.
    console.error(`[tauri-driver] WebDriver session creation failed on port ${port}:`, e);
    void driver.quit().catch(() => {});
    throw e;
  }
}
