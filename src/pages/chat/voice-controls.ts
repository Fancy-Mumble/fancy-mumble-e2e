import { until, type WebDriver } from "selenium-webdriver";
import { byTid, TID } from "../../selectors";
import { config } from "../../config";
import { delay } from "../../util/wait";
import { ensureSidebarOpen, clickPossiblyHidden } from "../../util/layout";
import { tauriInvoke } from "../../util/tauri";
import { type MemberRoster } from "./member-panel";

/**
 * The local user's own voice controls - the sidebar mute/deafen buttons, and
 * the backend voice state they drive.
 *
 * Two sources of truth live here on purpose, and the difference between them
 * is what most of these methods exist to manage. {@link state} is the
 * backend's own answer and updates immediately; the roster's `data-muted`
 * indicator reflects the *server-echoed* self_mute and so lags a round-trip.
 * Driving the controls off the indicator makes a tap-until-detected loop
 * oscillate on that lag, which is why the ensure* methods below decide from
 * the backend state and only wait on the indicator to catch up at the end.
 */
export class VoiceControls {
  constructor(
    private readonly d: WebDriver,
    private readonly roster: MemberRoster,
  ) {}

  /**
   * Put the local user into the self-muted state. The mute control cycles
   * inactive -> active -> muted, and a fresh connection starts inactive, so the
   * first click only activates voice; a second click mutes.
   */
  async selfMute(): Promise<void> {
    await this.clickSidebarTid(TID.toggleMute);
    await delay(400);
    await this.clickSidebarTid(TID.toggleMute);
  }

  /** Toggle the local user's self-deafen via the sidebar voice control. */
  async selfDeafen(): Promise<void> {
    await this.clickSidebarTid(TID.toggleDeafen);
  }

  /** Single click of the mute control (cycles inactive -> active -> muted). */
  async tapMute(): Promise<void> {
    await this.clickSidebarTid(TID.toggleMute);
  }

  /** Single click of the deafen control. */
  async tapDeafen(): Promise<void> {
    await this.clickSidebarTid(TID.toggleDeafen);
  }

  /** Wait until the local self row reports the expected muted state. */
  async waitSelfMuted(muted: boolean, timeout = 10000): Promise<void> {
    await this.d.wait(async () => (await this.roster.selfVoiceFlags()).muted === muted, timeout);
  }

  /**
   * The backend's authoritative voice state ("inactive" | "active" | "muted").
   *
   * Lenient by contract: a client whose bridge is not up yet answers "err"
   * rather than throwing, because every caller polls this in a loop and a
   * transient miss is a reason to look again, not to fail the test.
   */
  async state(): Promise<string> {
    try {
      return String(await tauriInvoke(this.d, "get_voice_state"));
    } catch {
      return "err";
    }
  }

  /**
   * Mute (or unmute) the way the tray item and the global shortcut do it -
   * straight at the backend, without the UI's own action.
   *
   * Neither of those can be driven from here: the tray menu is native chrome
   * WebDriver cannot see, and `Ctrl+Shift+M` is registered with the OS rather
   * than the page. What both of them run is this one command, so this is the
   * faithful stand-in - and the path that used to lose the mute, because the
   * preference was written by the UI action rather than by the state change.
   */
  async toggleOutsideTheUi(): Promise<void> {
    await tauriInvoke(this.d, "toggle_mute");
  }

  /** Drive the local user into the backend "muted" voice state (mic off, can hear). */
  async ensureMuted(): Promise<void> {
    // Cycle is inactive -> active -> muted. Decide from the authoritative voice
    // state and wait for each tap to land before tapping again.
    for (let i = 0; i < 6; i++) {
      const vs = await this.state();
      if (vs === "muted") {
        await this.waitSelfMuted(true, 8000).catch(() => undefined); // let the indicator catch up
        return;
      }
      await this.tapMute();
      await this.d.wait(async () => (await this.state()) !== vs, 6000).catch(() => undefined);
    }
  }

  /** Drive the local user into the "active" (voice on, unmuted, undeafened) state. */
  async ensureUnmuted(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const vs = await this.state();
      if (vs === "active") {
        await this.waitSelfMuted(false, 8000).catch(() => undefined);
        return;
      }
      // Undeafen first if needed (deaf implies muted); otherwise tap mute to
      // move muted/inactive -> active.
      if ((await this.roster.selfVoiceFlags()).deaf) await this.tapDeafen();
      else await this.tapMute();
      await this.d.wait(async () => (await this.state()) !== vs, 6000).catch(() => undefined);
    }
  }

  /**
   * Click a control that lives inside `ChannelSidebar` - the self voice
   * buttons. Two things break them on a narrow window: the sidebar is a closed
   * drawer, and the desktop voice actions are then hidden outright. See
   * `ensureSidebarOpen` and `clickPossiblyHidden`.
   */
  private async clickSidebarTid(id: string, timeout = config.waitTimeout): Promise<void> {
    await ensureSidebarOpen(this.d, timeout);
    const el = await this.d.wait(until.elementLocated(byTid(id)), timeout);
    await this.d.wait(until.elementIsEnabled(el), timeout);
    await clickPossiblyHidden(this.d, el);
  }
}
