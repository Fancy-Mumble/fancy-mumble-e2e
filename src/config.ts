import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (fancy-mumble-e2e/). `src/` is one level down. */
const repoRoot = path.resolve(thisDir, "..");

const exe = process.platform === "win32" ? "mumble-tauri.exe" : "mumble-tauri";

/**
 * Runtime configuration for the e2e suite. Everything is overridable via
 * environment variables so the same harness runs locally and in CI.
 */
export const config = {
  /**
   * Path to the built FancyMumble binary. Must be a build with embedded
   * assets (the `custom-protocol` feature / `cargo tauri build`), not the
   * Vite dev server. Defaults to the client submodule's release output.
   */
  appBin: process.env.E2E_APP_BIN ??
    path.join(repoRoot, "vendor", "client", "target", "release", exe),

  /** `tauri-driver` executable (on PATH after `cargo install tauri-driver`). */
  tauriDriverBin: process.env.E2E_TAURI_DRIVER ?? "tauri-driver",

  /**
   * Optional explicit native WebDriver for tauri-driver to proxy to
   * (`WebKitWebDriver` on Linux, `msedgedriver` on Windows). When unset,
   * tauri-driver resolves one from PATH.
   */
  nativeDriver: process.env.E2E_NATIVE_DRIVER,

  /** Base port for the first tauri-driver instance; instance N uses base+N. */
  driverPort: Number(process.env.E2E_DRIVER_PORT ?? "4445"),

  /** Mumble server the client connects to (the Docker fixture). */
  serverHost: process.env.E2E_SERVER_HOST ?? "127.0.0.1",
  serverPort: Number(process.env.E2E_SERVER_PORT ?? "64738"),

  /**
   * Path to the built minimal native Qt6 client (workspace-excluded crate;
   * see vendor/client/crates/qt6ui/README + build.ps1). Defaults to that
   * crate's debug output - it is built with its own `build.ps1`, not the
   * workspace `cargo build`.
   */
  qt6uiBin: process.env.E2E_QT6UI_BIN ??
    path.join(
      repoRoot, "vendor", "client", "crates", "qt6ui", "target", "debug",
      process.platform === "win32" ? "qt6ui.exe" : "qt6ui",
    ),

  /**
   * Qt (MinGW) kit bin dir prepended to PATH when launching qt6ui on
   * Windows: the runtime DLLs are not on the ambient PATH, and unrelated
   * tools may ship incompatible MSVC Qt6 DLLs that the loader would pick up.
   */
  qtBinDir: process.env.E2E_QT_BIN_DIR ?? "C:\\Qt\\6.11.1\\mingw_64\\bin",

  /** Base port for qt6ui's e2e control channel; instance N uses base+N. */
  qt6uiControlPort: Number(process.env.E2E_QT6UI_CONTROL_PORT ?? "4600"),

  /**
   * Starling's operator API - the admin plane that replaced Ice.
   *
   * Starling has no Ice and never will (`GAP-ANALYSIS.md` S6), so anything the
   * suite used to arrange by shelling into the murmur container is arranged
   * over this instead.
   */
  operatorApiUrl: process.env.E2E_OPERATOR_API_URL ?? "http://127.0.0.1:8081",

  /**
   * The bearer token for it. Matches `STARLING_ADMIN_TOKEN` in the compose
   * stack's env file; an operator API with no token configured refuses
   * everything, which is the fail-closed direction and not something to
   * default around.
   */
  operatorToken: process.env.E2E_OPERATOR_TOKEN ?? "e2e-token",

  /**
   * mumble-user-manager's API, which owns registration and profiles.
   *
   * Its compose stack runs the Starling the client connects to, so this is the
   * web front door of the same server `serverHost`/`serverPort` reach over the
   * Mumble protocol - not a second one.
   */
  userManagerUrl: process.env.E2E_USER_MANAGER_URL ?? "http://127.0.0.1:8080",

  /**
   * The mail catcher in that stack. Confirmation links are read out of it, so
   * the tests follow the same link a real user would click.
   */
  mailpitUrl: process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:8025",

  /** How long to wait for connect + post-connect bootstrap to finish (ms). */
  connectTimeout: Number(process.env.E2E_CONNECT_TIMEOUT ?? "45000"),

  /** How long to wait for the WebDriver session (app launch) before failing. */
  sessionTimeout: Number(process.env.E2E_SESSION_TIMEOUT ?? "30000"),

  /**
   * Default wait for a UI element to appear, in ms.
   *
   * A failing test costs roughly this much: it does not fail on an assertion,
   * it fails by waiting out the element it will never see. 15 s is chosen for
   * a loaded machine running three clients; drop it to ~8000 for a local
   * iteration loop, where the feedback matters more than the headroom.
   */
  waitTimeout: Number(process.env.E2E_WAIT_MS ?? "15000"),
} as const;
