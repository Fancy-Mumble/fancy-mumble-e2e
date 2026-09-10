import { type WebDriver } from "selenium-webdriver";

/**
 * Run a real Tauri command in the driven client and hand back its result.
 *
 * This is the suite's one bridge into the Rust half. It is deliberately kept
 * as a thin escape hatch for protocol features the UI does not expose with
 * stable controls (FancyWatchSync, the raw drawing command, the voice state
 * the tray and the global shortcut drive) - the command still executes in the
 * client and traverses the live server connection, so a test using it is
 * still testing the product.
 *
 * The call goes through `__TAURI_INTERNALS__.invoke` rather than the app's own
 * wrappers because that object is what the webview exposes; it is absent until
 * the app's bootstrap has run, which is reported as a failed command rather
 * than as a hang.
 *
 * Both outcomes come back inside an envelope. `executeAsyncScript` resolves
 * with whatever the callback is handed, so a rejected command and a command
 * that legitimately resolved with a string are indistinguishable without one -
 * and a thrown error inside the page would simply never call the callback,
 * turning a failure into a timeout.
 */
export async function tauriInvoke<T = unknown>(
  driver: WebDriver,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const envelope = await driver.executeAsyncScript<Envelope<T>>(
    `
    const cb = arguments[arguments.length - 1];
    const command = arguments[0];
    const args = arguments[1];
    const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (!inv) { cb({ __e2eError: 'no-invoke' }); return; }
    inv(command, args || {})
      .then((value) => cb({ __e2eValue: value }))
      .catch((error) => cb({ __e2eError: String(error) }));
    `,
    command,
    args,
  );
  if (envelope.__e2eError !== undefined) {
    throw new Error(`Tauri command ${command} failed: ${envelope.__e2eError}`);
  }
  return envelope.__e2eValue as T;
}

interface Envelope<T> {
  readonly __e2eValue?: T;
  readonly __e2eError?: string;
}
