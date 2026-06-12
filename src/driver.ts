import { spawn, type ChildProcess } from "node:child_process";
import { Agent } from "node:http";
import { Capabilities, WebDriver } from "selenium-webdriver";
import * as http from "selenium-webdriver/http";
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
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const args = ["--port", String(port)];
  if (config.nativeDriver) args.push("--native-driver", config.nativeDriver);

  const proc = spawn(config.tauriDriverBin, args, {
    env,
    stdio: "inherit",
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

  // tauri-driver mishandles HTTP keep-alive: selenium's default keep-alive
  // agent triggers a flood of "connection closed before message completed"
  // errors and flaky/failed sessions. Use a fresh connection per request.
  const agent = new Agent({ keepAlive: false });
  const client = new http.HttpClient(`http://127.0.0.1:${port}`, agent);
  const executor = new http.Executor(Promise.resolve(client));

  // The session POST can hang indefinitely when tauri-driver can't reach the
  // native driver (e.g. msedgedriver/WebView2 version mismatch on Windows).
  // Bound it so we fail fast with an actionable message instead of hanging
  // until the test runner cancels with an opaque error.
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `WebDriver session creation timed out after ${config.sessionTimeout}ms on port ${port}. ` +
              `tauri-driver could not establish a session with the native driver. On Windows this is ` +
              `usually an msedgedriver/WebView2 version mismatch - reinstall via ` +
              `scripts/install-msedgedriver.ps1 (it now matches the WebView2 Runtime).`,
          ),
        ),
      config.sessionTimeout,
    );
    t.unref?.();
  });

  // createSession returns the driver synchronously and establishes the session
  // lazily; getSession() forces and awaits the actual NEW_SESSION handshake so
  // the timeout above can bound it.
  const driver = WebDriver.createSession(executor, caps);
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
