import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ChildProcess } from "node:child_process";
import { type WebDriver } from "selenium-webdriver";
import { config } from "./config";
import { startTauriDriver, buildWebDriver } from "./driver";
import { killTree } from "./util/proc";
import { ConnectPage } from "./pages/connect.page";
import { ChatPage } from "./pages/chat.page";

export interface LaunchOptions {
  /**
   * Distinct index per concurrent client. Drives both the tauri-driver port
   * (base + instance) and a separate app data directory, so two clients hold
   * independent identities/certs/saved-servers.
   */
  instance?: number;
}

/**
 * Build an environment that points the app at an isolated data directory.
 * Tauri keys its app-data location off the OS user profile dirs, so per-test
 * overrides of HOME/XDG (POSIX) or APPDATA/LOCALAPPDATA (Windows) give each
 * launched client a clean, separate profile.
 */
function makeIsolatedEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === "win32") {
    env.APPDATA = path.join(dataDir, "Roaming");
    env.LOCALAPPDATA = path.join(dataDir, "Local");
    mkdirSync(env.APPDATA, { recursive: true });
    mkdirSync(env.LOCALAPPDATA, { recursive: true });
  } else {
    env.HOME = dataDir;
    env.XDG_CONFIG_HOME = path.join(dataDir, ".config");
    env.XDG_DATA_HOME = path.join(dataDir, ".local", "share");
    env.XDG_CACHE_HOME = path.join(dataDir, ".cache");
    for (const d of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) {
      mkdirSync(d, { recursive: true });
    }
  }
  return env;
}

/**
 * One launched FancyMumble client: owns a tauri-driver process, the WebDriver
 * session, and its isolated data dir. Exposes page objects for the views the
 * tests drive.
 */
export class TauriApp {
  readonly connect: ConnectPage;
  readonly chat: ChatPage;

  private constructor(
    readonly driver: WebDriver,
    private readonly proc: ChildProcess,
    private readonly dataDir: string,
  ) {
    this.connect = new ConnectPage(driver);
    this.chat = new ChatPage(driver);
  }

  static async launch(opts: LaunchOptions = {}): Promise<TauriApp> {
    const instance = opts.instance ?? 0;
    const port = config.driverPort + instance;
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-"));
    const env = makeIsolatedEnv(dataDir);

    const proc = await startTauriDriver(port, env);
    try {
      const driver = await buildWebDriver(port, config.appBin);
      const app = new TauriApp(driver, proc, dataDir);
      await app.waitDomReady();
      await app.applyTestMode();
      await app.connect.waitReady(config.connectTimeout);
      return app;
    } catch (e) {
      // Don't orphan tauri-driver (and its held port) when launch fails - that
      // would cascade into the next suite that reuses the same port.
      killTree(proc.pid);
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      throw e;
    }
  }

  private async waitDomReady(timeout = 30000): Promise<void> {
    await this.driver.wait(async () => {
      try {
        return (await this.driver.executeScript("return document.readyState")) === "complete";
      } catch {
        return false;
      }
    }, timeout);
  }

  /**
   * Turn on e2e test mode. The app reads two localStorage keys on boot:
   *   - `fancy-e2e=1`        -> skip the first-run welcome flow (deterministic DOM)
   *   - `mumble-language=en` -> force English so text/selectors are stable
   * We set them on the throwaway initial load, then navigate to the app root
   * so the flags take effect.
   */
  private async applyTestMode(): Promise<void> {
    await this.driver.executeScript(
      `try {
         window.localStorage.setItem('fancy-e2e', '1');
         window.localStorage.setItem('mumble-language', 'en');
       } catch (e) { /* ignore */ }
       window.location.assign('/');`,
    );
    await this.waitDomReady();
  }

  /** Shut down the session, kill the driver tree, and remove the data dir. */
  async close(): Promise<void> {
    try {
      await this.driver.quit();
    } catch {
      /* session may already be gone */
    }
    killTree(this.proc.pid);
    try {
      rmSync(this.dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
