import { By, Key, error, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID, STREAM_SOURCE_TITLE_ATTR, BROADCASTER_NAME_ATTR } from "../selectors";
import { delay } from "../util/wait";
import { config } from "../config";
import { isNebula } from "../ui-flavour";
import { ensureSidebarClosed, clickPossiblyHidden, locateForGesture } from "../util/layout";

/** Colour class recovered from a sampled checkerboard cell. */
export type CellClass = "green" | "purple" | "other";

/** Result of decoding a stream `<video>` back into a checkerboard. */
export interface CheckerboardReadout {
  readonly ok: boolean;
  readonly reason?: string;
  /** Detected phase from cell (0,0): 0 = green-first, 1 = purple-first, -1 unknown. */
  readonly phase: number;
  readonly greenCount: number;
  readonly purpleCount: number;
  readonly otherCount: number;
  /** Cells that disagreed with the alternating pattern implied by `phase`. */
  readonly mismatches: number;
  /** True when the board alternates cleanly (within tolerance). */
  readonly checkerboard: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
}

/**
 * Page object for screen sharing, written to be **agnostic to how the source is
 * selected**. The only thing that differs between the current build (browser
 * `getDisplayMedia` + native OS picker) and the new Rust-native build (a custom
 * in-app picker dialog) is *that* selection step, so {@link shareWindow}
 * auto-detects which one is present:
 *
 *   - New build: clicking the share toggle opens the `screen-share-picker`
 *     dialog; we switch to the Window tab, pick the card by title, confirm.
 *     Rust then captures that *real* OS window - no native browser picker.
 *   - Old build: `getDisplayMedia` opens a native OS picker Selenium cannot
 *     drive; auto-selection is attempted via the WebView2
 *     `--auto-select-desktop-capture-source=<title>` flag (set at launch through
 *     {@link LaunchOptions.captureWindowTitle}). We deliberately do NOT mock
 *     getDisplayMedia - the point of the test is to prove real capture works.
 *
 * Everything else - own loopback preview, watching a peer, and pixel-level
 * read-back of the decoded `<video>` - is pure behaviour and identical for both.
 * Read-back draws the live `<video>` (a same-origin MediaStream, not
 * canvas-tainted) into a canvas and classifies cell centres into green/purple/
 * other; because VP8 is lossy and the frame may be rescaled, assertions use
 * *hue class + structure*, never exact RGB.
 */
export class StreamPage {
  constructor(private readonly d: WebDriver) {}

  /**
   * CSS matching the stream's media surface, whichever family renders it.
   *
   * The viewer has two implementations and they do not share an element. The
   * *webview family* binds a `MediaStream` to a `<video>`
   * (`stream-viewer-video`); the *native family* — mandatory on Linux, where
   * WebKitGTK has no WebRTC — decodes in Rust and paints into a `<canvas>`
   * (`stream-native-view`). A selector naming only the `<video>` waits out its
   * full timeout on Linux against a stream that is playing perfectly, which is
   * what "own preview never received frames" meant in every Linux sweep.
   *
   * The camera PiP needs no such union: both families render it under the same
   * testid.
   */
  private surface(own: boolean): By {
    const flag = own ? "true" : "false";
    return By.css(
      `[data-testid="${TID.streamViewerVideo}"][data-own="${flag}"],` +
        `[data-testid="${TID.streamNativeView}"][data-own="${flag}"]`,
    );
  }

  /** Click the chat-header share toggle (present in both builds). */
  private async clickToggle(timeout = config.waitTimeout): Promise<void> {
    // Every picker path funnels through here, and the share toggle sits in
    // the chat header - behind the drawer's backdrop on a narrow window.
    await ensureSidebarClosed(this.d);
    const toggle = await this.d.wait(until.elementLocated(byTid(TID.screenShareToggle)), timeout);
    await this.d.wait(until.elementIsEnabled(toggle), timeout);
    // Dismissing the drawer is not always enough on a narrow window: the header
    // this toggle sits in is also what the stream focus view and its tile
    // drawer overlap once a broadcast is running, which is exactly when the
    // camera suite opens the picker a second time. Same remedy as everywhere
    // else here, and it still rethrows on a wide window so a real overlay is
    // not hidden.
    await clickPossiblyHidden(this.d, toggle);
  }

  /** Whether the custom (new-build) source picker dialog opened. */
  private async customPickerAppeared(timeout = 2500): Promise<boolean> {
    try {
      await this.d.wait(until.elementLocated(byTid(TID.screenSharePicker)), timeout);
      return true;
    } catch {
      return false;
    }
  }

  /** Switch the custom picker to the "Entire Screen", "Window" or "Device"
   *  (webcam) tab. */
  async selectTab(tab: "screens" | "windows" | "devices"): Promise<void> {
    const el = await this.d.wait(
      until.elementLocated(By.css(`[data-testid="${TID.screenSharePickerTab}"][data-tab="${tab}"]`)),
      10000,
    );
    await el.click();
  }

  /** Titles of every source card currently listed in the custom picker. */
  async listSourceTitles(): Promise<string[]> {
    const cards = await this.d.findElements(byTid(TID.screenShareSource));
    const titles: string[] = [];
    for (const c of cards) {
      titles.push((await c.getAttribute(STREAM_SOURCE_TITLE_ATTR)) ?? "");
    }
    return titles;
  }

  /**
   * Start sharing the window whose title contains `title`, regardless of which
   * selection mechanism the build uses (see the class doc). Resolves once the
   * broadcast's own preview is rendering frames.
   *
   * On the *old* build, clicking the toggle raises the native OS picker. Pass an
   * `onNativePicker` callback (see {@link NativePickerDriver}) to drive it via
   * OS-level GUI automation (pyautogui) - we never mock getDisplayMedia, so this
   * exercises real screen capture.
   */
  async shareWindow(
    title: string,
    onNativePicker?: () => Promise<void>,
    timeout = 20000,
  ): Promise<void> {
    await this.captureConsole();
    await this.clickToggle(timeout);
    if (await this.customPickerAppeared()) {
      // New build: drive the in-app picker to capture the real OS window.
      await this.selectInCustomPicker(title, timeout);
    } else if (onNativePicker) {
      // Old build: the native getDisplayMedia picker is up - drive it at the OS
      // level to select the real window and confirm.
      await onNativePicker();
    }
    try {
      await this.waitOwnPreview();
    } catch (e) {
      // WebRTC failures are invisible from the DOM alone - attach the app's
      // console (captured above) so the timeout explains itself.
      const logs = await this.readCapturedConsole();
      const err = e as Error;
      err.message += `\n--- webview console ---\n${logs.join("\n")}`;
      throw err;
    }
  }

  /** Idempotently wrap the webview console so failures can replay it. */
  private async captureConsole(): Promise<void> {
    await this.d.executeScript(`
      if (!window.__e2eLogs) {
        window.__e2eLogs = [];
        for (const level of ["log", "info", "warn", "error"]) {
          const orig = console[level].bind(console);
          console[level] = (...args) => {
            try {
              window.__e2eLogs.push(level + " " + args.map((a) => {
                try { return typeof a === "string" ? a : JSON.stringify(a); }
                catch { return String(a); }
              }).join(" "));
              if (window.__e2eLogs.length > 400) window.__e2eLogs.shift();
            } catch {}
            orig(...args);
          };
        }
      }
    `);
  }

  /** Console lines captured since {@link captureConsole} was installed. */
  private async readCapturedConsole(): Promise<string[]> {
    try {
      return await this.d.executeScript<string[]>("return window.__e2eLogs || [];");
    } catch {
      return ["(console capture unavailable)"];
    }
  }

  /** New-build picker flow: Window tab -> pick card by title -> confirm. */
  private async selectInCustomPicker(title: string, timeout: number): Promise<void> {
    await this.selectTab("windows");
    const card = By.css(
      `[data-testid="${TID.screenShareSource}"][${STREAM_SOURCE_TITLE_ATTR}*="${cssAttrEscape(title)}"]`,
    );
    // Located, then scrolled into view before the click. The Window tab lists
    // every top-level window on the desktop, and on a busy one the card this
    // suite wants sits below the fold of the picker's own scroller: it is
    // *located* fine (`elementLocated` does not care about geometry) but has
    // no hit-testable box, and WebDriver refuses the click with
    // ElementNotInteractable ~800 ms into the step - the same failure shape
    // `locateForGesture` was written for on the channel list.
    await this.waitForSourceCard(
      card,
      "windows",
      timeout,
      `screen-share picker never offered a window titled like "${title}"`,
    );
    const el = await locateForGesture(this.d, card, timeout);
    await clickPossiblyHidden(this.d, el);
    const confirm = await this.d.wait(until.elementLocated(byTid(TID.screenShareConfirm)), 10000);
    await this.d.wait(until.elementIsEnabled(confirm), 10000);
    await confirm.click();
    await this.d.wait(
      async () => (await this.d.findElements(byTid(TID.screenSharePicker))).length === 0,
      10000,
      "source picker did not close after confirming",
    );
  }

  /**
   * Wait for a source card, reopening the picker once if it is missing.
   *
   * The picker enumerates once, when it opens, and a window that maps a
   * moment later is never listed however long the wait. On a desktop with
   * other clients coming and going (parallel suites) that race is common:
   * the card is absent, and listing again after the failure shows the
   * window. So a short first wait, then one reopen, then the real wait.
   */
  private async waitForSourceCard(
    card: By,
    tab: "screens" | "windows" | "devices",
    timeout: number,
    missing: string,
  ): Promise<void> {
    try {
      await this.d.wait(until.elementLocated(card), Math.min(timeout, 5000), missing);
    } catch {
      await this.closePickerIfOpen();
      await this.clickToggle(timeout);
      await this.customPickerAppeared();
      await this.selectTab(tab);
      await this.d.wait(until.elementLocated(card), timeout, missing);
    }
  }

  /**
   * Start sharing an ENTIRE SCREEN via the custom picker (first screen card).
   * This is the path that engages the GPU pipeline on platforms that have
   * one; window shares use the portable CPU pipeline.
   */
  async shareScreen(timeout = 20000): Promise<void> {
    await this.captureConsole();
    await this.clickToggle(timeout);
    if (!(await this.customPickerAppeared())) {
      throw new Error("custom source picker did not open (old build?)");
    }
    await this.selectTab("screens");
    const card = await this.d.wait(
      until.elementLocated(byTid(TID.screenShareSource)),
      timeout,
      "picker offered no screens",
    );
    await card.click();
    const confirm = await this.d.wait(until.elementLocated(byTid(TID.screenShareConfirm)), 10000);
    await this.d.wait(until.elementIsEnabled(confirm), 10000);
    await confirm.click();
    try {
      await this.waitOwnPreview();
    } catch (e) {
      const logs = await this.readCapturedConsole();
      const err = e as Error;
      err.message += `\n--- webview console ---\n${logs.join("\n")}`;
      throw err;
    }
  }

  /** Stop the local broadcast via the header toggle. */
  async stopShare(): Promise<void> {
    const toggle = await this.d.wait(until.elementLocated(byTid(TID.screenShareToggle)), 10000);
    await toggle.click();
  }

  /**
   * Open the custom picker on the Devices (webcam) tab and wait until camera
   * enumeration settles: either at least one device card is listed or the
   * "no devices" status is shown. Returns the listed device titles (empty
   * when the machine has no cameras). Only valid on the new Rust-native
   * build - throws if the custom picker does not appear.
   */
  /** Open the source picker via the header share toggle. */
  async openPicker(timeout = config.waitTimeout): Promise<void> {
    // Installed here as well as in `shareWindow`/`shareScreen`, because the
    // camera suite reaches a broadcast through the picker alone and so had no
    // console captured at all: every camera failure reported its symptom with
    // none of the app's own account of what the capture pipeline did.
    await this.captureConsole();
    await this.clickToggle(timeout);
    if (!(await this.customPickerAppeared(5000))) {
      throw new Error("custom screen-share picker did not open (old build?)");
    }
  }

  /**
   * Dismiss the source picker if it is open, and resolve once it is gone.
   *
   * A test that abandons a flow mid-picker (most often `t.skip()` after
   * enumeration found no cameras) leaves a modal mounted, and the NEXT test's
   * click on the header toggle hits that modal's backdrop instead:
   * `ElementClickInterceptedError`, several steps away from anything to do
   * with what actually went wrong. Cleanup belongs in `afterEach`, next to
   * {@link stopBroadcastIfActive}.
   */
  async closePickerIfOpen(): Promise<void> {
    try {
      const open = await this.d.findElements(byTid(TID.screenSharePicker));
      if (open.length === 0) return;
      // Escape is what the Modal itself listens for; the Cancel button is the
      // fallback for a build whose modal opts out of Esc dismissal.
      await this.d.actions().sendKeys(Key.ESCAPE).perform();
      await delay(300);
      if ((await this.d.findElements(byTid(TID.screenSharePicker))).length === 0) return;
      const cancel = await this.d.findElements(
        By.xpath("//button[normalize-space(.)='Cancel']"),
      );
      if (cancel.length > 0) await cancel[0]!.click();
      await this.d.wait(
        async () => (await this.d.findElements(byTid(TID.screenSharePicker))).length === 0,
        5000,
        "source picker stayed open after Escape and Cancel",
      );
    } catch {
      /* best effort - this is cleanup, never the reason a test fails */
    }
  }

  async openPickerDevices(timeout = config.waitTimeout): Promise<string[]> {
    await this.openPicker(timeout);
    await this.selectTab("devices");
    // Enumeration is one `list_capture_sources` invoke; cards render as soon
    // as it resolves. Poll briefly - no cards after the budget simply means
    // this machine has no cameras (the caller decides whether to skip).
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const cards = await this.d.findElements(
        By.css(`[data-testid="${TID.screenShareSource}"][data-source-kind="device"]`),
      );
      if (cards.length > 0) return this.titlesOf(cards);
      await delay(300);
    }
    return [];
  }

  /**
   * In the open picker, switch to `tab` and click a source card (the one
   * whose title contains `title`, or the first card). Does NOT confirm -
   * callers can combine picks across tabs (screen + camera). Returns the
   * picked card's title.
   */
  async pickSource(tab: "screens" | "windows" | "devices", title?: string): Promise<string> {
    await this.selectTab(tab);
    const kinds = { screens: "screen", windows: "window", devices: "device" } as const;
    const kind = kinds[tab];
    let css = `[data-testid="${TID.screenShareSource}"][data-source-kind="${kind}"]`;
    let what = `a ${kind} source`;
    if (title) {
      css += `[${STREAM_SOURCE_TITLE_ATTR}*="${cssAttrEscape(title)}"]`;
      what += ` titled like "${title}"`;
    }
    await this.waitForSourceCard(By.css(css), tab, config.waitTimeout, `picker never offered ${what}`);
    const card = await this.d.findElement(By.css(css));
    const picked = (await card.getAttribute(STREAM_SOURCE_TITLE_ATTR)) ?? "";
    await card.click();
    return picked;
  }

  /**
   * Click the own-stream control-bar "add missing source" shortcut (shown
   * while broadcasting only a screen OR only a camera); resolves once the
   * picker (seeded with the live sources) is open.
   */
  async clickAddSource(timeout = 10000): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(By.css('[data-testid="stream-add-source"]')),
      timeout,
      "no add-source shortcut in the own-stream controls",
    );
    await btn.click();
    await this.d.wait(until.elementLocated(byTid(TID.screenSharePicker)), 10000);
  }

  /** Whether the chat-header share toggle is present (it must stay visible
   *  while broadcasting so sources can be changed/added). */
  async headerShareTogglePresent(): Promise<boolean> {
    const els = await this.d.findElements(byTid(TID.screenShareToggle));
    return els.length > 0;
  }

  /**
   * Open the "Stats for Nerds" panel and count its per-track resolution rows
   * (one per inbound video track). Polls briefly because the first stats tick
   * lands ~1s after the panel opens. Leaves the panel open.
   */
  async statsResolutionCount(timeout = 8000): Promise<number> {
    await this.openStats(timeout);
    const deadline = Date.now() + timeout;
    let count = 0;
    while (Date.now() < deadline) {
      count = (await this.d.findElements(byTid(TID.streamStatsResolution))).length;
      if (count > 0) return count;
      await delay(400);
    }
    return count;
  }

  /**
   * Show the stats panel.
   *
   * Standard keeps the toggle in the stream control bar as a button; Nebula
   * files it inside the stream config menu, one click further in. Both spell
   * it "Stats for Nerds" (`chat:screenShare.stats.toggle`), which is what
   * makes one caption enough for the two shapes.
   */
  private async openStats(timeout: number): Promise<void> {
    if (isNebula) {
      const menu = await this.d.wait(
        until.elementLocated(byTid(TID.streamConfigMenu)),
        timeout,
        "no stream config menu to open the stats panel from",
      );
      await clickPossiblyHidden(this.d, menu);
      const item = await this.d.wait(
        until.elementLocated(
          By.xpath("//*[self::button or @role='menuitem'][contains(normalize-space(.), 'Stats for Nerds')]"),
        ),
        timeout,
        "the stream config menu offered no Stats-for-Nerds entry",
      );
      await clickPossiblyHidden(this.d, item);
      return;
    }
    const statsBtn = await this.d.wait(
      until.elementLocated(
        By.css('button[aria-label="Stats for Nerds"], button[aria-label="Hide stats for nerds"]'),
      ),
      timeout,
      "no Stats-for-Nerds toggle in the stream controls",
    );
    await clickPossiblyHidden(this.d, statsBtn);
  }

  /**
   * Decoded fps from the (open) stats panel's dedicated FPS row.
   *
   * Read from `stream-stats-fps`, **not** parsed out of the "Current Res"
   * row's `1234×567@30`. Those are two different numbers with two different
   * availabilities: the resolution row prints a rate only when the painter
   * reported frame dimensions for that track, and the native viewer family -
   * mandatory on Linux, where WebKitGTK has no WebRTC - leaves them null, so
   * the row renders a bare `–` and every sample parsed to NaN. The whole
   * series read `[NaN, NaN, ...]` against a share that was demonstrably
   * decoding real frames, which makes the diagnostic worse than absent:
   * `screen-share-health` documents this series as the thing that localises a
   * problem, and it was localising nothing.
   *
   * The dedicated row carries `deriveIntervalStats`'s `fps`, which falls back
   * to the `framesDecoded` delta over the interval when the reported rate is
   * missing - available on both viewer families.
   *
   * One entry, not one per track: this row is the aggregate. NaN still means
   * the panel genuinely has no rate yet.
   */
  async readStatsFps(): Promise<number[]> {
    // `textContent` for the same reason `readStatsFreezes` uses it: `getText()`
    // returns only rendered text, and these rows scroll.
    const texts = await this.d.executeScript<string[]>(
      `return Array.from(
         document.querySelectorAll('[data-testid="stream-stats-fps"]'),
       ).map((n) => n.textContent || "");`,
    );
    return texts.map((text) => {
      const m = /(\d+(?:\.\d+)?)\s*fps/.exec(text);
      return m ? Number(m[1]) : Number.NaN;
    });
  }

  /**
   * Read a labelled row's numeric value from the (open) stats panel, e.g.
   * `readStatsNumber("Connection Speed")` -> 8470 (kbps). NaN when missing.
   */
  async readStatsNumber(label: string): Promise<number> {
    const value = await this.d.executeScript<string>(
      `const rows = document.querySelectorAll('[data-testid="stream-stats-panel"] > div > div');
       for (const row of rows) {
         if (row.textContent && row.textContent.includes(arguments[0])) return row.textContent;
       }
       return '';`,
      label,
    );
    const m = /(-?\d+(?:\.\d+)?)/.exec((value ?? "").replace(label, ""));
    return m ? Number(m[1]) : Number.NaN;
  }

  /**
   * Freeze counters from the (open) stats panel, one entry per video track:
   * `[count, totalSeconds]` parsed from "n (x.x s total)"-style rows. The
   * panel must already be open (see {@link statsResolutionCount}).
   */
  async readStatsFreezes(): Promise<Array<[number, number]>> {
    // `textContent`, not `getText()`. WebDriver's getText returns only what is
    // *rendered*, and this row sits well down a scrolling panel - below the
    // resolution row that `statsResolutionCount` finds perfectly - so it comes
    // back empty whenever the panel has not been scrolled to it. The rows then
    // parse to nothing and the caller reports "stats panel shows no freeze
    // row", which reads as a missing feature rather than an unscrolled div.
    const texts = await this.d.executeScript<string[]>(
      `return Array.from(
         document.querySelectorAll('[data-testid="stream-stats-freezes"]'),
       ).map((n) => n.textContent || "");`,
    );
    const out: Array<[number, number]> = [];
    for (const text of texts) {
      const m = /(\d+)\s*\((\d+(?:\.\d+)?)/.exec(text);
      if (m) out.push([Number(m[1]), Number(m[2])]);
    }
    return out;
  }

  /** Close the "Stats for Nerds" panel if it is open. */
  async closeStats(): Promise<void> {
    const btns = await this.d.findElements(By.css('button[aria-label="Close stats"]'));
    if (btns.length > 0) await btns[0]!.click();
  }

  /** Click the × on the own camera PiP tile to end just the camera track. */
  async endCameraViaPip(timeout = 10000): Promise<void> {
    const x = await this.d.wait(
      until.elementLocated(byTid(TID.streamEndCamera)),
      timeout,
      "no × on the camera PiP tile",
    );
    await x.click();
    // The camera PiP must disappear (screen keeps sharing).
    await this.d.wait(
      async () =>
        (await this.d.findElements(
          By.css(`[data-testid="${TID.streamCameraVideo}"][data-own="true"]`),
        )).length === 0,
      timeout,
      "camera PiP did not disappear after ending the camera track",
    );
  }

  /** Click the panel × ("Stop sharing") exactly once. With both screen and
   *  camera live this ends only the screen; with one source it stops all. */
  async clickPanelStopOnce(timeout = 10000): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(By.css('button[aria-label^="Stop sharing"]')),
      timeout,
      "no panel stop (×) button in the stream viewer",
    );
    await btn.click();
  }

  /** Whether the own-broadcast preview is currently mounted (broadcast live). */
  async ownPreviewPresent(): Promise<boolean> {
    const els = await this.d.findElements(this.surface(true));
    return els.length > 0;
  }

  /** Whether the own camera PiP tile is currently rendered. */
  async cameraPipPresent(): Promise<boolean> {
    const els = await this.d.findElements(
      By.css(`[data-testid="${TID.streamCameraVideo}"][data-own="true"]`),
    );
    return els.length > 0;
  }

  /** Wait until the own camera PiP tile is gone (e.g. camera promoted to the
   *  main video after the screen track ended). */
  async waitForCameraPipGone(timeout = 10000): Promise<void> {
    await this.d.wait(
      async () => !(await this.cameraPipPresent()),
      timeout,
      "camera PiP tile did not disappear",
    );
  }

  /** Best-effort full stop of any active own broadcast (afterEach cleanup). */
  async stopBroadcastIfActive(): Promise<void> {
    const own = this.surface(true);
    try {
      for (let i = 0; i < 3; i++) {
        const btns = await this.d.findElements(By.css('button[aria-label^="Stop sharing"]'));
        if (btns.length === 0) break;
        await btns[0]!.click();
        await delay(800);
        if ((await this.d.findElements(own)).length === 0) break;
      }
    } catch {
      /* best effort */
    }
  }

  /** Kinds ("screen" | "window" | "device") of the picker's selection chips. */
  async selectionChipKinds(): Promise<string[]> {
    const chips = await this.d.findElements(
      By.css('[data-testid="screen-share-selection-chip"]'),
    );
    const kinds: string[] = [];
    for (const chip of chips) {
      kinds.push((await chip.getAttribute("data-chip-kind")) ?? "");
    }
    return kinds;
  }

  /** Confirm the picker's current selection; resolves when it closes. */
  async confirmPicker(): Promise<void> {
    const confirm = await this.d.wait(until.elementLocated(byTid(TID.screenShareConfirm)), 10000);
    await this.d.wait(until.elementIsEnabled(confirm), 10000);
    await confirm.click();
    await this.d.wait(
      async () => (await this.d.findElements(byTid(TID.screenSharePicker))).length === 0,
      10000,
      "source picker did not close after confirming",
    );
  }

  /**
   * On the already-open picker's Devices tab, select the camera whose title
   * contains `title` and confirm the share. Resolves when the picker closes.
   */
  async confirmDevice(title: string, timeout = config.waitTimeout): Promise<void> {
    const card = By.css(
      `[data-testid="${TID.screenShareSource}"][data-source-kind="device"][${STREAM_SOURCE_TITLE_ATTR}*="${cssAttrEscape(title)}"]`,
    );
    const el = await this.d.wait(
      until.elementLocated(card),
      timeout,
      `picker never offered a camera titled like "${title}"`,
    );
    await el.click();
    const confirm = await this.d.wait(until.elementLocated(byTid(TID.screenShareConfirm)), 10000);
    await this.d.wait(until.elementIsEnabled(confirm), 10000);
    await confirm.click();
    await this.d.wait(
      async () => (await this.d.findElements(byTid(TID.screenSharePicker))).length === 0,
      10000,
      "source picker did not close after confirming the camera",
    );
  }

  /** Whether the app's webview still answers (i.e. the process is alive). */
  async appAlive(): Promise<boolean> {
    try {
      await this.d.getTitle();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fully stop the running broadcast via the panel × ("Stop sharing"). The ×
   * is context-aware: with BOTH screen and camera live it ends only the
   * screen (aria-label "Stop sharing your screen"); with one source it stops
   * the whole broadcast. So click it until the own-stream viewer is gone (at
   * most twice: both -> camera-only -> stopped).
   */
  async stopBroadcast(): Promise<void> {
    const stopBtn = By.css('button[aria-label^="Stop sharing"]');
    const own = this.surface(true);
    for (let i = 0; i < 3; i++) {
      const btns = await this.d.findElements(stopBtn);
      if (btns.length === 0) break;
      await btns[0]!.click();
      // Either the viewer closes (fully stopped) or the source set shrinks
      // (screen dropped, camera promoted to main) - re-check next iteration.
      await delay(800);
      if ((await this.d.findElements(own)).length === 0) return;
    }
    await this.d.wait(
      async () => (await this.d.findElements(own)).length === 0,
      10000,
      "own stream viewer did not close after stopping the broadcast",
    );
  }

  /** In the open picker, click a quality preset button ("SD"/"HD"/"Source"). */
  async setQuality(label: "SD" | "HD" | "Source"): Promise<void> {
    const btn = await this.d.wait(
      until.elementLocated(By.xpath(`//button[normalize-space(.)='${label}']`)),
      10000,
      `no "${label}" quality button in the picker`,
    );
    await btn.click();
  }

  /**
   * In the open picker, choose a Stream Mode preset via the gear popover
   * (labels from the EN locale; the suite forces English).
   */
  async setStreamMode(mode: "gaming" | "screenshare"): Promise<void> {
    const gear = await this.d.wait(until.elementLocated(byTid(TID.screenShareSettings)), 10000);
    await gear.click();
    const label = mode === "screenshare" ? "Screenshare" : "Gaming";
    const item = By.xpath(
      `//button[@role='menuitemradio'][.//span[normalize-space(.)='${label}']]`,
    );
    const el = await this.d.wait(until.elementLocated(item), 5000, `no "${label}" mode item`);
    await el.click();
    // The popover stays open after picking a mode; close it so it does not
    // overlay the picker's confirm button.
    await gear.click();
  }

  /**
   * Decoded frames per second of the own preview over `windowMs`, from the
   * video sink's frame counter (`getVideoPlaybackQuality`) - measures what
   * the viewer actually RECEIVES, end to end through encode/SFU/decode.
   */
  async measureOwnPreviewFps(windowMs = 3000): Promise<number> {
    const before = await this.readPlaybackStats(true);
    if (before.totalVideoFrames < 0) throw new Error("own preview vanished while measuring fps");
    await delay(windowMs);
    const after = await this.readPlaybackStats(true);
    if (after.totalVideoFrames < 0) throw new Error("own preview vanished while measuring fps");
    return ((after.totalVideoFrames - before.totalVideoFrames) * 1000) / (after.tMs - before.tMs);
  }

  /**
   * Assert the own-preview stream KEEPS delivering: sample what the surface is
   * showing across `windowMs` and require the picture to change. Catches a
   * broadcast that dies right after its first frames.
   *
   * Sampled repeatedly rather than once at each end. Nebula swaps the stage's
   * surface element while a share is running, so a two-point measurement can
   * land its second read on the gap and report a healthy stream as vanished -
   * which is what it did. A momentary absence is not the failure; never being
   * there, or never changing, is.
   *
   * The source is animated by every caller, so "the picture changed" is the
   * pipeline-health signal. A static source would need a counter, and no
   * counter survives both packs (see below).
   */
  async assertOwnPreviewFlowing(windowMs = 3000): Promise<void> {
    const readProgress = () =>
      this.d.executeScript<number>(
        `const el = document.querySelector(
           '[data-testid="${TID.streamViewerVideo}"][data-own="true"],' +
           '[data-testid="${TID.streamNativeView}"][data-own="true"]');
         if (!el) return -1;
         // The native family's <canvas> keeps its own tally, incremented from
         // the patched 2D drawImage below. Left as the canvas signal because
         // it is the one that works: hashing a decoder canvas reads blank on
         // some builds, and a probe that reports a healthy stream as dead is
         // worse than a narrower one.
         if (el.tagName !== 'VIDEO') return el.__e2eFrames ?? 0;
         // For a <video>: what the surface is *showing*, not what a counter
         // says about it.
         //
         // The own preview is a loopback of the local capture, so in WebKit
         // it has no timeline (currentTime stays 0) and nothing decodes it
         // (totalVideoFrames stays 0) - both counters read "stalled" for a
         // stream that is arriving perfectly. Hashing the pixels asks the
         // question the test actually means, and it is the same evidence the
         // checkerboard suite already trusts.
         try {
           const c = document.createElement('canvas');
           c.width = 32; c.height = 18;
           const g = c.getContext('2d');
           g.drawImage(el, 0, 0, c.width, c.height);
           const d = g.getImageData(0, 0, c.width, c.height).data;
           let h = 0;
           for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0;
           return h;
         } catch (e) {
           return el.currentTime;
         }`,
      );
    await this.installFrameCounter();
    // Two budgets, because absence and staleness are different answers. The
    // window is how long a healthy stream gets to show a second picture; the
    // grace on top of it is for the surface being *missing*, which Nebula does
    // on purpose - it tears the own loopback down and rebuilds it when the
    // broadcast goes on the wire, so a 2 s window can contain one sample and
    // two gaps. Absence stops being acceptable once the grace runs out.
    const windowEnd = Date.now() + windowMs;
    const graceEnd = windowEnd + 8000;
    const seen = new Set<number>();
    let samples = 0;
    for (;;) {
      const value = await readProgress();
      if (value >= 0) {
        samples += 1;
        seen.add(value);
        if (seen.size > 1) return; // the picture moved
      }
      const done = samples >= 2 ? Date.now() > windowEnd : Date.now() > graceEnd;
      if (done) break;
      await delay(Math.min(250, Math.max(50, windowMs / 12)));
    }
    if (samples === 0) throw new Error("own stream preview vanished");
    if (samples === 1) {
      throw new Error(
        `own stream preview was only on screen for 1 of ${Math.round((graceEnd - windowEnd + windowMs) / 1000)}s ` +
          `- the surface keeps disappearing\n${await this.describeSurface(true)}`,
      );
    }
    {
      // A bare progress counter says the pipeline stalled and nothing about
      // where. The app logs the capture -> encode -> send stages to its
      // console, so replay them here exactly as `shareWindow` does for a
      // preview that never starts: without this, "0 -> 0" is the entire
      // evidence for a stall that could be capture, encode, or paint.
      const logs = await this.readCapturedConsole();
      const detail = logs.length > 0 ? `\n--- webview console ---\n${logs.join("\n")}` : "";
      throw new Error(
        `own stream preview stopped decoding (${samples} sample(s) over ${windowMs}ms, ` +
          `all showing the same picture)\n${await this.describeSurface(true)}${detail}`,
      );
    }
  }

  /**
   * What the stream surface is, and what state it is in.
   *
   * "0 -> 0" says the picture is not changing and nothing else. A surface that
   * is paused, has no track, or has been laid out to nothing are three
   * different faults with three different owners, and they are indistinguishable
   * from the progress number alone.
   */
  private async describeSurface(own: boolean): Promise<string> {
    try {
      return await this.d.executeScript<string>(
        `const el = document.querySelector(arguments[0]);
         if (!el) return "surface: absent";
         const r = el.getBoundingClientRect();
         const cs = getComputedStyle(el);
         const s = el.srcObject;
         const tracks = s && s.getVideoTracks ? s.getVideoTracks() : [];
         return "surface: " + el.tagName.toLowerCase()
           + " " + Math.round(r.width) + "x" + Math.round(r.height)
           + " display=" + cs.display + " visibility=" + cs.visibility
           + " videoSize=" + (el.videoWidth || 0) + "x" + (el.videoHeight || 0)
           + (el.tagName === "CANVAS"
             ? " canvasSize=" + el.width + "x" + el.height + " frames=" + (el.__e2eFrames ?? 0)
             : " readyState=" + el.readyState + " paused=" + el.paused)
           + " tracks=" + tracks.length
           + tracks.map((t) => " [" + t.readyState + (t.muted ? " muted" : "") + "]").join("");`,
        `[data-testid="${TID.streamViewerVideo}"][data-own="${own}"],` +
          `[data-testid="${TID.streamNativeView}"][data-own="${own}"]`,
      );
    } catch {
      return "surface: (could not be read)";
    }
  }

  private async titlesOf(cards: import("selenium-webdriver").WebElement[]): Promise<string[]> {
    const titles: string[] = [];
    for (const c of cards) {
      titles.push((await c.getAttribute(STREAM_SOURCE_TITLE_ATTR)) ?? "");
    }
    return titles;
  }

  /** Wait for the broadcaster's own loopback preview to carry decoded frames. */
  async waitOwnPreview(timeout = 30000): Promise<void> {
    await this.waitVideoReady("true", timeout);
  }

  /**
   * Click `el`, reporting a lost race rather than throwing one.
   *
   * Two different obstructions reach here, and they need different answers:
   *
   *   - **Persistent**, from the narrow layout putting something over the
   *     target. {@link clickPossiblyHidden} owns that one and dispatches the
   *     click directly; it rethrows on a wide window, deliberately, so a real
   *     overlay bug is not papered over.
   *   - **Transient**, because the "is sharing" banner slides in and
   *     {@link watchByName} polls for it: the find succeeds the moment it
   *     mounts, while it is still animating, so the click lands on whatever the
   *     transform still has over it. `StaleElementReferenceError` is the same
   *     race seen through a re-render between the find and the click.
   *
   * The transient pair is the caller's loop condition, not a failure - it
   * already waits for the banner to exist, and this makes it wait for the
   * banner to be *usable*.
   */
  private async clicked(el: import("selenium-webdriver").WebElement): Promise<boolean> {
    try {
      await clickPossiblyHidden(this.d, el);
      return true;
    } catch (e) {
      if (
        e instanceof error.ElementClickInterceptedError ||
        e instanceof error.StaleElementReferenceError
      ) {
        return false;
      }
      throw e;
    }
  }

  /** Viewport width and narrow-layout state, for a failure that explains itself. */
  private async layoutNote(): Promise<string> {
    try {
      return await this.d.executeScript<string>(
        `return window.innerWidth + "px, narrow=" +
           window.matchMedia("(max-width: 768px)").matches;`,
      );
    } catch {
      return "unavailable";
    }
  }

  /**
   * Start watching `name`'s broadcast, whichever affordance the UI offers:
   *
   *   - Idle viewer: the "<name> is sharing" banner's Watch button.
   *   - Already broadcasting ourselves: the focus view replaces the banner,
   *     and other streams appear as clickable tiles (secondary panes, or the
   *     bottom drawer - opened via its toggle when collapsed).
   */
  async watchByName(name: string, timeout = 30000): Promise<void> {
    // The banner and the watch tiles all live in the main area, which an open
    // drawer covers with a full-page backdrop - the same reason `clickToggle`
    // does this before reaching for the share toggle. Without it every click
    // below lands on the backdrop and WebDriver reports ElementClickIntercepted
    // for as long as the drawer stays open, which is forever.
    await ensureSidebarClosed(this.d);
    const banner = By.css(
      `[data-testid="${TID.broadcastBanner}"][${BROADCASTER_NAME_ATTR}="${cssAttrEscape(name)}"]`,
    );
    const tile = By.css(
      `[data-testid="${TID.streamWatchTile}"][${BROADCASTER_NAME_ATTR}="${cssAttrEscape(name)}"]`,
    );
    // Nebula has no "X is sharing" banner and no Watch button: a remote feed
    // puts the stage on screen by itself, so being able to see the broadcast
    // *is* watching it and there is nothing to click. Its stage surface names
    // the broadcaster for exactly this.
    const stage = By.css(
      `[data-testid="${TID.streamViewerVideo}"][${BROADCASTER_NAME_ATTR}="${cssAttrEscape(name)}"],` +
        `[data-testid="${TID.streamNativeView}"][${BROADCASTER_NAME_ATTR}="${cssAttrEscape(name)}"]`,
    );
    const deadline = Date.now() + timeout;
    // Which of the two ways this can run out of time actually happened. "No
    // banner appeared" and "the banner appeared and would not take the click"
    // are different faults with different causes, and reporting the first for
    // the second sends the reader looking for a share that did start.
    let refused = 0;
    // Checked at the top, not the bottom: a `continue` from any of the retry
    // paths below skips a bottom-of-loop deadline entirely, which turns a
    // persistent refusal into a hang until the test framework's own timeout -
    // four minutes of nothing rather than a named failure at `timeout`.
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          refused > 0
            ? `"${name}" is sharing and the Watch control refused ${refused} ` +
              `click(s): something is over it (ElementClickIntercepted), so the ` +
              `banner is present but unusable. Viewport ${await this.layoutNote()} ` +
              `- a wide window here means a real overlay, not the drawer, and ` +
              `\`clickPossiblyHidden\` will have rethrown rather than hide it`
            : `no "is sharing" banner, watch tile or stage surface for "${name}" appeared`,
        );
      }
      if (isNebula && (await this.d.findElements(stage)).length > 0) return;

      const rows = await this.d.findElements(banner);
      if (rows.length > 0) {
        const watch = await rows[0].findElement(byTid(TID.broadcastWatch));
        if (await this.clicked(watch)) break;
        refused += 1;
        // Paced like the poll below: `continue` skips that one, and a retry
        // with no pause spins a core against the webview for the whole timeout.
        await delay(300);
        continue;
      }

      const tiles = await this.d.findElements(tile);
      if (tiles.length > 0) {
        if (await tiles[0].isDisplayed()) {
          if (await this.clicked(tiles[0])) break;
          refused += 1;
          await delay(300);
          continue;
        }
        // Tile exists but is hidden -> it lives in the collapsed drawer.
        const toggles = await this.d.findElements(byTid(TID.streamDrawerToggle));
        if (toggles.length > 0 && (await this.clicked(toggles[0]))) {
          const reopened = await this.d.findElements(tile);
          if (
            reopened.length > 0 &&
            (await reopened[0].isDisplayed()) &&
            (await this.clicked(reopened[0]))
          ) {
            break;
          }
        }
      }

      await delay(300);
    }
    await this.captureConsole();
    try {
      await this.waitVideoReady("false", timeout);
    } catch (e) {
      const logs = await this.readCapturedConsole();
      const err = e as Error;
      err.message += `\n--- webview console ---\n${logs.join("\n")}`;
      throw err;
    }
  }

  /**
   * Decode the named stream `<video>` and classify it back into a checkerboard.
   * `own` selects the broadcaster's own loopback preview (true) or a remote
   * viewer (false). `cols`/`rows` are the source helper's grid dimensions.
   */
  async readCheckerboard(
    own: boolean,
    cols: number,
    rows: number,
  ): Promise<CheckerboardReadout> {
    return this.d.executeScript<CheckerboardReadout>(
      READ_CHECKERBOARD_FN,
      own ? "true" : "false",
      cols,
      rows,
    );
  }

  /**
   * Poll {@link readCheckerboard} until it returns a clean board (or throw).
   * Tolerates the first few frames being a keyframe-less grey/!ok by retrying.
   */
  async waitCheckerboard(
    own: boolean,
    cols: number,
    rows: number,
    timeout = 30000,
  ): Promise<CheckerboardReadout> {
    const deadline = Date.now() + timeout;
    let last: CheckerboardReadout | undefined;
    while (Date.now() < deadline) {
      last = await this.readCheckerboard(own, cols, rows);
      if (last.ok && last.checkerboard) return last;
      await delay(500);
    }
    throw new Error(
      `stream never decoded into a clean checkerboard (own=${own}): ${JSON.stringify(last)}`,
    );
  }

  /**
   * Snapshot the decoded-frame counter of the chosen stream `<video>` plus the
   * sampling wall clock. Two snapshots over an interval give the real decoded
   * fps: (Δ totalVideoFrames) / (Δ tMs).
   */
  async readPlaybackStats(own: boolean): Promise<{ totalVideoFrames: number; tMs: number }> {
    await this.installFrameCounter();
    return this.d.executeScript<{ totalVideoFrames: number; tMs: number }>(
      `
      const own = arguments[0];
      const el = document.querySelector(
        '[data-testid="${TID.streamViewerVideo}"][data-own="' + own + '"],' +
        '[data-testid="${TID.streamNativeView}"][data-own="' + own + '"]');
      if (!el) return { totalVideoFrames: -1, tMs: Date.now() };
      if (el.tagName === 'VIDEO') {
        const q = el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null;
        return {
          totalVideoFrames: q ? q.totalVideoFrames : (el.webkitDecodedFrameCount ?? -1),
          tMs: Date.now(),
        };
      }
      // Native family: the paint counter installed above (see
      // installFrameCounter) is the canvas equivalent of totalVideoFrames.
      return { totalVideoFrames: el.__e2eFrames ?? 0, tMs: Date.now() };
      `,
      own ? "true" : "false",
    );
  }

  /**
   * Count decoded frames the native (canvas) viewer paints.
   *
   * A `<canvas>` exposes no `getVideoPlaybackQuality`, so the fps floors have
   * nothing to read on Linux. Every painted frame arrives through one call —
   * `ctx.drawImage(frame|bitmap, 0, 0)` in `nativeStreamView`'s paint path —
   * so wrapping `drawImage` and tallying per destination canvas gives the same
   * quantity from the outside: frames that travelled capture → encode → SFU →
   * decode and reached the screen.
   *
   * Only paints INTO a stream surface count; the readback in
   * {@link readCheckerboard} draws into a scratch canvas and must not inflate
   * the tally. Idempotent, and safe to install after frames have started (the
   * assertions read deltas).
   */
  private async installFrameCounter(): Promise<void> {
    await this.d.executeScript(`
      if (!window.__e2eFrameCounterInstalled) {
        window.__e2eFrameCounterInstalled = true;
        const proto = CanvasRenderingContext2D.prototype;
        const orig = proto.drawImage;
        proto.drawImage = function (...args) {
          try {
            const dest = this.canvas;
            const tid = dest && dest.getAttribute && dest.getAttribute('data-testid');
            if (tid === '${TID.streamNativeView}' || tid === '${TID.streamCameraVideo}') {
              dest.__e2eFrames = (dest.__e2eFrames || 0) + 1;
            }
          } catch (e) { /* never break a paint */ }
          return orig.apply(this, args);
        };
      }
    `);
  }

  private async waitVideoReady(own: "true" | "false", timeout: number): Promise<void> {
    const sel = this.surface(own === "true");
    await this.d.wait(until.elementLocated(sel), timeout);
    await this.waitFirstFrame(sel, timeout, `stream surface data-own="${own}"`);
  }

  /**
   * Wait until the located surface has shown a decoded frame.
   *
   * A `<video>` reports it through `videoWidth`. A `<canvas>` cannot: it is
   * 300x150 from the moment it mounts, and Nebula mounts the stage surface
   * seconds before the decoder's first paint (the "Connecting…" state). Any
   * width-based check returns on mount, and a flow assertion started right
   * after it then times out on a stream that has simply not started yet - the
   * "own stream preview stopped decoding" every Nebula health run reported.
   * The paint itself is the only honest signal, so the counter is installed
   * first and the wait is for it to tick. Frames painted before the install
   * are missed, but the sender never dedups, so the next one is never far.
   */
  private async waitFirstFrame(sel: By, timeout: number, what: string): Promise<void> {
    await this.installFrameCounter();
    await this.d.wait(async () => {
      const els = await this.d.findElements(sel);
      if (els.length === 0) return false;
      return this.d.executeScript<boolean>(
        `const el = arguments[0];
         return el.tagName === 'VIDEO' ? el.videoWidth > 0 : (el.__e2eFrames ?? 0) > 0;`,
        els[0],
      );
    }, timeout, `${what} never received frames`);
  }

  /**
   * Wait for the camera picture-in-picture tile (screen + camera shares) to
   * carry decoded frames. `own` selects the broadcaster's loopback preview
   * (true) or a remote viewer (false). A camera-ONLY share renders in the
   * main stream video instead - use {@link waitOwnPreview} / {@link
   * watchByName} for that case.
   */
  async waitCameraPip(own: boolean, timeout = 30000): Promise<void> {
    const sel = By.css(
      `[data-testid="${TID.streamCameraVideo}"][data-own="${own ? "true" : "false"}"]`,
    );
    try {
      await this.d.wait(until.elementLocated(sel), timeout);
    } catch (e) {
      // The PiP mounts only once BOTH tracks have delivered a first frame
      // (`hasMedia && hasCameraMedia`), so "never located" alone cannot say
      // which track died. The webview console can: the viewer logs a
      // heartbeat (`[stream-view] session=.. rx=.. painted=..`) and every
      // decode error, so replay it, as the other media waits already do.
      const logs = await this.readCapturedConsole();
      const err = e as Error;
      err.message += `\n--- webview console ---\n${logs.join("\n")}`;
      throw err;
    }
    await this.waitFirstFrame(sel, timeout, `camera PiP data-own="${own}"`);
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * In-page function (stringified for executeScript): draw the chosen stream
 * surface into a scratch canvas and classify a cols x rows grid of cell
 * centres. Handles both viewer families - `drawImage` takes a `<video>` and a
 * `<canvas>` alike, only the natural-size property differs.
 */
const READ_CHECKERBOARD_FN = `
  const own = arguments[0];
  const cols = arguments[1];
  const rows = arguments[2];
  const source = document.querySelector(
    '[data-testid="stream-viewer-video"][data-own="' + own + '"],' +
    '[data-testid="stream-native-view"][data-own="' + own + '"]');
  const fail = (reason) => ({ ok: false, reason, phase: -1, greenCount: 0, purpleCount: 0,
    otherCount: 0, mismatches: 0, checkerboard: false, videoWidth: 0, videoHeight: 0 });
  if (!source) return fail('no-video-element');
  const w = source.tagName === 'VIDEO' ? source.videoWidth : source.width;
  const h = source.tagName === 'VIDEO' ? source.videoHeight : source.height;
  if (!w || !h) return fail('no-frames');
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  let img;
  try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return fail('tainted:' + e); }
  const data = img.data;
  const rad = Math.max(2, Math.floor(Math.min(w / cols, h / rows) / 6));
  const sample = (cx, cy) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const x = Math.min(w - 1, Math.max(0, cx + dx));
      const y = Math.min(h - 1, Math.max(0, cy + dy));
      const i = (y * w + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return [r / n, g / n, b / n];
  };
  const classify = ([r, g, b]) => {
    if (g > r + 30 && g > b + 30) return 'green';
    if (r > g + 30 && b > g + 30) return 'purple';
    return 'other';
  };
  const grid = [];
  let greenCount = 0, purpleCount = 0, otherCount = 0;
  for (let ry = 0; ry < rows; ry++) {
    const rowC = [];
    for (let cx = 0; cx < cols; cx++) {
      const px = Math.floor((cx + 0.5) * w / cols);
      const py = Math.floor((ry + 0.5) * h / rows);
      const cls = classify(sample(px, py));
      rowC.push(cls);
      if (cls === 'green') greenCount++;
      else if (cls === 'purple') purpleCount++;
      else otherCount++;
    }
    grid.push(rowC);
  }
  // Derive phase by best fit over BOTH hypotheses rather than trusting a single
  // corner cell (a VP8 artifact / edge bleed can flip it).
  const mismatchesFor = (phase) => {
    let bad = 0;
    for (let ry = 0; ry < rows; ry++) {
      for (let cx = 0; cx < cols; cx++) {
        const expect = ((ry + cx + phase) % 2 === 0) ? 'green' : 'purple';
        if (grid[ry][cx] !== expect) bad++;
      }
    }
    return bad;
  };
  const m0 = mismatchesFor(0), m1 = mismatchesFor(1);
  const phase = m0 <= m1 ? 0 : 1;
  const mismatches = Math.min(m0, m1);
  const total = cols * rows;
  // Require both colours to actually dominate (reject a grey/blank frame that
  // happens to "fit" a phase), and allow up to 15% of cells off (edge bleed /
  // rescale / VP8 loss).
  const hasColour = (greenCount + purpleCount) >= Math.floor(total / 2);
  const checkerboard = hasColour && mismatches <= Math.ceil(total * 0.15);
  return { ok: true, phase, greenCount, purpleCount, otherCount, mismatches,
    checkerboard, videoWidth: w, videoHeight: h };
`;
