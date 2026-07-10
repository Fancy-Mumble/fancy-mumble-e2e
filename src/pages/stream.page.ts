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

  /** Switch the custom picker to the "Entire Screen" or "Window" tab. */
  async selectTab(tab: "screens" | "windows"): Promise<void> {
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
    await this.clickToggle(timeout);
    if (await this.customPickerAppeared()) {
      // New build: drive the in-app picker to capture the real OS window.
      await this.selectInCustomPicker(title, timeout);
    } else if (onNativePicker) {
      // Old build: the native getDisplayMedia picker is up - drive it at the OS
      // level to select the real window and confirm.
      await onNativePicker();
    }
    await this.waitOwnPreview();
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

  /** Stop the local broadcast via the header toggle. */
  async stopShare(): Promise<void> {
    const toggle = await this.d.wait(until.elementLocated(byTid(TID.screenShareToggle)), 10000);
    await toggle.click();
  }

  /** Wait for the broadcaster's own loopback preview to carry decoded frames. */
  async waitOwnPreview(timeout = 30000): Promise<void> {
    await this.waitVideoReady("true", timeout);
  }

  /** Wait until a "<name> is sharing" banner appears, then click its Watch button. */
  async watchByName(name: string, timeout = 30000): Promise<void> {
    const banner = By.css(
      `[data-testid="${TID.broadcastBanner}"][${BROADCASTER_NAME_ATTR}="${cssAttrEscape(name)}"]`,
    );
    const row = await this.d.wait(
      until.elementLocated(banner),
      timeout,
      `no "is sharing" banner for "${name}" appeared`,
    );
    const watch = await row.findElement(byTid(TID.broadcastWatch));
    await watch.click();
    await this.waitVideoReady("false", timeout);
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
