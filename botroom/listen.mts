/**
 * Sit in the channel and report what a real client would hear and read.
 *
 *   npx tsx botroom/listen.mts --server 127.0.0.1:64738 --seconds 120
 *   npx tsx botroom/listen.mts --say "I drive a van for a living. What now?" --say-after 45
 *
 * The bots' own logs prove they *sent* something. This proves the server routed
 * it to somebody else: it logs in as an ordinary guest, counts the audio
 * packets arriving per speaker and prints every message it read. No Opus is
 * decoded — only the sender is read out of each packet — so this is a router
 * check, not an audio-quality one. For quality, listen with a real client.
 *
 * `--say` also makes it the human in the room: the bots should throw away
 * whatever they had prepared and answer.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AudioBot } from "../src/util/audio-bot";
import { parseConfig, UsageError } from "./config";
import { oggOpus, opusPacketSamples } from "./ogg";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

// `--topic` is required by the shared parser and meaningless here.
let host = "127.0.0.1";
let port = 64738;
let channel = "";
try {
  const config = parseConfig([...argv, "--topic", "listening"]);
  ({ host, port, channel } = config);
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  process.exit(e.isHelp ? 0 : 2);
}

const seconds = Number(flag("seconds") ?? 120);
const say = flag("say");
const sayAfter = Number(flag("say-after") ?? 45);
/**
 * `--record DIR` keeps everything that arrives: one Ogg Opus file per speaker,
 * decodable with ffmpeg, plus a timing report — because "it clicks" is a
 * question about what a client *received*, and the senders' own logs cannot
 * answer it. Arrival times per packet show pacing gaps and bursts; the Ogg
 * shows what the audio itself contained.
 */
const record = flag("record");
if (record !== undefined) mkdirSync(record, { recursive: true });

const heard = new Map<number, number>();
const read: string[] = [];
interface Packet {
  at: number;
  opus: Buffer | null;
  terminator: boolean;
}
const captured = new Map<number, Packet[]>();

const bot = await AudioBot.start(
  { username: flag("username") ?? "listener", flavour: "classic", room: channel },
  {
    host,
    port,
    onEvent: (who, message) => console.log(`  ${who}: ${message}`),
    onText: (event) => {
      const line = `${event.actorName ?? `session ${event.actor}`}: ${event.message}`;
      read.push(line);
      console.log(`  ${line}`);
    },
    onVoice: (voice) => {
      heard.set(voice.sender, (heard.get(voice.sender) ?? 0) + 1);
      if (record !== undefined) {
        let list = captured.get(voice.sender);
        if (list === undefined) captured.set(voice.sender, (list = []));
        list.push({ at: performance.now(), opus: voice.opus, terminator: voice.terminator });
      }
    },
  },
);

if (say !== undefined) {
  setTimeout(() => {
    console.log(`\n  >> ${say}\n`);
    bot.sendText(say);
  }, sayAfter * 1000);
}

const finish = async (): Promise<never> => {
  console.log(`\nheard ${heard.size} speaker(s):`);
  for (const [session, packets] of [...heard].sort((a, b) => b[1] - a[1])) {
    // The name may be gone: a bot that has already left took its `UserState`
    // with it, and this prints after the conversation ends.
    const who = bot.nameOf(session) ?? `session ${session}`;
    console.log(`  ${who.padEnd(20)} ${String(packets).padStart(6)} packets = ${((packets * 20) / 1000).toFixed(1)}s`);
  }
  console.log(`\nread ${read.length} message(s).`);
  if (record !== undefined) report(record);
  await bot.stop();
  process.exit(heard.size > 0 ? 0 : 1);
};

/** Write the recordings and say what the arrival timing looked like. */
function report(dir: string): void {
  console.log(`\nrecordings in ${dir}:`);
  for (const [session, packets] of captured) {
    const who = (bot.nameOf(session) ?? `session-${session}`).replace(/[^\w.-]+/g, "_");
    const opus = packets.map((p) => p.opus).filter((p): p is Buffer => p !== null);
    writeFileSync(path.join(dir, `${who}.ogg`), oggOpus(opus));

    // Talk-spurts, and inside each how far *ahead of real time* the sender is:
    // by packet k, k × 20 ms of audio has arrived in (t − t0) of wall clock,
    // and the difference is the lead the receiver has to absorb jitter with.
    // The Fancy client plays with exactly this lead once it is primed, so a
    // lead that touches zero mid-spurt is a click, and a lead that sits at
    // zero is a click train. Holes are the same thing seen from the other
    // side: a packet more than 40 ms later than its predecessor implied.
    let spurts = 0;
    let holes = 0;
    let worstHole = 0;
    let minLead = Number.POSITIVE_INFINITY;
    let leadSum = 0;
    let leadCount = 0;
    let inSpurt = false;
    let last: Packet | null = null;
    let t0 = 0;
    let audioMs = 0;
    for (const p of packets) {
      if (!inSpurt) {
        spurts += 1;
        inSpurt = true;
        t0 = p.at;
        audioMs = 0;
      } else if (last !== null) {
        const gap = p.at - last.at;
        const expected = last.opus ? (opusPacketSamples(last.opus) / 48000) * 1000 : 20;
        if (gap > expected + 40) {
          holes += 1;
          worstHole = Math.max(worstHole, gap);
        }
        // Lead as of this arrival, ignoring the very first packets where the
        // measure is meaningless.
        if (audioMs >= 100) {
          const lead = audioMs - (p.at - t0);
          minLead = Math.min(minLead, lead);
          leadSum += lead;
          leadCount += 1;
        }
      }
      audioMs += p.opus ? (opusPacketSamples(p.opus) / 48000) * 1000 : 20;
      last = p;
      if (p.terminator) {
        inSpurt = false;
        last = null;
      }
    }
    const seconds = opus.reduce((n, p) => n + opusPacketSamples(p), 0) / 48000;
    const lead = leadCount > 0 ? `lead min ${minLead.toFixed(0)} ms, mean ${(leadSum / leadCount).toFixed(0)} ms` : "lead n/a";
    console.log(
      `  ${who.padEnd(20)} ${seconds.toFixed(1)}s in ${spurts} spurts; ${lead}; ` +
        `${holes} holes >40 ms (worst ${worstHole.toFixed(0)} ms)`,
    );
  }
}

process.on("SIGINT", () => void finish());
setTimeout(() => void finish(), seconds * 1000);
console.log(`listening for ${seconds}s as ${bot.spec.username} (session ${bot.session})\n`);
