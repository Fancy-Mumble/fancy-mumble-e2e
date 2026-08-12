/**
 * A fleet of talking bots, for putting a live server under real audio load.
 *
 * Ten clients log in, half announcing the classic pre-1.5 protocol and half
 * the Fancy epoch-1 one, each takes its own room and streams Opus into it until
 * you stop them. The two halves send the two different audio packet formats
 * (`voice/src/packet.rs` decodes both), which is the reason for running them
 * together: a server that mis-decodes one of them is invisible to a fleet that
 * only speaks the other.
 *
 *   npx tsx scripts/audio-bots.mts --host 141.94.42.166 --port 64737
 *   npx tsx scripts/audio-bots.mts --host 127.0.0.1 --dry-run
 *
 * Flags:
 *   --host H --port N     where to connect (default 127.0.0.1:64738)
 *   --admin U             account that creates the rooms (guests may not)
 *   --admin-pass-file F   its password, read from a file rather than argv
 *   --bots N              how many of the roster to start (default all)
 *   --minutes N           stop by itself after N minutes (default: run until ^C)
 *   --frame-ms N          Opus frame duration, 10/20/40/60 (default 20)
 *   --seconds N           how much of each music file to encode (default 90)
 *   --no-loop             play each clip once instead of repeating
 *   --dry-run             encode everything and report, but connect to nothing
 *
 * Rooms are created **temporary**, so the server collects each one as its bot
 * leaves and the fleet cleans up after itself. Audio goes down the TCP tunnel
 * rather than UDP — see the note in `src/util/audio-bot.ts` for why, and for
 * what that means this does not cover.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AudioBot, type BotSpec } from "../src/util/audio-bot";
import { speechFixture, type SourceSpec } from "../src/util/opus-source";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// -- arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

/**
 * Read `.env` from the repo root, if there is one.
 *
 * Hand-rolled rather than a dependency, and deliberately dull: `KEY=value` per
 * line, `#` comments, whitespace around both halves trimmed (`KEY = value` is
 * what people actually write), optional surrounding quotes stripped. An
 * environment variable that is *already* set wins, so an explicit
 * `BOT_ADMIN_PASS=... npx tsx ...` still overrides the file.
 *
 * This is where the room keeper's password lives. `.env` is gitignored; that is
 * checked here rather than assumed, because a password committed by accident is
 * not something to find out about later.
 */
function loadDotEnv(): void {
  const file = path.join(repoRoot, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (key !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const HOST = flag("host") ?? process.env.E2E_SERVER_HOST ?? "127.0.0.1";
const PORT = Number(flag("port") ?? process.env.E2E_SERVER_PORT ?? 64738);
const FRAME_MS = Number(flag("frame-ms") ?? 20);
const CLIP_SECONDS = Number(flag("seconds") ?? 90);
const MINUTES = flag("minutes") ? Number(flag("minutes")) : null;
const LOOP = !has("no-loop");
const DRY_RUN = has("dry-run");

/**
 * Credentials for the account that makes the rooms.
 *
 * Creating a channel is a permission, and a guest on a stock configuration does
 * not have it — without this every bot falls back to the root, which still
 * loads the server but stops testing per-channel routing, the thing most worth
 * testing. The password may come from the environment so it stays out of shell
 * history and out of this file.
 */
const ADMIN = flag("admin") ?? process.env.BOT_ADMIN_USER;

/**
 * The password, from a file if one is named.
 *
 * `--admin-pass-file` is the one to prefer: a password passed as `--admin-pass`
 * is in the process table for anyone on the box to read, and in the shell
 * history afterwards. The file is read once and never echoed.
 */
const ADMIN_PASS = (() => {
  const file = flag("admin-pass-file") ?? process.env.BOT_ADMIN_PASS_FILE;
  if (file) return readFileSync(file, "utf8").trim();
  return flag("admin-pass") ?? process.env.BOT_ADMIN_PASS;
})();

if (![10, 20, 40, 60].includes(FRAME_MS)) {
  console.error(`--frame-ms must be 10, 20, 40 or 60 (got ${FRAME_MS})`);
  process.exit(2);
}

// -- what the bots play -----------------------------------------------------

/** The user's music folder; whatever is in it becomes the "music" sources. */
const MUSIC_DIR = process.env.BOT_MUSIC_DIR ?? path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  "Music",
);

/**
 * Music files, longest-name-last so the pick is stable across runs.
 *
 * Capped at `--seconds` when encoded: one of these is a 196 MB mix, and
 * encoding the whole of it before the first bot says a word would look exactly
 * like a hung connect.
 */
function musicFiles(): string[] {
  if (!existsSync(MUSIC_DIR)) return [];
  return readdirSync(MUSIC_DIR)
    .filter((name) => /\.(mp3|wav|flac|m4a|ogg|opus)$/i.test(name))
    .sort()
    .map((name) => path.join(MUSIC_DIR, name));
}

const music = musicFiles();
const musicSource = (index: number): SourceSpec | null => {
  if (music.length === 0) return null;
  return { kind: "file", path: music[index % music.length], seconds: CLIP_SECONDS };
};

/**
 * A tone bed, for the bots whose job is to be *recognisable* rather than
 * pleasant: a steady chord is trivial to pick out of a recording at the far end
 * when you are asking "did this bot's audio arrive at all".
 */
const chord = (a: number, b: number): SourceSpec => ({
  kind: "lavfi",
  // Two labelled sources joined by `amix`, not a chain: commas would feed the
  // first oscillator *into* the second, which lavfi rejects as an open input.
  filter:
    `sine=frequency=${a}:sample_rate=48000[a];` +
    `sine=frequency=${b}:sample_rate=48000[b];` +
    `[a][b]amix=inputs=2`,
  seconds: 30,
});

const noise: SourceSpec = {
  kind: "lavfi",
  filter: "anoisesrc=color=brown:sample_rate=48000:amplitude=0.4",
  seconds: 30,
};

/**
 * The roster.
 *
 * The names are deliberately in the several styles a real user list actually
 * mixes — bare first names, lowercase handles, and gamer tags with digits and
 * case runs — rather than ten variations of one pattern. A fleet named after
 * the tool that made it is a fleet nobody reads as load, and these sit in the
 * user list beside real people for as long as the test runs.
 *
 * Every name here is inside murmur's default `user_name_regex`
 * (`[-=\w\[\]\{\}\(\)\@\|\.]+`, `runtime/src/settings.rs`), which notably has
 * **no space** in it — unlike the channel pattern, whose leading ` -=` is a
 * range starting at space. A name with a space in it is refused at login.
 *
 * Flavours alternate so the two audio formats stay evenly spread across rooms
 * rather than clustering in the first half of the tree.
 */
function roster(): BotSpec[] {
  const speech: SourceSpec = { kind: "file", path: speechFixture() };

  // **Stammtisch holds three talkers, and two of the three flavours differ on
  // purpose.** One bot per room only ever tests fan-out to an empty room; a
  // room with three concurrent speakers is what exercises mixing, and mixing
  // two *classic* senders with a *fancy* one puts peers on opposite sides of
  // the 1.5 framing split in the same channel. `MumbleVersion::framing_matches`
  // (`gate/src/voice.rs`) says those two cannot exchange audio without the
  // server transcoding the framing, so this is the one room whose routing has
  // a real decision to make rather than a copy.
  const specs: BotSpec[] = [
    { username: "Lena", flavour: "classic", room: "Lounge", source: musicSource(0) ?? chord(220, 330) },
    { username: "xX_Vortex_Xx", flavour: "fancy", room: "Studio", source: musicSource(1) ?? chord(262, 392) },
    { username: "tobiasw", flavour: "classic", room: "Stammtisch", source: speech },
    { username: "n0scope_kev", flavour: "fancy", room: "Stammtisch", source: speech },
    { username: "sam1998", flavour: "classic", room: "Stammtisch", source: speech },
    { username: "Mira", flavour: "classic", room: "Test Tones", source: chord(440, 554) },
    { username: "Frostbyte", flavour: "fancy", room: "Static", source: noise },
    { username: "jonas.h", flavour: "classic", room: "Garage", source: musicSource(0) ?? chord(196, 294) },
    { username: "PixelWraith", flavour: "fancy", room: "Nachtschicht", source: musicSource(1) ?? chord(330, 415) },
    { username: "DerHannes", flavour: "fancy", room: "Jam Room", source: chord(147, 220) },
  ];
  return specs.map((spec) => ({
    ...spec,
    frameMs: FRAME_MS,
    loop: LOOP,
    bitrateKbps: 48,
  }));
}

const all = roster();
const wanted = flag("bots") ? Math.max(1, Math.min(all.length, Number(flag("bots")))) : all.length;
const fleet = all.slice(0, wanted);

// -- run --------------------------------------------------------------------

const stamp = (): string => new Date().toISOString().slice(11, 23);
const log = (who: string, message: string): void =>
  console.log(`${stamp()}  ${who.padEnd(10)}  ${message}`);

console.log(
  `audio-bots: ${fleet.length} bots -> ${HOST}:${PORT}  ` +
    `(${FRAME_MS} ms frames, ${LOOP ? "looping" : "one pass"}${DRY_RUN ? ", DRY RUN" : ""})`,
);
console.log(
  music.length > 0
    ? `music: ${music.map((m) => path.basename(m)).join(", ")} (first ${CLIP_SECONDS}s of each)`
    : `music: none found in ${MUSIC_DIR}; those bots fall back to tones`,
);
// Grouped by room rather than listed flat, so a room with more than one talker
// in it — the point of the exercise — is visible before anything connects.
const byRoom = new Map<string, BotSpec[]>();
for (const bot of fleet) {
  const here = byRoom.get(bot.room);
  if (here) here.push(bot);
  else byRoom.set(bot.room, [bot]);
}
for (const [room, bots] of byRoom) {
  const who = bots.map((b) => `${b.username} (${b.flavour})`).join(", ");
  const many = bots.length > 1 ? ` — ${bots.length} talkers` : "";
  console.log(`  ${room.padEnd(14)}${many.padEnd(14)} ${who}`);
}
console.log();

if (DRY_RUN) {
  const { encodeToOpus, describe } = await import("../src/util/opus-source");
  for (const bot of fleet) {
    const stream = await encodeToOpus(bot.source, FRAME_MS, bot.bitrateKbps ?? 48);
    const seconds = (stream.packets.length * FRAME_MS) / 1000;
    const kbps = (stream.packets.reduce((n, p) => n + p.length, 0) * 8) / seconds / 1000;
    log(
      bot.username,
      `${describe(bot.source)} -> ${stream.packets.length} frames, ` +
        `${seconds.toFixed(1)} s, ${kbps.toFixed(1)} kbit/s`,
    );
  }
  console.log("\ndry run: nothing was connected to.");
  process.exit(0);
}

const running: AudioBot[] = [];
let keeper: AudioBot | null = null;
let shuttingDown = false;

async function shutdown(why: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\naudio-bots: stopping (${why})`);
  clearInterval(reporter);
  await Promise.all(running.map((bot) => bot.stop().catch(() => {})));
  // The keeper goes last: the rooms are temporary, and it is the occupant that
  // keeps an empty one alive while the bots are still leaving.
  await keeper?.stop().catch(() => {});
  report();
  process.exit(0);
}

function report(): void {
  console.log(`\n--- ${stamp()} ---`);
  for (const bot of running) {
    const s = bot.stats();
    const seconds = (s.packetsSent * FRAME_MS) / 1000;
    console.log(
      `  ${s.username.padEnd(10)} ${s.flavour.padEnd(8)} ch=${String(s.channelId).padEnd(4)} ` +
        `${String(s.packetsSent).padStart(7)} frames  ${(s.bytesSent / 1024).toFixed(0).padStart(6)} KiB  ` +
        `${seconds.toFixed(0).padStart(5)} s audio  loops=${s.loops}  ` +
        (s.connected ? "up" : "DOWN") +
        (s.lastError ? ` (${s.lastError})` : ""),
    );
  }
}

process.on("SIGINT", () => void shutdown("interrupted"));
process.on("SIGTERM", () => void shutdown("terminated"));

if (ADMIN) {
  const rooms = [...new Set(fleet.map((bot) => bot.room))];
  try {
    keeper = await AudioBot.roomKeeper(rooms, { username: ADMIN, password: ADMIN_PASS }, {
      host: HOST,
      port: PORT,
      onEvent: log,
    });
  } catch (e) {
    console.error(`audio-bots: the room keeper could not log in: ${(e as Error).message}`);
    console.error("Without it the bots fall back to the root channel.");
  }
} else {
  console.log(
    "no --admin given: the bots will try to make their own rooms and fall back\n" +
      "to the root if the server refuses (a guest usually may not create channels).\n",
  );
}

// Started in sequence, not all at once: six simultaneous logins racing to
// create six channels is a thundering herd against the very handshake being
// measured, and the stagger makes the server log readable.
for (const spec of fleet) {
  try {
    const bot = await AudioBot.start(spec, { host: HOST, port: PORT, onEvent: log });
    running.push(bot);
  } catch (e) {
    log(spec.username, `failed to start: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}

if (running.length === 0) {
  console.error("\naudio-bots: no bot could start.");
  process.exit(1);
}

const reporter = setInterval(report, 15000);
console.log(`\naudio-bots: ${running.length} bot(s) streaming. Ctrl-C to stop.\n`);

if (MINUTES !== null) {
  setTimeout(() => void shutdown(`${MINUTES} minute limit reached`), MINUTES * 60_000);
}
