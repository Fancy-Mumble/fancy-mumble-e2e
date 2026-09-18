import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { tauriInvoke } from "../util/tauri";
import { delay } from "../util/wait";

/**
 * Whisper and shout, end to end.
 *
 * A whisper that works looks exactly like one that falls back into the channel
 * from the speaker's side: they hear their own voice either way. So nothing
 * here asserts on the speaker. Every assertion reads what the *listeners'*
 * decoders received - who got the frames, and what context the server stamped
 * on them - through the client's env-gated wire-stats file.
 *
 * | Assertion | The bug it catches |
 * |---|---|
 * | the channel stops hearing a whisper | speech falling back to target 0 |
 * | no frame is lost at the switch | the target changing before the slot means anything |
 * | the listener's row says "whisper" | the context being decoded and dropped |
 * | release returns speech to the channel | the target left set after the key comes up |
 * | a shout is marked as a shout | contexts 1 and 2 being conflated |
 * | a refused channel is reported | `PermissionDenied` for Whisper swallowed, or handled as a refused listen |
 *
 * Bob sits in a channel of his own, so anything he hears from the speaker can
 * only have reached him as a whisper or a shout; Carol stays in the speaker's
 * channel, so she is the one who must *stop* hearing it.
 *
 * What this file cannot show is *why* the first press loses nothing. On
 * loopback the `VoiceTarget` reaches the server well inside one 20 ms frame, so
 * a slot registered on the press passes the gap check too - measured, by
 * running this file with the pre-registration removed. The race it guards
 * against needs real round-trip time; the ahead-of-time registration itself is
 * covered by `whisperTargets.test.ts` in the client.
 *
 * Carol is also SuperUser, because someone has to create the channels and write
 * the ACL - and it cannot be the speaker. SuperUser holds every permission
 * except Speak and Whisper, on murmur and Starling alike, so that an operator
 * who logs in to fix something is not transmitting by accident. A SuperUser
 * whisper is refused every time; the first run of this file found that out.
 */

const SUPERUSER_PASSWORD = "testpassword";
const ADMIN = "SuperUser";

/** Goertzel ratio above which the speaker's 440 Hz tone is present. */
const TONE_PRESENT = 0.4;

/** `Whisper` in Mumble's permission bits. */
const PERM_WHISPER = 0x100;

/** Voice contexts the server stamps on forwarded frames. */
const CONTEXT = { normal: 0, shout: 1, whisper: 2 } as const;

interface SessionStats {
  packets: number;
  first_frame_number: number;
  last_frame_number: number;
  tone_ratio: number;
  last_context: number;
}

interface StatsDoc {
  sessions: Record<string, SessionStats>;
}

/** What one listener's decoder has received from `session`, if anything. */
function heardFrom(file: string, session: number): SessionStats | null {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as StatsDoc;
    return doc.sessions[String(session)] ?? null;
  } catch {
    return null; // not written yet, or caught mid-write
  }
}

/** Poll `probe` until it returns something truthy, or fail with `what`. */
async function eventually<T>(what: string, probe: () => Promise<T> | T, timeout = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}

/**
 * Whether `file`'s count of frames from `session` held still over `ms`, after
 * letting anything in flight land. The stats file is rewritten once a second.
 */
async function packetsHeldStill(file: string, session: number, ms = 3_000): Promise<{ still: boolean; delta: number }> {
  await delay(1_500);
  const before = heardFrom(file, session)?.packets ?? 0;
  await delay(ms);
  const after = heardFrom(file, session)?.packets ?? 0;
  return { still: after === before, delta: after - before };
}

/**
 * The refused-whisper path is Starling's. murmur answers a refused
 * `VoiceTarget` with nothing at all, so against it there is no refusal to
 * observe and the case would only measure a timeout.
 */
const refusalSkip =
  (process.env.E2E_SERVER_IMPL ?? "").toLowerCase() === "starling"
    ? false
    : "murmur refuses a whisper silently; set E2E_SERVER_IMPL=starling to check the refusal is reported";

describe("whisper and shout", { concurrency: 1 }, () => {
  let speaker: TauriApp;
  let bob: TauriApp;
  let carol: TauriApp;
  let statsDir: string;
  let bobStats: string;
  let carolStats: string;
  let speakerSession: number;
  let bobSession: number;
  let sideChannel: number;

  const suffix = String(Date.now() % 1_000_000);
  const speakerName = `e2e-WhS-${suffix}`;
  const bobName = `e2e-WhB-${suffix}`;

  const whisperToBob = () => [
    { sessions: [bobSession], channelId: null, group: null, links: false, children: false },
  ];

  async function channelNamed(app: TauriApp, name: string): Promise<number> {
    const found = await eventually(`channel ${name}`, async () => {
      const channels = await tauriInvoke<{ id: number; name: string }[]>(app.driver, "get_channels");
      return channels.find((channel) => channel.name === name);
    });
    return found.id;
  }

  async function createChannel(name: string): Promise<number> {
    await tauriInvoke(carol.driver, "create_channel", { parentId: 0, name });
    return channelNamed(carol, name);
  }

  before(async () => {
    setSuperUserPassword(SUPERUSER_PASSWORD);
    statsDir = mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-audio-"));
    bobStats = path.join(statsDir, "bob.json");
    carolStats = path.join(statsDir, "carol.json");

    [speaker, bob, carol] = await TauriApp.launchAll(
      { instance: 0, extraEnv: { FANCY_E2E_VIRTUAL_MIC: "sine:48000:440" } },
      {
        instance: 1,
        extraEnv: { FANCY_E2E_VIRTUAL_MIC: "sine:48000:300", FANCY_E2E_AUDIO_STATS_FILE: bobStats },
      },
      {
        instance: 2,
        extraEnv: { FANCY_E2E_VIRTUAL_MIC: "sine:48000:300", FANCY_E2E_AUDIO_STATS_FILE: carolStats },
      },
    );

    await carol.connect.connect(config.serverHost, ADMIN, {
      port: config.serverPort,
      password: SUPERUSER_PASSWORD,
    });
    await Promise.all([
      speaker.connect.connect(config.serverHost, speakerName, { port: config.serverPort }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
    ]);
    await Promise.all([
      speaker.chat.waitLoaded(config.connectTimeout),
      bob.chat.waitLoaded(config.connectTimeout),
      carol.chat.waitLoaded(config.connectTimeout),
    ]);
    await Promise.all([
      speaker.chat.roster.waitForMember(bobName),
      bob.chat.roster.waitForMember(speakerName),
      carol.chat.roster.waitForMember(speakerName),
    ]);

    speakerSession = await eventually("the speaker's session", () =>
      tauriInvoke<number | null>(speaker.driver, "get_own_session"),
    );
    bobSession = await eventually("Bob's session", () =>
      tauriInvoke<number | null>(bob.driver, "get_own_session"),
    );

    // Bob in a room of his own, before anyone speaks: whatever he hears from
    // the speaker after this can only be a whisper or a shout.
    sideChannel = await createChannel(`e2e-whisper-side-${suffix}`);
    await tauriInvoke(bob.driver, "join_channel", { channelId: sideChannel });
    await eventually("Bob to arrive in his channel", async () => {
      const users = await tauriInvoke<{ session: number; channel_id: number }[]>(speaker.driver, "get_users");
      return users.find((user) => user.session === bobSession)?.channel_id === sideChannel;
    });

    // The speaker transmits; the listeners only listen. The control cycles
    // inactive -> active -> muted, so the listeners take two taps.
    await speaker.chat.voice.tapMute();
    for (const listener of [bob, carol]) {
      await listener.chat.voice.tapMute();
      await eventually("a listener's voice to come up", async () => (await listener.chat.voice.state()) === "active");
      await listener.chat.voice.tapMute();
      await eventually("a listener to mute", async () => (await listener.chat.voice.state()) === "muted");
    }
  });

  after(async () => {
    try {
      await tauriInvoke(speaker.driver, "whisper_end");
    } catch {
      /* best effort */
    }
    await Promise.allSettled([speaker?.close(), bob?.close(), carol?.close()]);
    try {
      rmSync(statsDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("carries ordinary speech to the speaker's channel only", async () => {
    const heard = await eventually("Carol to hear the speaker", () => {
      const stats = heardFrom(carolStats, speakerSession);
      return stats && stats.packets >= 25 ? stats : null;
    });
    assert.equal(heard.last_context, CONTEXT.normal, "channel speech arrived with a non-normal context");
    assert.equal(
      heardFrom(bobStats, speakerSession),
      null,
      "Bob is in another channel but heard the speaker before any whisper",
    );
  });

  it("whispers to its target only, losing no frame at the switch", async () => {
    const sent = await tauriInvoke<boolean>(speaker.driver, "whisper_register", {
      slot: 1,
      targets: whisperToBob(),
    });
    assert.equal(sent, true, "registering a fresh slot sent no VoiceTarget");
    // What the sync does in the app: the slot is registered well before the key.
    await delay(1_000);

    await tauriInvoke(speaker.driver, "whisper_start", { slot: 1, targets: whisperToBob() });

    const bobHeard = await eventually("Bob to hear the whisper", () => {
      const stats = heardFrom(bobStats, speakerSession);
      return stats && stats.packets >= 25 ? stats : null;
    });
    assert.equal(bobHeard.last_context, CONTEXT.whisper, "Bob's frames were not stamped as a whisper");
    // The tone window is rolling, so give it a few snapshots to fill.
    await eventually(
      "the speaker's tone in Bob's decoded audio",
      () => (heardFrom(bobStats, speakerSession)?.tone_ratio ?? 0) > TONE_PRESENT,
      8_000,
    );

    const carolWhile = await packetsHeldStill(carolStats, speakerSession);
    assert.ok(carolWhile.still, `Carol kept hearing the speaker during a whisper (${carolWhile.delta} more frames)`);

    // No frame lost at the switch: the last frame Carol heard and the first one
    // Bob heard are consecutive in the speaker's sequence. A slot registered on
    // the press instead drops the frames that overtake the registration.
    const carol = heardFrom(carolStats, speakerSession);
    const bobNow = heardFrom(bobStats, speakerSession);
    assert.ok(carol && bobNow, "stats disappeared");
    const step = Math.max(1, Math.round((carol.last_frame_number - carol.first_frame_number) / Math.max(1, carol.packets - 1)));
    const gap = bobNow.first_frame_number - carol.last_frame_number;
    assert.ok(
      gap > 0 && gap <= step,
      `${Math.round(gap / step) - 1} frame(s) went to nobody between the channel and the whisper ` +
        `(Carol's last ${carol.last_frame_number}, Bob's first ${bobNow.first_frame_number}, step ${step})`,
    );
  });

  it("tells the listener it is a whisper", async () => {
    await bob.chat.roster.waitForMemberVoiceContext(speakerName, "whisper");
  });

  it("reports the whisper on the speaker's side", async () => {
    assert.equal(await tauriInvoke<boolean>(speaker.driver, "get_whisper_active"), true);
  });

  it("returns speech to the channel when the key comes up", async () => {
    const before = heardFrom(carolStats, speakerSession)?.packets ?? 0;
    await tauriInvoke(speaker.driver, "whisper_end");
    const back = await eventually("Carol to hear the speaker again", () => {
      const stats = heardFrom(carolStats, speakerSession);
      return stats && stats.packets >= before + 25 ? stats : null;
    });
    assert.equal(back.last_context, CONTEXT.normal);
    const bobAfter = await packetsHeldStill(bobStats, speakerSession);
    assert.ok(bobAfter.still, `Bob kept hearing the speaker after the whisper ended (${bobAfter.delta} more frames)`);
    assert.equal(await tauriInvoke<boolean>(speaker.driver, "get_whisper_active"), false);
  });

  it("marks a shout as a shout", async () => {
    const before = heardFrom(bobStats, speakerSession)?.packets ?? 0;
    await tauriInvoke(speaker.driver, "whisper_start", {
      slot: 2,
      targets: [{ sessions: [], channelId: sideChannel, group: null, links: false, children: false }],
    });
    try {
      const shout = await eventually("Bob to hear the shout", () => {
        const stats = heardFrom(bobStats, speakerSession);
        return stats && stats.packets >= before + 25 ? stats : null;
      });
      assert.equal(shout.last_context, CONTEXT.shout, "a shout into Bob's channel was not stamped as a shout");
      await bob.chat.roster.waitForMemberVoiceContext(speakerName, "shout");
    } finally {
      await tauriInvoke(speaker.driver, "whisper_end");
    }
  });

  it("whispers from a muted mic, and mutes it again on release", async () => {
    // The press takes push-to-talk here rather than retargeting a live mic,
    // which is the path every case above skips: their speaker is already on.
    await speaker.chat.voice.tapMute();
    await eventually("the speaker to mute", async () => (await speaker.chat.voice.state()) === "muted");
    const bobBefore = heardFrom(bobStats, speakerSession)?.packets ?? 0;

    try {
      await tauriInvoke(speaker.driver, "whisper_start", { slot: 1, targets: whisperToBob() });
      assert.equal(await speaker.chat.voice.state(), "active", "the whisper key did not open the mic");

      const heard = await eventually("Bob to hear a whisper from a muted mic", () => {
        const stats = heardFrom(bobStats, speakerSession);
        return stats && stats.packets >= bobBefore + 25 ? stats : null;
      });
      assert.equal(heard.last_context, CONTEXT.whisper, "a push-to-talk whisper was not stamped as a whisper");
      const carolWhile = await packetsHeldStill(carolStats, speakerSession);
      assert.ok(carolWhile.still, `a push-to-talk whisper reached the channel (${carolWhile.delta} frames)`);

      await tauriInvoke(speaker.driver, "whisper_end");
      await eventually("the mic to mute again", async () => (await speaker.chat.voice.state()) === "muted");
      const bobAfter = await packetsHeldStill(bobStats, speakerSession);
      assert.ok(bobAfter.still, `the mic kept sending after release (${bobAfter.delta} frames)`);
    } finally {
      await tauriInvoke(speaker.driver, "whisper_end").catch(() => undefined);
      await speaker.chat.voice.ensureUnmuted();
    }
  });

  it("whispers to several users at once, wherever they stand", async () => {
    const carolSession = await eventually("Carol's session", () =>
      tauriInvoke<number | null>(carol.driver, "get_own_session"),
    );
    const bobBefore = heardFrom(bobStats, speakerSession)?.packets ?? 0;
    const carolBefore = heardFrom(carolStats, speakerSession)?.packets ?? 0;

    // Bob in his own channel, Carol in the speaker's: one slot names both.
    await tauriInvoke(speaker.driver, "whisper_start", {
      slot: 4,
      targets: [{ sessions: [bobSession, carolSession], channelId: null, group: null, links: false, children: false }],
    });
    try {
      const [bobHeard, carolHeard] = await Promise.all([
        eventually("Bob to hear the group whisper", () => {
          const stats = heardFrom(bobStats, speakerSession);
          return stats && stats.packets >= bobBefore + 25 ? stats : null;
        }),
        eventually("Carol to hear the group whisper", () => {
          const stats = heardFrom(carolStats, speakerSession);
          return stats && stats.packets >= carolBefore + 25 && stats.last_context === CONTEXT.whisper ? stats : null;
        }),
      ]);
      assert.equal(bobHeard.last_context, CONTEXT.whisper, "Bob's copy was not stamped as a whisper");
      assert.equal(carolHeard.last_context, CONTEXT.whisper, "Carol's copy was not stamped as a whisper");
    } finally {
      await tauriInvoke(speaker.driver, "whisper_end");
    }
  });

  it("reports a channel the server refuses whispers into", { skip: refusalSkip }, async () => {
    const closed = await createChannel(`e2e-whisper-closed-${suffix}`);
    await tauriInvoke(carol.driver, "update_acl", {
      acl: {
        channel_id: closed,
        inherit_acls: true,
        groups: [],
        acls: [
          {
            apply_here: true,
            apply_subs: true,
            inherited: false,
            user_id: null,
            group: "all",
            grant: 0,
            deny: PERM_WHISPER,
          },
        ],
      },
    });
    await delay(1_000);

    await tauriInvoke(speaker.driver, "whisper_register", {
      slot: 3,
      targets: [{ sessions: [], channelId: closed, group: null, links: false, children: false }],
    });
    const denied = await eventually("the refusal to be reported", async () => {
      const channels = await tauriInvoke<number[]>(speaker.driver, "get_whisper_denials");
      return channels.includes(closed) ? channels : null;
    });
    assert.ok(!denied.includes(sideChannel), "a channel the speaker may whisper into was reported as refused");

    // The refusal must not be mistaken for a refused listen or join: the
    // speaker is still where they were, able to talk to Carol.
    const users = await tauriInvoke<{ session: number; channel_id: number }[]>(speaker.driver, "get_users");
    assert.notEqual(users.find((user) => user.session === speakerSession)?.channel_id, closed);
  });
});
