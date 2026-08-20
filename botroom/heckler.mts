/**
 * A person, for testing: joins the channel, waits, and *talks* — real speech,
 * synthesised, sent as Opus like any client's — over whatever is going on.
 *
 *   npx tsx botroom/heckler.mts --server 127.0.0.1:64738 --tts-url http://127.0.0.1:8882 \
 *       --after 40 --say "Hang on, hang on. What about people who can't walk far?"
 *
 * botroom's human-side path — noticing somebody talking, deciding whether to
 * stop for them, transcribing what they said, answering it — cannot be
 * exercised from the bots' own logs, and asking a person to sit in the channel
 * with a microphone every time something changes does not scale. So this is
 * that person. It reports how many packets it heard from whom, the same as
 * `listen.mts`, so one process covers both jobs.
 *
 * `--say` may be given more than once; each is spoken `--gap` seconds after
 * the previous one finishes. `--username` picks the name the bots will use.
 */

import { AudioBot } from "../src/util/audio-bot";
import { parseConfig, UsageError } from "./config";
import { SpokenLine } from "./line";
import { TtsClient } from "./tts";
import { delay } from "./util";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const flags = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === `--${name}`) out.push(argv[i + 1]);
  return out;
};

let config;
try {
  config = parseConfig([...argv, "--topic", "heckling"]);
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  process.exit(e.isHelp ? 0 : 2);
}

const seconds = Number(flag("seconds") ?? 180);
const after = Number(flag("after") ?? 30);
const gap = Number(flag("gap") ?? 25);
const lines = flags("say");
const voice = flag("voice") ?? "ryan";
const username = flag("username") ?? "Sebastian";

const tts = new TtsClient({ url: config.ttsUrl, model: config.ttsModel, language: config.language });
const heard = new Map<number, number>();
const read: string[] = [];

const bot = await AudioBot.start(
  { username, flavour: "classic", room: config.channel, frameMs: 20, bitrateKbps: 32 },
  {
    host: config.host,
    port: config.port,
    onEvent: (who, message) => console.log(`  ${who}: ${message}`),
    onText: (event) => {
      const line = `${event.actorName ?? `session ${event.actor}`}: ${event.message}`;
      read.push(line);
      console.log(`  ${line}`);
    },
    onVoice: (v) => heard.set(v.sender, (heard.get(v.sender) ?? 0) + 1),
  },
);
console.log(`${username} is in the room (session ${bot.session}); first line in ${after}s\n`);

void (async () => {
  await delay(after * 1000);
  for (const text of lines) {
    console.log(`\n  >> ${username} says: ${text}\n`);
    const line = new SpokenLine(text, {
      tts,
      encode: { frameMs: 20, bitrateKbps: 32 },
      options: { voice, language: config.language },
    });
    await line.speak(bot, 0);
    await delay(gap * 1000);
  }
})();

const finish = async (): Promise<never> => {
  console.log(`\nheard ${heard.size} speaker(s):`);
  for (const [session, packets] of [...heard].sort((a, b) => b[1] - a[1])) {
    const who = bot.nameOf(session) ?? `session ${session}`;
    console.log(`  ${who.padEnd(20)} ${String(packets).padStart(6)} packets = ${((packets * 20) / 1000).toFixed(1)}s`);
  }
  console.log(`\nread ${read.length} message(s).`);
  await bot.stop();
  process.exit(0);
};
process.on("SIGINT", () => void finish());
setTimeout(() => void finish(), seconds * 1000);
