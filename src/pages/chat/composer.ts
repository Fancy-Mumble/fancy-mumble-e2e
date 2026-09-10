import { By, error, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { byTid, TID } from "../../selectors";
import { config } from "../../config";
import { delay } from "../../util/wait";
import { setReactInputValue } from "../../util/astral";
import { isNebula } from "../../ui-flavour";
import { dismissMenus } from "../../util/nebula";
import { ensureSidebarClosed, clickPossiblyHidden } from "../../util/layout";

/**
 * The message composer: Standard's `ChatComposer.tsx`, Nebula's `Composer.tsx`.
 *
 * Everything a message is *written* with lives here - the textarea, the send
 * button, and the attach menu. What happens to a message once it is posted
 * belongs to {@link import("./message-list").MessageList}.
 */
export class ChatComposer {
  constructor(private readonly d: WebDriver) {}

  /** Type into the composer's textarea and click send. */
  async send(text: string): Promise<void> {
    await ensureSidebarClosed(this.d);
    // A menu a previous step left open lays a backdrop over the composer, and
    // the failure then names the composer rather than the menu.
    if (isNebula) await dismissMenus(this.d);
    // Retried as a whole, because every reference in it can go stale together.
    // The composer re-renders while three clients talk, and a 4 KiB message
    // re-renders it again mid-send: the textarea located a moment ago is
    // detached before the value reaches it, and WebDriver reports
    // StaleElementReference from whichever step got there first. Re-locating
    // one element would leave the others pointing at the old tree, so the
    // whole locate-fill-send sequence is what repeats.
    await this.withFreshTextarea(async (editable) => {
      await editable.click();
      // Always through the DOM, never keystrokes. sendKeys was kept here for
      // realism, but on this rig it is keymap roulette: with the compositor's
      // layout active, "-" types as "ß" - verified live, a sent token stored as
      // "probeßtokenß…" - and whether it strikes depends on which window holds
      // focus at that moment. Every suite asserts on hyphenated tokens, so the
      // mangling reads as a delivery bug in whatever feature the suite
      // measures. (Astral and newline text needed this path anyway:
      // msedgedriver refuses astral code points, and a newline presses Enter
      // mid-message.)
      await setReactInputValue(this.d, editable, text);
      // Located fresh inside the retry, not hoisted: it belongs to the same
      // render as the textarea above, and a re-render invalidates both.
      const send = await this.d.findElement(byTid(TID.chatSend));
      await this.d.wait(until.elementIsEnabled(send), 5000);
      await send.click();
    });
  }

  /** Type without submitting; useful for exercising typing-indicator transport. */
  async type(text: string): Promise<void> {
    await ensureSidebarClosed(this.d);
    const wrap = await this.d.wait(
      until.elementLocated(byTid(TID.chatComposerInput)),
      config.waitTimeout,
    );
    const editable = await wrap.findElement(By.css("textarea"));
    await editable.click();
    await editable.sendKeys(text);
  }

  /**
   * Open the composer's attach menu (Nebula's `AttachmentTray` opener, which
   * also carries "Create poll").
   *
   * Through `clickPossiblyHidden`: the composer's controls sit under whatever
   * transition a previous popover is still finishing, and a positional click
   * reports the scrim rather than the button.
   */
  async openAttachMenu(timeout = 10000): Promise<void> {
    const menu = await this.d.wait(until.elementLocated(byTid(TID.chatAttachMenu)), timeout);
    await clickPossiblyHidden(this.d, menu);
  }

  /**
   * Upload a file via the composer's "File" attach option (the file-server
   * plugin path). The native file picker (`plugin:dialog|open`) is intercepted
   * in the webview to return `hostFilePath` so Selenium never faces a native
   * dialog, then the FileShareDialog is submitted with its defaults ("session"
   * access, default TTL). Requires the SHARE_FILES permission, so the attach
   * "File" option is only present for an authorised user (e.g. SuperUser).
   */
  async attachFile(hostFilePath: string): Promise<void> {
    await this.d.executeScript(
      `window.__e2eAttachPath = arguments[0];
       if (!window.__e2eDialogMocked) {
         const inv = window.__TAURI_INTERNALS__.invoke;
         window.__TAURI_INTERNALS__.invoke = function (cmd, args, opts) {
           if (cmd === 'plugin:dialog|open') return Promise.resolve(window.__e2eAttachPath);
           return inv.call(this, cmd, args, opts);
         };
         window.__e2eDialogMocked = true;
       }`,
      hostFilePath,
    );
    // Open the attach menu (its tooltip only reads "...or file" once the
    // file-server capabilities are loaded and upload is permitted) and pick File.
    const attachBtn = await this.d.wait(
      until.elementLocated(By.xpath("//button[@title='Attach image or file']")),
      20000,
    );
    await attachBtn.click();
    const fileItem = await this.d.wait(
      until.elementLocated(By.xpath("//button[@role='menuitem' and normalize-space(.)='File']")),
      8000,
    );
    await fileItem.click();
    // FileShareDialog: submit with defaults.
    const uploadBtn = await this.d.wait(
      until.elementLocated(By.xpath("//*[@role='dialog']//button[normalize-space(.)='Upload']")),
      10000,
    );
    await this.d.wait(until.elementIsEnabled(uploadBtn), 8000);
    await uploadBtn.click();
  }

  /**
   * Run `use` against a freshly located composer textarea, retrying the whole
   * body when the element goes stale under a re-render.
   */
  private async withFreshTextarea(
    use: (editable: WebElement) => Promise<void>,
    attempts = 4,
  ): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const wrap = await this.d.wait(
          until.elementLocated(byTid(TID.chatComposerInput)),
          config.waitTimeout,
        );
        const editable = await wrap.findElement(By.css("textarea"));
        await use(editable);
        return;
      } catch (e) {
        if (!(e instanceof error.StaleElementReferenceError)) throw e;
        last = e;
        await delay(200);
      }
    }
    throw new Error(`the chat composer stayed stale across ${attempts} attempts: ${last}`);
  }
}
