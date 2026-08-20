/**
 * Everything the operator chooses, in one typed object.
 *
 * Flags win over the environment, the environment wins over `.env`, and `.env`
 * wins over the defaults. That order exists because the deployment keeps
 * endpoints and passwords in `.env` on the box while a person experimenting
 * overrides one of them on the command line.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Flavour } from "../src/util/audio-bot";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  host: string;
  port: number;
  /**
   * The channel the bots gather in, created by the room keeper if it is
   * missing. Empty means "wherever the server puts them" — the root, whose
   * name is not portable (Starling calls it after the instance).
   */
  channel: string;
  /** Server password, for a server that asks for one. */
  serverPassword?: string;
  /** A privileged account that creates the channel; guests usually may not. */
  admin?: string;
  adminPassword?: string;

  topic: string;
  participants: number;
  language: string;
  /** What the bots announce on the wire. `classic` is plain Mumble 1.4. */
  flavour: Flavour;

  llmUrl: string;
  llmModel: string;
  llmKey?: string;
  temperature: number;
  topP: number;
  maxTokens: number;

  ttsUrl: string;
  ttsKey?: string;
  ttsModel: string;
  /** Restrict the voice roster; empty means "whatever the server offers". */
  voices: string[];

  /** Speech recogniser for what people in the channel say; `null` = deaf. */
  sttUrl: string | null;

  /**
   * Whether the bots may talk over one another when the room is heated. Off,
   * they take strict turns; on, a hot enough exchange gets a collision and a
   * "sorry — go on". People in the channel are handled either way.
   */
  interruptions: boolean;

  frameMs: number;
  bitrateKbps: number;
  /** Silence between turns, picked uniformly from this range. */
  pauseMinMs: number;
  pauseMaxMs: number;

  turns: number | null;
  minutes: number | null;
  /** Nudge the conversation towards a fresh angle this often. */
  steerEvery: number;
  /** How many transcript lines each prompt carries. */
  historyLines: number;

  seed: number | null;
  personaFile?: string;
  transcript?: string;
  /**
   * Appended to every bot's login name. Empty by default: they are people in
   * the room, and "Elena-bot" reads as furniture. Set it when a name collides
   * with a registered account on the target server, which is refused for a
   * guest.
   */
  usernameSuffix: string;
  /**
   * Also post each line as a channel text message.
   *
   * Off by default. The bots speak; a running transcript in the chat window
   * alongside is clutter nobody asked for, and on a busy server it is
   * genuinely noisy. They still *read* what people type either way — this is
   * only about what they send.
   */
  postText: boolean;

  /** Talk in text only — no TTS, no audio. The first milestone's mode. */
  mute: boolean;
  /** Print the conversation instead of connecting to a server at all. */
  dryRun: boolean;
  verbose: boolean;
}

const DEFAULTS = {
  port: 64738,
  channel: "",
  participants: 3,
  language: "English",
  llmUrl: "http://127.0.0.1:8090",
  llmModel: "Qwen3.8-27B",
  ttsUrl: "http://127.0.0.1:8882",
  ttsModel: "tts-1",
  sttUrl: "http://127.0.0.1:9002",
  temperature: 0.75,
  topP: 0.8,
  maxTokens: 160,
  frameMs: 20,
  bitrateKbps: 32,
  pauseMinMs: 350,
  pauseMaxMs: 900,
  steerEvery: 8,
  historyLines: 60,
  usernameSuffix: "",
} as const;

const USAGE = `
botroom — LLM bots that hold a spoken conversation on a Mumble/Starling server

  npx tsx botroom/main.mts --server my.server:64738 --channel Lounge \\
      --topic "whether cities should ban private cars" --participants 3

Where to talk
  --server H[:P]        server to connect to (default 127.0.0.1:${DEFAULTS.port})
  --channel NAME        channel to gather in (default: the root channel)
  --server-pass P       server password, if it has one
  --admin U             account that creates the channel when it is missing
  --admin-pass-file F   its password, read from a file rather than argv

What to talk about
  --topic T             the subject (required)
  --participants N      how many bots (default ${DEFAULTS.participants})
  --language L          language for the conversation (default ${DEFAULTS.language})
  --personas FILE       JSON array of personas instead of generating them
  --seed N              reproducible personas, speaker order and pauses

Models
  --llm-url URL         OpenAI-compatible endpoint (default ${DEFAULTS.llmUrl})
  --llm-model NAME      model id (default ${DEFAULTS.llmModel})
  --tts-url URL         Qwen3-TTS / OpenAI-compatible speech endpoint
  --voices a,b,c        restrict which TTS voices are handed out
  --stt-url URL         Whisper (whisper-asr-webservice) for what people say
                        (default ${DEFAULTS.sttUrl}); --no-stt to run deaf
  --temperature F       sampling temperature (default ${DEFAULTS.temperature})

How long, and how it sounds
  --turns N             stop after N turns
  --minutes N           stop after N minutes
  --pause A-B           silence between turns in ms (default ${DEFAULTS.pauseMinMs}-${DEFAULTS.pauseMaxMs})
  --no-interruptions    bots never talk over each other, however heated
  --frame-ms N          Opus frame duration, 10/20/40/60 (default ${DEFAULTS.frameMs})
  --bitrate N           Opus bitrate in kbit/s (default ${DEFAULTS.bitrateKbps})
  --flavour classic|fancy   which protocol the bots announce (default classic)

Other
  --transcript FILE     append every line as JSONL
  --text                also post each line as a channel message (off by default)
  --username-suffix S   appended to every login name (default: none)
  --mute                text only: no TTS, no audio
  --dry-run             print the conversation, connect to nothing
  --verbose             log prompts and timings
  --help
`;

/**
 * Read `.env` from the repo root.
 *
 * Deliberately dull, and the same shape `scripts/audio-bots.mts` reads:
 * `KEY=value` per line, `#` comments, whitespace trimmed either side, optional
 * quotes stripped. A variable already in the environment wins, so
 * `LLM_URL=... npx tsx ...` still overrides the file.
 */
function loadDotEnv(): void {
  const file = path.join(repoRoot, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 0) continue;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export class UsageError extends Error {
  /** `--help` rather than a mistake; the caller exits 0 for one and 2 for the other. */
  constructor(
    message: string,
    readonly isHelp = false,
  ) {
    super(message);
  }
}

export function parseConfig(argv: string[]): Config {
  loadDotEnv();

  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    if (at < 0) return undefined;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`--${name} needs a value`);
    }
    return value;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const number = (name: string, fallback: number): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got ${raw}`);
    return value;
  };
  const env = (name: string): string | undefined => {
    const value = process.env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
  };

  if (has("help")) throw new UsageError(USAGE, true);

  const server = flag("server") ?? env("BOTROOM_SERVER") ?? "127.0.0.1";
  // A bare IPv6 address would need brackets; splitting on the *last* colon
  // keeps `[::1]:64738` working and leaves `::1` alone.
  const colon = server.lastIndexOf(":");
  const hasPort = colon > server.lastIndexOf("]");
  const host = hasPort ? server.slice(0, colon) : server;
  const port = hasPort ? Number(server.slice(colon + 1)) : DEFAULTS.port;
  if (!Number.isFinite(port)) throw new UsageError(`not a port: ${server}`);

  const topic = flag("topic") ?? env("BOTROOM_TOPIC") ?? "";
  if (topic.trim().length === 0) throw new UsageError("--topic is required");

  const pause = flag("pause");
  let [pauseMinMs, pauseMaxMs] = [DEFAULTS.pauseMinMs as number, DEFAULTS.pauseMaxMs as number];
  if (pause !== undefined) {
    const parts = pause.split("-").map(Number);
    if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) {
      throw new UsageError(`--pause wants MIN-MAX in milliseconds, got ${pause}`);
    }
    [pauseMinMs, pauseMaxMs] = [Math.min(...parts), Math.max(...parts)];
  }

  const adminPassFile = flag("admin-pass-file");
  const flavour = (flag("flavour") ?? "classic") as Flavour;
  if (flavour !== "classic" && flavour !== "fancy") {
    throw new UsageError(`--flavour must be classic or fancy, got ${flavour}`);
  }

  const frameMs = number("frame-ms", DEFAULTS.frameMs);
  if (![10, 20, 40, 60].includes(frameMs)) {
    throw new UsageError(`--frame-ms must be 10, 20, 40 or 60, got ${frameMs}`);
  }

  const participants = number("participants", DEFAULTS.participants);
  if (participants < 2 || participants > 16) {
    throw new UsageError(`--participants must be between 2 and 16, got ${participants}`);
  }

  return {
    host,
    port,
    channel: flag("channel") ?? env("BOTROOM_CHANNEL") ?? DEFAULTS.channel,
    serverPassword: flag("server-pass") ?? env("BOTROOM_SERVER_PASS"),
    admin: flag("admin") ?? env("BOT_ADMIN"),
    adminPassword: adminPassFile
      ? readFileSync(adminPassFile, "utf8").trim()
      : env("BOT_ADMIN_PASS"),

    topic,
    participants,
    language: flag("language") ?? env("BOTROOM_LANGUAGE") ?? DEFAULTS.language,
    flavour,

    llmUrl: (flag("llm-url") ?? env("LLM_URL") ?? DEFAULTS.llmUrl).replace(/\/+$/, ""),
    llmModel: flag("llm-model") ?? env("LLM_MODEL") ?? DEFAULTS.llmModel,
    llmKey: env("LLM_API_KEY"),
    temperature: number("temperature", DEFAULTS.temperature),
    topP: number("top-p", DEFAULTS.topP),
    maxTokens: number("max-tokens", DEFAULTS.maxTokens),

    ttsUrl: (flag("tts-url") ?? env("TTS_URL") ?? DEFAULTS.ttsUrl).replace(/\/+$/, ""),
    ttsKey: env("TTS_API_KEY"),
    ttsModel: flag("tts-model") ?? env("TTS_MODEL") ?? DEFAULTS.ttsModel,
    voices: (flag("voices") ?? env("TTS_VOICES") ?? "")
      .split(",")
      .map((voice) => voice.trim())
      .filter((voice) => voice.length > 0),
    sttUrl: has("no-stt") ? null : (flag("stt-url") ?? env("STT_URL") ?? DEFAULTS.sttUrl).replace(/\/+$/, ""),
    interruptions: !has("no-interruptions"),

    frameMs,
    bitrateKbps: number("bitrate", DEFAULTS.bitrateKbps),
    pauseMinMs,
    pauseMaxMs,

    turns: flag("turns") !== undefined ? number("turns", 0) : null,
    minutes: flag("minutes") !== undefined ? number("minutes", 0) : null,
    steerEvery: number("steer-every", DEFAULTS.steerEvery),
    historyLines: number("history", DEFAULTS.historyLines),

    seed: flag("seed") !== undefined ? number("seed", 0) : null,
    personaFile: flag("personas"),
    transcript: flag("transcript"),
    usernameSuffix: flag("username-suffix") ?? DEFAULTS.usernameSuffix,
    // Muted, text is the only thing left, so asking for silence in both would
    // be asking for nothing at all.
    postText: has("text") || has("mute"),

    mute: has("mute"),
    dryRun: has("dry-run"),
    verbose: has("verbose"),
  };
}
