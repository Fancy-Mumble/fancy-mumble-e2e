import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID, STREAM_SOURCE_TITLE_ATTR, BROADCASTER_NAME_ATTR } from "../selectors";
import { delay } from "../util/wait";

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

  /** Click the chat-header share toggle (present in both builds). */
  private async clickToggle(timeout = 15000): Promise<void> {
    const toggle = await this.d.wait(until.elementLocated(byTid(TID.screenShareToggle)), timeout);
    await this.d.wait(until.elementIsEnabled(toggle), timeout);
    await toggle.click();
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
    const el = await this.d.wait(
      until.elementLocated(card),
      timeout,
      `screen-share picker never offered a window titled like "${title}"`,
    );
    await el.click();
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
  async openPicker(timeout = 15000): Promise<void> {
    await this.clickToggle(timeout);
    if (!(await this.customPickerAppeared(5000))) {
      throw new Error("custom screen-share picker did not open (old build?)");
    }
  }

  async openPickerDevices(timeout = 15000): Promise<string[]> {
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
    const card = await this.d.wait(
      until.elementLocated(By.css(css)),
      15000,
      `picker never offered ${what}`,
    );
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
    // The stats toggle lives in the stream control bar; hover the viewport to
    // reveal the controls, then click it.
    const statsBtn = await this.d.wait(
      until.elementLocated(By.css('button[aria-label="Stats for Nerds"], button[aria-label="Hide stats for nerds"]')),
      timeout,
      "no Stats-for-Nerds toggle in the stream controls",
    );
    await statsBtn.click();
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
   * Per-track fps from the (open) stats panel's "Current Res" rows
   * ("1234×567@30" -> 30). NaN entries mean the row showed no rate yet.
   */
  async readStatsFps(): Promise<number[]> {
    const rows = await this.d.findElements(byTid(TID.streamStatsResolution));
    const out: number[] = [];
    for (const row of rows) {
      const text = (await row.getText()) ?? "";
      const m = /@(\d+(?:\.\d+)?)/.exec(text);
      out.push(m ? Number(m[1]) : Number.NaN);
    }
    return out;
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
    const rows = await this.d.findElements(
      By.css(`[data-testid="stream-stats-freezes"]`),
    );
    const out: Array<[number, number]> = [];
    for (const row of rows) {
      const text = (await row.getText()) ?? "";
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
    const els = await this.d.findElements(
      By.css(`[data-testid="${TID.streamViewerVideo}"][data-own="true"]`),
    );
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
    const own = By.css(`[data-testid="${TID.streamViewerVideo}"][data-own="true"]`);
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
  async confirmDevice(title: string, timeout = 15000): Promise<void> {
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
    const own = By.css(`[data-testid="${TID.streamViewerVideo}"][data-own="true"]`);
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
    const read = () =>
      this.d.executeScript<number>(
        `const v = document.querySelector('[data-testid="${TID.streamViewerVideo}"][data-own="true"]');
         if (!v) return -1;
         const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
         return q ? q.totalVideoFrames : -1;`,
      );
    const before = await read();
    await delay(windowMs);
    const after = await read();
    if (before < 0 || after < 0) throw new Error("own preview vanished while measuring fps");
    return ((after - before) * 1000) / windowMs;
  }

  /**
   * Assert the own-preview stream KEEPS decoding: sample the `<video>`'s
   * playback position twice, `windowMs` apart, and require it to advance.
   * Catches a broadcast that dies right after its first frames. (A source
   * whose *content* is static still advances - this guards pipeline health,
   * not pixel change.)
   */
  async assertOwnPreviewFlowing(windowMs = 3000): Promise<void> {
    const readTime = () =>
      this.d.executeScript<number>(
        `const v = document.querySelector('[data-testid="${TID.streamViewerVideo}"][data-own="true"]');
         return v ? v.currentTime : -1;`,
      );
    const before = await readTime();
    if (before < 0) throw new Error("own stream preview vanished");
    await delay(windowMs);
    const after = await readTime();
    if (after < 0) throw new Error("own stream preview vanished while playing");
    if (after <= before) {
      throw new Error(
        `own stream preview stopped decoding (currentTime ${before} -> ${after})`,
      );
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
   * Start watching `name`'s broadcast, whichever affordance the UI offers:
   *
   *   - Idle viewer: the "<name> is sharing" banner's Watch button.
   *   - Already broadcasting ourselves: the focus view replaces the banner,
   *     and other streams appear as clickable tiles (secondary panes, or the
   *     bottom drawer - opened via its toggle when collapsed).
   */
  async watchByName(name: string, timeout = 30000): Promise<void> {
    const banner = By.css(
      `[data-testid="${TID.broadcastBanner}"][${BROADCASTER_NAME_ATTR}="${cssAttrEscape(name)}"]`,
    );
    const tile = By.css(
      `[data-testid="${TID.streamWatchTile}"][${BROADCASTER_NAME_ATTR}="${cssAttrEscape(name)}"]`,
    );
    const deadline = Date.now() + timeout;
    for (;;) {
      const rows = await this.d.findElements(banner);
      if (rows.length > 0) {
        const watch = await rows[0].findElement(byTid(TID.broadcastWatch));
        await watch.click();
        break;
      }

      const tiles = await this.d.findElements(tile);
      if (tiles.length > 0) {
        if (await tiles[0].isDisplayed()) {
          await tiles[0].click();
          break;
        }
        // Tile exists but is hidden -> it lives in the collapsed drawer.
        const toggles = await this.d.findElements(byTid(TID.streamDrawerToggle));
        if (toggles.length > 0) {
          await toggles[0].click();
          const reopened = await this.d.findElements(tile);
          if (reopened.length > 0 && (await reopened[0].isDisplayed())) {
            await reopened[0].click();
            break;
          }
        }
      }

      if (Date.now() > deadline) {
        throw new Error(`no "is sharing" banner or watch tile for "${name}" appeared`);
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
      TID.streamViewerVideo,
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
    return this.d.executeScript<{ totalVideoFrames: number; tMs: number }>(
      `
      const video = document.querySelector(
        '[data-testid="' + arguments[0] + '"][data-own="' + arguments[1] + '"]');
      if (!video) return { totalVideoFrames: -1, tMs: Date.now() };
      const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
      return {
        totalVideoFrames: q ? q.totalVideoFrames : (video.webkitDecodedFrameCount ?? -1),
        tMs: Date.now(),
      };
      `,
      TID.streamViewerVideo,
      own ? "true" : "false",
    );
  }

  private async waitVideoReady(own: "true" | "false", timeout: number): Promise<void> {
    const sel = By.css(`[data-testid="${TID.streamViewerVideo}"][data-own="${own}"]`);
    await this.d.wait(until.elementLocated(sel), timeout);
    await this.d.wait(async () => {
      const els = await this.d.findElements(sel);
      if (els.length === 0) return false;
      const w = await this.d.executeScript<number>("return arguments[0].videoWidth || 0;", els[0]);
      return w > 0;
    }, timeout, `stream <video data-own="${own}"> never received frames`);
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
    await this.d.wait(until.elementLocated(sel), timeout);
    await this.d.wait(async () => {
      const els = await this.d.findElements(sel);
      if (els.length === 0) return false;
      const w = await this.d.executeScript<number>("return arguments[0].videoWidth || 0;", els[0]);
      return w > 0;
    }, timeout, `camera PiP <video data-own="${own}"> never received frames`);
  }
}

function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * In-page function (stringified for executeScript): draw the chosen stream
 * video into a canvas and classify a cols x rows grid of cell centres.
 */
const READ_CHECKERBOARD_FN = `
  const testid = arguments[0];
  const own = arguments[1];
  const cols = arguments[2];
  const rows = arguments[3];
  const video = document.querySelector('[data-testid="' + testid + '"][data-own="' + own + '"]');
  const fail = (reason) => ({ ok: false, reason, phase: -1, greenCount: 0, purpleCount: 0,
    otherCount: 0, mismatches: 0, checkerboard: false, videoWidth: 0, videoHeight: 0 });
  if (!video) return fail('no-video-element');
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return fail('no-frames');
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
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
