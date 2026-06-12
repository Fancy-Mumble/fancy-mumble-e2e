import { spawn, type ChildProcess } from "node:child_process";
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

  // tauri-driver exposes a standard WebDriver server; /status returns 200
  // once it (and its native driver) are ready to accept sessions.
  await waitForHttp(`http://127.0.0.1:${port}/status`, 20000);
  return proc;
}

/** Open a WebDriver session against a running tauri-driver, launching the app. */
export async function buildWebDriver(port: number, appBin: string): Promise<WebDriver> {
  const caps = new Capabilities();
  caps.set("tauri:options", { application: appBin });
  caps.setBrowserName("wry");
  return await new Builder()
    .usingServer(`http://127.0.0.1:${port}/`)
    .withCapabilities(caps)
    .build();
}
