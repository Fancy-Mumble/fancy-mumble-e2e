import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { StarlingServer } from "../util/starling";
import { delay } from "../util/wait";

/**
 * Does voice actually work on Starling?
 *
 * Every other Starling test so far has asserted on the *control* plane —
 * handshakes, channel trees, message ordering. Those can all pass on a server
 * that carries no audio at all, which is exactly the state Starling was in
 * before the voice service existed. This test closes that gap: Alice speaks a
 * 440 Hz tone into a virtual microphone, and Bob's decoder has to find it.
 *
 * # Why a tone and not "packets arrived"
 *
 * Packet counts prove the wire moved. They do not prove the server relayed the
 * right bytes to the right person: a server that forwarded a frame to the wrong
 * session, mangled the Opus payload, or attributed it to the wrong speaker would
 * pass a packet-count assertion and produce silence or noise. A Goertzel ratio
 * on Bob's decoded output is end-to-end — it can only pass if the audio Alice
 * generated came out of Bob's mixer.
 *
 * # What each assertion here would catch
 *
 * | Assertion | The bug it catches |
 * |---|---|
 * | Bob hears the tone | routing, fan-out, cipher, codec — the whole path |
 * | Bob is told Alice spoke | the sender field being trusted instead of overwritten |
 * | Alice does not hear herself | the speaker being left in their own recipient list |
 * | A muted speaker reaches nobody | mute enforcement not reaching the packet path |
 * | The server survives | a panic on the UDP port, which is remotely triggerable |
 *
 * The instrumentation is the client's existing env-gated virtual microphone and
 * wire-stats file, the same pair `audio.resample.test.ts` uses against murmur.
 * Reusing them is deliberate: if Starling and murmur are measured by different
 * instruments, a difference between them is not evidence of anything.
 */

/** How long to wait for the first voice packets to reach Bob. */
const VOICE_TIMEOUT_MS = 25_000;

/** How long to sample the rolling tone window before deciding. */
const LISTEN_MS = 6_000;

/**
 * Goertzel ratio above which the tone is considered present.
 *
 * The same threshold `audio.resample.test.ts` uses. Silence sits near zero and a
 * clean tone near one; 0.4 is comfortably clear of both the noise floor and the
 * loss a lossy network introduces.
 */
const TONE_PRESENT = 0.4;

interface SessionStats {
  packets: number;
  terminators: number;
  first_frame_number: number;
  last_frame_number: number;
  nominal_samples: number;
  buffered: number;
  tone_ratio: number;
}

interface StatsDoc {
  wall_ms: number;
  sessions: Record<string, SessionStats>;
}

function readStats(file: string): StatsDoc | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StatsDoc;
  } catch {
    return null; // not written yet, or caught mid-write
  }
}

/** The session sending the most packets — Alice, from Bob's viewpoint. */
function speaker(doc: StatsDoc | null): SessionStats | null {
  if (!doc) return null;
  let best: SessionStats | null = null;
  for (const stats of Object.values(doc.sessions)) {
    if (!best || stats.packets > best.packets) best = stats;
  }
  return best;
}

/** Poll until a speaker has sent at least `packets`, or give up. */
async function waitForVoice(
  file: string,
  packets: number,
  timeout: number,
): Promise<SessionStats | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = speaker(readStats(file));
    if (found && found.packets >= packets) return found;
    await delay(500);
  }
  return null;
}

/** The best tone ratio seen over `ms`, since the window is rolling. */
async function bestToneOver(file: string, ms: number): Promise<number> {
  let best = 0;
  const polls = Math.max(1, Math.floor(ms / 1000));
  for (let i = 0; i < polls; i++) {
    await delay(1000);
    const found = speaker(readStats(file));
    if (found) best = Math.max(best, found.tone_ratio);
  }
  return best;
}

/**
 * Skip rather than fail when Starling is not the server under test.
 *
 * Two conditions, and the second is the one that bites. A missing binary is a
 * configuration fact on a machine with no Rust toolchain, not a defect.
 *
 * But having a binary is **not** sufficient, because the connect wizard only
 * offers a port field in expert mode — in normal mode it always dials 64738
 * (`src/pages/connect.page.ts`). The instance this file starts on its own port
 * is therefore never the one the client reaches: the clients connect to
 * whatever already owns 64738, and against a murmur fixture this suite asserts
 * Starling's behaviour of a different server entirely. It then fails on
 * `encrypts with XChaCha20-Poly1305, not OCB2` — which murmur is *correct* to
 * not do.
 *
 * So it runs only when told that 64738 is Starling. Opt in with
 * `E2E_SERVER_IMPL=starling`.
 */
const serverIsStarling = (process.env.E2E_SERVER_IMPL ?? "").toLowerCase() === "starling";
const skip = !StarlingServer.available()
  ? `no Starling binary at ${StarlingServer.binary} — build it with ` +
    `\`cargo build -p starling --manifest-path vendor/starling/Cargo.toml\``
  : serverIsStarling
    ? false
    : "the server on 64738 is not Starling — set E2E_SERVER_IMPL=starling to run this file " +
      "(the client always dials 64738, so this suite cannot reach its own instance)";

describe("Starling carries voice", { concurrency: 1, skip }, () => {
  let server: StarlingServer;
  let alice: TauriApp;
  let bob: TauriApp;
  let statsDir: string;
  /** What Bob's decoder received — Alice's voice. */
  let bobStats: string;
  /** What Alice's decoder received, which is how an echo becomes visible. */
  let aliceStats: string;

  const suffix = String(Date.now() % 1_000_000);
  const aliceName = `e2e-SvA-${suffix}`;
  const bobName = `e2e-SvB-${suffix}`;

  before(async () => {
    server = await StarlingServer.start();
    statsDir = mkdtempSync(path.join(os.tmpdir(), "starling-e2e-audio-"));
    bobStats = path.join(statsDir, "bob.json");
    aliceStats = path.join(statsDir, "alice.json");

    // Both speak, at different frequencies so neither can be mistaken for the
    // other, and both record what they received. Alice's file is what makes an
    // echo detectable: Bob's stats cannot show what Alice hears.
    //
    // The virtual microphone means the suite never depends on capture hardware.
    alice = await TauriApp.launch({
      instance: 0,
      extraEnv: {
        FANCY_E2E_VIRTUAL_MIC: "sine:48000:440",
        FANCY_E2E_AUDIO_STATS_FILE: aliceStats,
      },
    });
    bob = await TauriApp.launch({
      instance: 1,
      extraEnv: {
        FANCY_E2E_VIRTUAL_MIC: "sine:48000:300",
        FANCY_E2E_AUDIO_STATS_FILE: bobStats,
      },
    });

    await alice.connect.connect(config.serverHost, aliceName, { port: server.port });
    await bob.connect.connect(config.serverHost, bobName, { port: server.port });
    await alice.chat.waitLoaded(config.connectTimeout);
    await bob.chat.waitLoaded(config.connectTimeout);
    await alice.chat.waitForMember(bobName);
    await bob.chat.waitForMember(aliceName);

    // Fresh profiles start with voice inactive; the first tap of the mute
    // control brings the pipelines up. Alice needs outbound, Bob inbound.
    await alice.chat.tapMute();
    await bob.chat.tapMute();
  });

  after(async () => {
    await Promise.allSettled([alice?.close(), bob?.close()]);
    await server?.stop();
    try {
      rmSync(statsDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("opens a voice port", () => {
    // Not decorative. Starling falls back to tunnelling audio over TCP when the
    // UDP port will not bind, and that fallback is correct — but it would make
    // the rest of this file silently test a different path than intended.
    assert.ok(
      server.voicePortOpen,
      `Starling did not open its voice port; audio would tunnel over TCP:\n${server.log}`,
    );
  });

  it("relays Alice's voice to Bob", async () => {
    const first = await waitForVoice(bobStats, 25, VOICE_TIMEOUT_MS);
    assert.ok(
      first,
      `Bob received no voice packets from Alice within ${VOICE_TIMEOUT_MS / 1000} s. ` +
        `Server log:\n${server.log}`,
    );

    // The end-to-end assertion: the tone Alice generated came out of Bob's
    // mixer. Nothing short of the whole path working produces this.
    const tone = await bestToneOver(bobStats, LISTEN_MS);
    assert.ok(
      tone > TONE_PRESENT,
      `Alice's 440 Hz tone is not in Bob's decoded audio (best ratio ${tone.toFixed(3)}). ` +
        `Packets arrived, so the frames were relayed but their contents were wrong — ` +
        `a mangled payload, the wrong cipher, or the wrong codec for this client.`,
    );
  });

  it("tells Bob who spoke", async () => {
    // The server overwrites the sender field with the authenticated session
    // rather than trusting what the packet claimed. If it trusted the claim,
    // any client could make anyone else's talking indicator light up.
    const doc = readStats(bobStats);
    assert.ok(doc, "no wire stats were written");

    const sessions = Object.keys(doc.sessions);
    assert.ok(
      sessions.length > 0,
      "Bob's decoder attributed the audio to no session at all",
    );
    for (const session of sessions) {
      assert.ok(
        Number(session) > 0,
        `audio was attributed to session ${session}; the server did not stamp the speaker`,
      );
    }
  });

  it("does not echo a speaker back to themselves", async () => {
    // Read from *Alice's* decoder, not Bob's. Bob's stats cannot show what
    // Alice hears, so asserting on them would prove nothing about an echo.
    //
    // Echoing to the speaker is a real Mumble feature, but only on target 31,
    // where a client asks for it to test its own UDP path. Normal speech taking
    // that route is the most immediately obvious audio bug there is.
    const heard = await waitForVoice(aliceStats, 25, VOICE_TIMEOUT_MS);
    assert.ok(heard, "Alice received nothing from Bob, so an echo cannot be ruled out");

    const doc = readStats(aliceStats);
    assert.ok(doc, "Alice's wire stats disappeared");
    assert.equal(
      Object.keys(doc.sessions).length,
      1,
      `Alice's decoder saw ${Object.keys(doc.sessions).length} speakers; ` +
        `only Bob is talking to her, so the extra one is her own voice coming back`,
    );
  });

  it("stops relaying a muted speaker", async () => {
    // Mute enforcement has to reach the packet path, not just the user list.
    // A server that shows Alice as muted while still forwarding her audio is
    // the worst version of this bug: the UI says she is not being heard.
    const doc = readStats(bobStats);
    assert.ok(doc, "no wire stats were written");
    const before = speaker(doc);
    assert.ok(before, "Alice was not speaking before the mute");

    // One tap, not `selfMute()`. The control cycles
    // `inactive -> active -> muted -> active` (`voice-state-sync` walks all
    // four), and `selfMute()` is two taps — right from `inactive`, wrong from
    // here. `before()` already tapped once to bring the pipelines up, so Alice
    // is `active`: two more taps would mute her and immediately unmute her
    // again, and this test would then assert that an unmuted speaker had gone
    // quiet. It failed exactly that way, blaming the packet path.
    await alice.chat.tapMute();
    await bob.chat.waitForMemberMuted(aliceName);

    // Let anything already in flight land, then measure a clean window.
    await delay(1_500);
    const settled = speaker(readStats(bobStats));
    assert.ok(settled, "stats disappeared after the mute");

    await delay(3_000);
    const after = speaker(readStats(bobStats));
    assert.ok(after, "stats disappeared during the muted window");

    assert.equal(
      after.packets,
      settled.packets,
      `Alice is muted but ${after.packets - settled.packets} of her packets still ` +
        `reached Bob — mute is enforced in the user list but not on the packet path`,
    );
  });

  it("encrypts with XChaCha20-Poly1305, not OCB2", () => {
    // The clients are Fancy 0.4.0, so Starling must key them with the modern
    // cipher. This is the assertion that would catch the two ends silently
    // falling back to OCB2 — which they would do while still carrying audio
    // perfectly, so every other test in this file would still pass.
    //
    // OCB2's tag is three bytes against sixteen: one accepted forgery per 2^24
    // attempts, which at 50 packets a second is about four days of trying.
    //
    // Matched without the hyphen, which is not cosmetic. The server logs the
    // *`CipherChoice` variant* — `cipher=XChaCha20Poly1305` — and only
    // `VoiceCipher::name()` spells it `XChaCha20-Poly1305`, which is never
    // logged. The hyphenated pattern therefore could not match a correct server,
    // and this assertion could only ever fail.
    assert.match(
      server.log,
      /XChaCha20-?Poly1305/,
      `Starling keyed a Fancy 0.4.0 client with something other than the modern ` +
        `cipher; audio still works, which is exactly why this needs asserting. ` +
        `Server log:
${server.log}`,
    );
  });

  it("survives everything the test did to it", () => {
    // A panic on the voice path is remotely triggerable by anyone who can send
    // a datagram, so "the process is still up" is a security assertion.
    assert.ok(server.running, `Starling exited during the test:\n${server.log}`);
  });
});
