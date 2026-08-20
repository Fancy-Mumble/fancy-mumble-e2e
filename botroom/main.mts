/**
 * botroom — a room of LLM bots holding a spoken conversation on a Starling
 * server.
 *
 *   npx tsx botroom/main.mts --server my.server:64738 --channel Lounge \
 *       --topic "whether cities should ban private cars" --participants 3
 *
 * The operator names a subject, a headcount and a server; the program invents
 * that many people, logs each of them in as their own Mumble client, and lets
 * them talk. Text goes out as channel messages, speech as Opus down the control
 * connection's tunnel. Anyone who types in the channel joins in.
 *
 * See `docs/BOTROOM-PLAN.md` for the design, the model choices and how this is
 * deployed on the box with the GPUs. `--dry-run` needs neither a server nor a
 * synthesiser and prints the conversation instead, which is the quickest way to
 * see whether the language model end is healthy.
 */

import { AudioBot, type BotSpec } from "../src/util/audio-bot";
import { parseConfig, UsageError, type Config } from "./config";
import { Director, type Speaker } from "./director";
import { Humans, SttClient } from "./humans";
import { LlmClient } from "./llm";
import { makePersonas, voiceRoster } from "./personas";
import { makePhrasebooks } from "./phrases";
import { TtsClient, type Voice } from "./tts";
import { delay, rng } from "./util";

const stamp = (): string => new Date().toISOString().slice(11, 23);
const log = (who: string, message: string): void =>
  console.log(`${stamp()}  ${who.padEnd(12)}  ${message}`);

let config: Config;
try {
  config = parseConfig(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(e.message);
    process.exit(e.isHelp ? 0 : 2);
  }
  throw e;
}

const random = rng(config.seed);
const llm = new LlmClient({
  url: config.llmUrl,
  model: config.llmModel,
  apiKey: config.llmKey,
  temperature: config.temperature,
  topP: config.topP,
  maxTokens: config.maxTokens,
});
const tts =
  config.mute || config.dryRun
    ? null
    : new TtsClient({
        url: config.ttsUrl,
        apiKey: config.ttsKey,
        model: config.ttsModel,
        language: config.language,
      });

console.log(
  `botroom: ${config.participants} bots -> ` +
    `${config.dryRun ? "(dry run, no server)" : `${config.host}:${config.port} #${config.channel}`}\n` +
    `  topic:  ${config.topic}\n` +
    `  llm:    ${config.llmModel} at ${config.llmUrl}\n` +
    `  tts:    ${tts === null ? "(muted)" : `${config.ttsUrl}`}\n` +
    `  stt:    ${config.sttUrl === null || config.dryRun ? "(deaf)" : config.sttUrl}\n`,
);

// -- the models have to be there before anyone logs in ----------------------

const models = await llm.models().catch((e: unknown) => {
  console.error(
    `botroom: the language model endpoint is not answering at ${config.llmUrl}\n` +
      `  ${(e as Error).message}\n` +
      `  Start it, or point --llm-url somewhere else.`,
  );
  process.exit(1);
});
if (models.length > 0 && !models.includes(config.llmModel)) {
  // Not fatal: llama-server reports one id and happily serves any request, and
  // an alias is a normal thing to configure. Worth saying out loud, though,
  // because the other explanation is a typo that would only show up as a 404.
  log("botroom", `note: ${config.llmModel} is not in the endpoint's list (${models.join(", ")})`);
}

let voices: Voice[] = [{ id: "ryan", name: "ryan", lang: "" }];
if (tts !== null) {
  const roster = await tts.voices().catch((e: unknown) => {
    console.error(
      `botroom: the speech endpoint is not answering at ${config.ttsUrl}\n` +
        `  ${(e as Error).message}\n` +
        `  Start it, point --tts-url somewhere else, or run with --mute.`,
    );
    process.exit(1);
  });
  voices = voiceRoster(roster, config);
  log("botroom", `voices: ${voices.map((voice) => voice.id).join(", ")}`);
  const ttsModel = await tts.describe();
  if (ttsModel !== null) log("botroom", `synthesiser: ${ttsModel}`);
}

// Ears are optional. Without them people in the channel are still noticed
// when they talk — the bots stop or complain — but what they said is lost,
// and only what they *type* gets answered.
let stt: SttClient | null = null;
if (config.sttUrl !== null && !config.dryRun) {
  const candidate = new SttClient(config.sttUrl);
  if (await candidate.health()) {
    stt = candidate;
  } else {
    log("botroom", `no speech recogniser at ${config.sttUrl}; people will be heard but not understood`);
  }
}

// -- who is in the room -----------------------------------------------------

const personas = await makePersonas(llm, config, voices, (message) => log("botroom", message));
for (const persona of personas) {
  log(
    persona.name,
    `${persona.username} (${persona.voice}${persona.gender ? `, ${persona.gender}` : ""}) — ` +
      `${persona.character}`,
  );
}
// Started now, awaited after the bots are in: it is one model call of a few
// hundred tokens, and the logins take a couple of seconds anyway.
const phrasebooks$ = makePhrasebooks(llm, personas, config.language, (message) =>
  log("botroom", message),
);
console.log();

// -- connect ----------------------------------------------------------------

const speakers: Speaker[] = [];
let keeper: AudioBot | null = null;
let director: Director | null = null;

const humans = new Humans({
  stt,
  language: config.language,
  random,
  onSpeech: (speech) => director?.humanSpoke(speech),
  log,
});

/** Sessions that belong to us, so the bots do not answer their own echoes. */
const ourSessions = new Set<number>();
/** The connection that listens for everyone; it knows the names. */
let firstBot: AudioBot | null = null;

if (!config.dryRun) {
  if (config.admin) {
    // A guest may not create a channel, so a privileged account makes it and
    // stays until the end — a temporary channel with nobody in it is collected
    // before the first bot arrives (`metadata/src/lib.rs`).
    try {
      keeper = await AudioBot.roomKeeper(
        [config.channel],
        { username: config.admin, password: config.adminPassword },
        { host: config.host, port: config.port, onEvent: log },
      );
    } catch (e) {
      log("botroom", `the room keeper could not log in: ${(e as Error).message}`);
    }
  }

  for (const persona of personas) {
    const spec: BotSpec = {
      username: persona.username,
      password: config.serverPassword,
      flavour: config.flavour,
      room: config.channel,
      frameMs: config.frameMs,
      bitrateKbps: config.bitrateKbps,
      // No `source`: these bots are quiet until the director hands them a line.
    };
    try {
      const bot = await AudioBot.start(spec, {
        host: config.host,
        port: config.port,
        onEvent: log,
        // Only the first connection listens. Every bot sees every message in
        // the channel, so registering this on all of them would put each human
        // line into the transcript once per bot.
        onText:
          speakers.length === 0
            ? (event) => {
                if (event.actor === 0 || ourSessions.has(event.actor)) return;
                director?.humanSaid(event.actorName ?? `session ${event.actor}`, event.message);
              }
            : undefined,
        onVoice:
          speakers.length === 0
            ? (voice) => {
                if (ourSessions.has(voice.sender)) return;
                const name = firstBot?.nameOf(voice.sender) ?? `session ${voice.sender}`;
                humans.voice(voice.sender, name, voice.opus, voice.terminator);
              }
            : undefined,
      });
      firstBot ??= bot;
      ourSessions.add(bot.session);
      speakers.push({ persona, bot, lastTurn: -1 });
    } catch (e) {
      log(persona.username, `could not join: ${(e as Error).message}`);
    }
    // Staggered, like `scripts/audio-bots.mts`: a herd of simultaneous logins
    // races the very handshake it is about to depend on, and makes the server
    // log unreadable.
    await delay(400);
  }

  if (speakers.length < 2) {
    console.error(
      `botroom: only ${speakers.length} of ${personas.length} bots got in; a conversation needs two.`,
    );
    await shutdown("not enough bots", 1);
  }
} else {
  for (const persona of personas) speakers.push({ persona, bot: null, lastTurn: -1 });
}

// -- talk -------------------------------------------------------------------

const phrasebooks = await phrasebooks$;
director = new Director({
  config,
  llm,
  tts,
  speakers,
  humans,
  phrasebooks,
  log,
  random,
});

let shuttingDown = false;

async function shutdown(why: string, code = 0): Promise<never> {
  // A second interrupt means the first one is taking too long — usually a bot
  // waiting out a socket that will not close. Go, rather than making the
  // operator find the pid.
  if (shuttingDown) process.exit(130);
  shuttingDown = true;
  console.log(`\nbotroom: stopping (${why})`);
  director?.stop(why);

  await Promise.all(speakers.map((speaker) => speaker.bot?.stop().catch(() => undefined)));
  // The keeper goes last: the channel is temporary, and it is the occupant that
  // keeps it alive while the bots are still leaving.
  await keeper?.stop().catch(() => undefined);

  const lines = director?.lines ?? [];
  console.log(
    `\nbotroom: ${director?.turnsTaken ?? 0} turns, ` +
      `${lines.filter((line) => line.source === "human").length} from people` +
      (config.transcript ? `, transcript in ${config.transcript}` : ""),
  );
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("interrupted"));
process.on("SIGTERM", () => void shutdown("terminated"));

console.log(
  `botroom: ${speakers.length} bots in ${config.dryRun ? "a dry run" : `#${config.channel}`}. ` +
    `Ctrl-C to stop.\n`,
);

try {
  await director.run();
  await shutdown("the conversation ended");
} catch (e) {
  console.error(`\nbotroom: ${(e as Error).stack ?? String(e)}`);
  await shutdown("failed", 1);
}
