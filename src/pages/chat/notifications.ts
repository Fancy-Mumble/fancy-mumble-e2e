import { type WebDriver } from "selenium-webdriver";

/** One desktop notification as the app raised it. */
export interface CapturedNotification {
  readonly title: string;
  readonly body: string;
}

/**
 * The desktop notifications the app raises while a test drives it.
 *
 * Not a React component: the native notification IPC
 * (`plugin:notification|notify`) cannot be intercepted from the webview - its
 * `__TAURI_INTERNALS__.invoke` is locked non-writable - so the app mirrors
 * every notification onto a `fancy:desktop-notification` DOM event (see
 * `showDesktopNotification`), and this records those.
 */
export class DesktopNotifications {
  constructor(private readonly d: WebDriver) {}

  /**
   * Start recording. Install before the action that should notify; idempotent,
   * so a suite may call it per test without stacking listeners.
   */
  async installCapture(): Promise<void> {
    await this.d.executeScript(`
      window.__e2eNotifications = window.__e2eNotifications || [];
      if (!window.__e2eNotifyCapture) {
        window.__e2eNotifyCapture = function (e) {
          try {
            const d = e.detail || {};
            window.__e2eNotifications.push({ title: d.title || '', body: d.body || '' });
          } catch (err) { /* ignore */ }
        };
        window.addEventListener('fancy:desktop-notification', window.__e2eNotifyCapture);
      }
    `);
  }

  /** Everything captured since {@link installCapture}. */
  async all(): Promise<CapturedNotification[]> {
    return this.d.executeScript("return window.__e2eNotifications || [];");
  }

  /**
   * Wait until a captured notification has `match` in its title or body, and
   * return it. Use a phrase unique to the notification under test (e.g. the
   * meeting title, or "Meeting invitation") so reminder and invite notifications
   * don't alias each other.
   */
  async waitFor(match: string, timeout = 30000): Promise<CapturedNotification> {
    let found: CapturedNotification | undefined;
    await this.d.wait(
      async () => {
        const list = await this.all();
        found = list.find((n) => n.title.includes(match) || n.body.includes(match));
        return found !== undefined;
      },
      timeout,
      `no notification matching "${match}" was fired`,
    );
    return found!;
  }
}
