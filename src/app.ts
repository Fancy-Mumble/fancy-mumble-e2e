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
import { SidebarPage } from "./pages/sidebar.page";
import { CalendarPage } from "./pages/calendar.page";
import { FriendsPage } from "./pages/friends.page";
import { AdminPage } from "./pages/admin.page";
import { StreamPage } from "./pages/stream.page";

export interface LaunchOptions {
  /**
   * Distinct index per concurrent client. Drives both the tauri-driver port
   * (base + instance) and a separate app data directory, so two clients hold
   * independent identities/certs/saved-servers.
   */
  instance?: number;
  /**
   * Window title to auto-select for screen capture (Windows only). Lets the
   * test drive the *current* build, whose `getDisplayMedia` opens a native OS
   * picker Selenium can't touch: WebView2 resolves it out-of-band via the
   * `--auto-select-desktop-capture-source=<title>` Chromium flag. Ignored by
   * the new Rust-native picker (which is driven through the DOM instead).
   */
  captureWindowTitle?: string;
}

/**
 * Build an environment that points the app at an isolated data directory.
 * Tauri keys its app-data location off the OS user profile dirs, so per-test
 * overrides of HOME/XDG (POSIX) or APPDATA/LOCALAPPDATA (Windows) give each
 * launched client a clean, separate profile.
 */
function makeIsolatedEnv(dataDir: string, captureWindowTitle?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Auto-select a desktop-capture source for the *current* build's
  // getDisplayMedia (Windows/WebView2 only): pass the Chromium flag through the
  // env var WebView2 reads for extra browser args. Quoted so titles with spaces
  // match. The new Rust picker ignores this.
  if (captureWindowTitle && process.platform === "win32") {
    const extra = `--auto-select-desktop-capture-source="${captureWindowTitle}"`;
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
      ? `${env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS} ${extra}`
      : extra;
  }
  // Isolate the Rust-side app data root (certs, identities, pchat seeds, signal
  // state). Tauri's app_data_dir() ignores APPDATA/HOME on Windows (OS
  // known-folder API), so without this every instance would share ONE cert /
  // Signal identity. The client's e2e_data_dir() reads this env var. Use the
  // same dir the JS plugin-store shim isolates into (see applyTestMode).
  const appDataRoot = path.join(dataDir, "store");
  mkdirSync(appDataRoot, { recursive: true });
  env.FANCY_E2E_DATA_DIR = appDataRoot;
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
  readonly sidebar: SidebarPage;
  readonly calendar: CalendarPage;
  readonly friends: FriendsPage;
  readonly admin: AdminPage;
  readonly stream: StreamPage;

  private constructor(
    readonly driver: WebDriver,
    private readonly proc: ChildProcess,
    private readonly dataDir: string,
  ) {
    this.connect = new ConnectPage(driver);
    this.chat = new ChatPage(driver);
    this.sidebar = new SidebarPage(driver);
    this.calendar = new CalendarPage(driver);
    this.friends = new FriendsPage(driver);
    this.admin = new AdminPage(driver);
    this.stream = new StreamPage(driver);
  }

  /** The isolated plugin-store directory for this client (diagnostics/tests). */
  get storeDir(): string {
    return path.join(this.dataDir, "store");
  }

  /**
   * Generate this instance's "default" client certificate in its isolated data
   * dir. With per-instance FANCY_E2E_DATA_DIR isolation the dir starts empty, so
   * without this the client connects cert-less and has NO Signal identity
   * (empty cert hash) - breaking signal_v1 key distribution. generate_certificate
   * is idempotent, so reconnects keep the same identity.
   */
  async ensureDefaultCert(): Promise<void> {
    const result = await this.driver.executeAsyncScript<string>(`
      const cb = arguments[arguments.length - 1];
      const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv) { cb('no-invoke'); return; }
      inv('generate_certificate', { label: 'default' }).then(() => cb('ok')).catch((e) => cb('err:' + e));
    `);
    if (result !== "ok") {
      throw new Error(`ensureDefaultCert failed: ${result}`);
    }
  }

  /**
   * Turn on the app's file logging (logs land in the REAL OS log dir,
   * `%LOCALAPPDATA%/com.fancymumble.app/logs` - Tauri resolves known
   * folders via the OS API, ignoring the isolated env vars). Lets tests
   * read backend tracing (e.g. screenshare pipeline timings) post-run.
   */
  async enableFileLogging(): Promise<void> {
    const result = await this.driver.executeAsyncScript<string>(`
      const cb = arguments[arguments.length - 1];
      const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv) { cb('no-invoke'); return; }
      inv('set_log_to_file', { enabled: true }).then(() => cb('ok')).catch((e) => cb('err:' + e));
    `);
    if (result !== "ok") {
      throw new Error(`enableFileLogging failed: ${result}`);
    }
  }

  static async launch(opts: LaunchOptions = {}): Promise<TauriApp> {
    const instance = opts.instance ?? 0;
    // Two ports per instance: tauri-driver listens on `port`, msedgedriver/
    // WebKitWebDriver binds `nativePort`. They must not overlap across instances.
    const port = config.driverPort + instance * 2;
    const nativePort = port + 1;
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "fancy-e2e-"));
    const env = makeIsolatedEnv(dataDir, opts.captureWindowTitle);

    const proc = await startTauriDriver(port, nativePort, env);
    try {
      const driver = await buildWebDriver(port, config.appBin);
      const app = new TauriApp(driver, proc, dataDir);
      await app.waitDomReady();
      await app.applyTestMode();
      await app.ensureDefaultCert();
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
        // The webview briefly reports about:blank before the app's custom-
        // protocol page loads; wait for the real app URL AND a mounted React
        // root so getCurrentUrl()/navigation in applyTestMode are reliable.
        const url = await this.driver.getCurrentUrl();
        if (!/^https?:\/\//.test(url)) return false;
        return (
          (await this.driver.executeScript(
            "return document.readyState === 'complete' && !!document.getElementById('root') && document.getElementById('root').childElementCount > 0",
          )) === true
        );
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
    // Relocate the Tauri plugin-store into an isolated dir so the app starts
    // from fresh/mock settings (no real saved servers, default preferences).
    const storeDir = path.join(this.dataDir, "store");
    mkdirSync(storeDir, { recursive: true });
    await this.driver.executeScript(
      `try {
         window.localStorage.setItem('fancy-e2e', '1');
         window.localStorage.setItem('mumble-language', 'en');
         window.localStorage.setItem('fancy-e2e-data-dir', arguments[0]);
       } catch (e) { /* ignore */ }`,
      storeDir.replace(/\\/g, "/"),
    );
    // Navigate to the app root so the flags take effect and we leave any
    // first-run /welcome route. Resolve the root in Node and use WebDriver's
    // get() rather than an in-page location.assign('/') (which the Tauri
    // webview rejects with "'' is not a valid URL").
    const current = await this.driver.getCurrentUrl();
    let root = current;
    try {
      root = new URL("/", current).href;
    } catch {
      /* fall back to reloading the current URL */
    }
    await this.driver.get(root);
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
