import { until, type WebDriver } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { config } from "../config";
import { isNebula } from "../ui-flavour";
import { clickWhenFree, dismissMenus, waitDisplayed } from "../util/nebula";
import { ensureSidebarOpen, clickPossiblyHidden } from "../util/layout";
import { ChatComposer } from "./chat/composer";
import { ChatHeader } from "./chat/header";
import { MessageList } from "./chat/message-list";
import { MessageActions } from "./chat/message-actions";
import { PollSurface } from "./chat/poll";
import { PinnedPanel } from "./chat/pinned";
import { KeySharePrompts } from "./chat/key-shares";
import { ConnectPrompts } from "./chat/connect-prompts";
import { DesktopNotifications } from "./chat/notifications";
import { MemberRoster } from "./chat/member-panel";
import { VoiceControls } from "./chat/voice-controls";

export { type VoiceFlags } from "./chat/member-panel";
export { type CapturedNotification } from "./chat/notifications";

/**
 * The chat view - Standard's `ChatView.tsx`, Nebula's chat route.
 *
 * This object owns almost nothing itself. It mirrors the client's own
 * composition: the view mounts a composer, a transcript, a header, a member
 * panel and a set of dialogs, and each of those has a page object of its own
 * under `pages/chat/`. What stays here is what the *view* is responsible for -
 * being mounted, and the two flows that cross its children (opening a DM,
 * leaving the server).
 *
 * Reach a component through its property: `chat.composer.send(...)`,
 * `chat.messages.waitForText(...)`, `chat.roster.waitForMember(...)`. The name
 * of that property answers "which part of the UI is this test actually
 * exercising", which a flat `chat.*` surface could not.
 */
export class ChatPage {
  /** The message composer: textarea, send button, attach menu. */
  readonly composer: ChatComposer;
  /** The chat header: title, E2E badge, channel kebab. */
  readonly header: ChatHeader;
  /** The transcript and what it is currently rendering. */
  readonly messages: MessageList;
  /** Per-message controls: the message menu and the reaction bar. */
  readonly actions: MessageActions;
  /** The poll composer and the cards it posts. */
  readonly poll: PollSurface;
  /** The pinned-message panel. */
  readonly pinned: PinnedPanel;
  /** The encryption-key consent banner and dialog. */
  readonly keyShares: KeySharePrompts;
  /** The welcome and plugin-trust modals a connect raises. */
  readonly prompts: ConnectPrompts;
  /** Desktop notifications the app raised while the test ran. */
  readonly notifications: DesktopNotifications;
  /** The member list shown alongside the chat. */
  readonly roster: MemberRoster;
  /** The local user's own mute/deafen controls and backend voice state. */
  readonly voice: VoiceControls;

  constructor(private readonly d: WebDriver) {
    this.composer = new ChatComposer(d);
    this.header = new ChatHeader(d);
    this.messages = new MessageList(d);
    this.actions = new MessageActions(d);
    this.poll = new PollSurface(d, this.composer, this.header);
    this.pinned = new PinnedPanel(d, this.header);
    this.keyShares = new KeySharePrompts(d);
    this.prompts = new ConnectPrompts(d);
    this.notifications = new DesktopNotifications(d);
    this.roster = new MemberRoster(d);
    this.voice = new VoiceControls(d, this.roster);
  }

  /**
   * Resolves once the chat composer is mounted, which only happens after the
   * connection is up and the post-connect bootstrap (channels/users/own
   * session) has completed.
   *
   * Both connect-time modals are answered here rather than left to the caller:
   * an unanswered plugin-trust overlay swallows clicks and fails some later,
   * unrelated step. See {@link ConnectPrompts}.
   */
  async waitLoaded(timeout = 45000): Promise<void> {
    await this.d.wait(until.elementLocated(byTid(TID.chatComposerInput)), timeout);
    await this.prompts.answerAll();
  }

  /**
   * Open a direct-message conversation with a user by clicking their member
   * row (a single click enters DM mode - see ChannelSidebar.handleUserClick ->
   * selectDmUser). The row must be present and online, so this doubles as a
   * check that the user is currently visible in the roster.
   */
  async openDirectMessage(name: string): Promise<void> {
    await this.roster.ensureVisible();
    const row = await this.d.wait(until.elementLocated(this.roster.row(name)), config.waitTimeout);
    // A sidebar row like any other: on a narrow window it is in the DOM and
    // out of reach.
    await clickPossiblyHidden(this.d, row);
  }

  /** Open a DM with `name` and send them `text` directly. */
  async sendDirectMessage(name: string, text: string): Promise<void> {
    await this.openDirectMessage(name);
    await this.composer.send(text);
  }

  /**
   * End the session with the server (returns to the connect screen).
   *
   * The control belongs to the sidebar chrome rather than to the chat itself,
   * but it is where a test that has been driving the chat reaches for it.
   * Standard puts a Disconnect button in the channel sidebar and acts on the
   * click. Nebula files it in the self dock's overflow menu and asks first, so
   * the confirmation is answered here - a caller that wanted to leave has
   * already decided.
   */
  async disconnect(): Promise<void> {
    // Another ChannelSidebar control, so it is behind the drawer on a narrow
    // window exactly like the voice toggles.
    await ensureSidebarOpen(this.d);
    if (isNebula) {
      await dismissMenus(this.d);
      const menu = await waitDisplayed(this.d, byTid(TID.selfDockMenu), config.waitTimeout);
      await clickWhenFree(menu);
    }
    const btn = await this.d.wait(until.elementLocated(byTid(TID.disconnectServer)), 10000);
    await clickPossiblyHidden(this.d, btn);
    if (!isNebula) return;
    const confirm = await this.d.wait(
      until.elementLocated(byTid(TID.disconnectConfirm)),
      config.waitTimeout,
      "nebula's leave-server confirmation never appeared",
    );
    // The dock menu's backdrop is still fading while this dialog's is fading
    // in; a click that lands between the two hits the wrong layer.
    await clickWhenFree(confirm);
  }
}
