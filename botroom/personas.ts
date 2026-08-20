/**
 * Who is in the room.
 *
 * The operator names a topic and a headcount; the personas come from one LLM
 * call, because a fixed roster produces the same argument every time and the
 * whole point of naming a topic is that the conversation is about it. A
 * `--personas` file overrides that for a run you want to repeat exactly, and a
 * built-in roster covers the model returning something unusable — a bot fleet
 * that refuses to start because a JSON array had a trailing comma would be a
 * poor trade.
 */

import { readFileSync } from "node:fs";

import type { Config } from "./config";
import type { LlmClient } from "./llm";
import type { Voice } from "./tts";
import { languageTag, toUsername } from "./util";

export interface Persona {
  /** What the others call them. */
  name: string;
  /** What they log in as; unique across the fleet. */
  username: string;
  /** One line of character: job, temperament, verbal habits. */
  character: string;
  /** Where they stand on the topic, so the room disagrees about something. */
  stance: string;
  /** TTS preset. */
  voice: string;
  /** Style hint passed to the synthesiser, e.g. "Dry and unhurried." */
  instruct?: string;
  /**
   * Which voice pool they belong in, as the presets label themselves.
   *
   * The model that invents the name is the thing that knows how the name
   * reads, so it is asked outright rather than guessed at from a list of name
   * endings. Every such list is wrong about somebody, and it would have to be
   * wrong in each language the room can be run in.
   */
  gender?: "m" | "f";
}

const FALLBACK = [
  { name: "Marisa", gender: "f", character: "an economist who thinks in trade-offs and numbers", stance: "for" },
  { name: "Tobias", gender: "m", character: "a sceptical engineer who wants to know how it would actually work", stance: "against" },
  { name: "Nadia", gender: "f", character: "a city cyclist, quick and impatient, argues from lived experience", stance: "strongly for" },
  { name: "Ellis", gender: "m", character: "a historian who keeps reaching for precedent", stance: "undecided" },
  { name: "Priya", gender: "f", character: "a paramedic, blunt, cares about consequences on the ground", stance: "against" },
  { name: "Ronan", gender: "m", character: "a philosopher who enjoys complicating the question", stance: "sideways" },
  { name: "Yuki", gender: "f", character: "a data journalist who asks where the numbers came from", stance: "undecided" },
  { name: "Sam", gender: "m", character: "a small-business owner with a stake in the outcome", stance: "against" },
] as const;

/**
 * The voices this run may hand out, best first.
 *
 * Presets that do not claim the conversation language are ranked down but not
 * excluded: the Qwen3-TTS list is `en,zh` heavy, and a German conversation with
 * no voices at all would be worse than one in an English-trained voice.
 *
 * Genders are carried rather than flattened away to ids, because the
 * assignment below needs them.
 */
export function voiceRoster(voices: Voice[], config: Config): Voice[] {
  if (config.voices.length > 0) {
    // Named explicitly. Each one is looked up so its gender survives; a name
    // that is not in the roster is somebody's voice clone, gender unknown.
    return config.voices.map(
      (id) => voices.find((voice) => voice.id === id) ?? { id, name: id, lang: "" },
    );
  }
  if (voices.length === 0) return [{ id: "ryan", name: "ryan", lang: "" }];

  const tag = languageTag(config.language);
  const speaks = (voice: Voice): boolean =>
    tag === undefined ||
    voice.lang
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .includes(tag);

  return [...voices.filter(speaks), ...voices.filter((voice) => !speaks(voice))];
}

/**
 * Give every persona a voice of their own gender.
 *
 * Matching beats distinctness: two men sharing a voice is a coincidence, while
 * Elena in a man's voice is a room nobody believes for a second. Within a
 * gender the presets go round-robin, so one is only reused after the pool runs
 * out — Qwen3-TTS offers nine, five of them men.
 *
 * A persona whose gender the model did not give falls back to the general
 * rotation rather than being pushed into one pool.
 */
function assignVoices(drafts: Draft[], voices: Voice[]): string[] {
  const pool = (gender: "m" | "f"): Voice[] =>
    voices.filter((voice) => (gender === "f" ? voice.gender === "f" : voice.gender === "m"));
  const taken = { m: 0, f: 0, any: 0 };

  return drafts.map((draft) => {
    const wanted = draft.gender;
    const matching = wanted === undefined ? [] : pool(wanted);
    if (wanted !== undefined && matching.length > 0) {
      return matching[taken[wanted]++ % matching.length].id;
    }
    return voices[taken.any++ % voices.length].id;
  });
}

export async function makePersonas(
  llm: LlmClient,
  config: Config,
  voices: Voice[],
  log: (message: string) => void,
): Promise<Persona[]> {
  const drafts = (
    config.personaFile
      ? readPersonaFile(config.personaFile, config.participants)
      : await generate(llm, config, log)
  ).slice(0, config.participants);

  const chosen = assignVoices(drafts, voices);
  const used = new Set<string>();
  return drafts.map((draft, index) => {
    let username = `${toUsername(draft.name)}${config.usernameSuffix}`;
    // Two personas called "Sam" would be one bot: same-named connections from
    // one address replace each other silently rather than being refused
    // (`handshake.rs`, `may_replace`).
    let attempt = 2;
    while (used.has(username.toLowerCase())) username = `${toUsername(draft.name)}${attempt++}${config.usernameSuffix}`;
    used.add(username.toLowerCase());
    return {
      name: draft.name,
      username,
      character: draft.character,
      stance: draft.stance,
      voice: chosen[index],
      gender: draft.gender,
      instruct: draft.instruct,
    };
  });
}

type Draft = Pick<Persona, "name" | "character" | "stance" | "instruct" | "gender">;

const PERSONA_SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          gender: { type: "string", enum: ["m", "f"] },
          character: { type: "string" },
          stance: { type: "string" },
          instruct: { type: "string" },
        },
        required: ["name", "gender", "character", "stance", "instruct"],
        additionalProperties: false,
      },
    },
  },
  required: ["people"],
  additionalProperties: false,
} as const;

async function generate(llm: LlmClient, config: Config, log: (message: string) => void): Promise<Draft[]> {
  const prompt =
    `Invent ${config.participants} people for a spoken conversation about: ${config.topic}\n\n` +
    `Return JSON: an object with a "people" array of ${config.participants} objects, ` +
    `each with exactly these keys:\n` +
    `  "name": a single given name, no title, distinct from the others and easy to say aloud\n` +
    `  "gender": "m" or "f" — how the name you chose reads. It picks their voice, so it must match.\n` +
    `  "character": one short clause — their job and their temperament\n` +
    `  "stance": one short clause — what they think about the topic\n` +
    `  "instruct": one short clause describing how they sound, e.g. "Dry and unhurried."\n\n` +
    `They must disagree with each other in interesting ways: at least two should hold ` +
    `opposing positions and at least one should be unsure. Names should suit a ` +
    `${config.language} conversation.`;

  try {
    // Constrained to the schema where the server supports it, so a persona
    // never arrives with `gender: "female"` or a trailing paragraph of prose.
    const answer = await llm.chatJson([{ role: "user", content: prompt }], PERSONA_SCHEMA, {
      temperature: 1.0,
      maxTokens: 900,
    });
    const drafts = parseDrafts(JSON.stringify(answer));
    if (drafts.length >= config.participants) return drafts;
    log(
      `the model described ${drafts.length} of ${config.participants} personas; ` +
        `filling the rest from the built-in roster`,
    );
    return [...drafts, ...fallbackDrafts(config)].slice(0, config.participants);
  } catch (e) {
    log(`could not generate personas (${(e as Error).message}); using the built-in roster`);
    return fallbackDrafts(config);
  }
}

/**
 * Pull the array out of whatever the model wrapped it in.
 *
 * Fenced blocks, a leading sentence and a trailing apology are all common even
 * with "ONLY JSON" in the prompt, so the text between the first `[` and the
 * last `]` is what gets parsed.
 */
function parseDrafts(answer: string): Draft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    const start = answer.indexOf("[");
    const end = answer.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
      parsed = JSON.parse(answer.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  // Either the schema's `{people: [...]}` or a bare array from a persona file.
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { people?: unknown }).people)) {
    parsed = (parsed as { people: unknown[] }).people;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map<Draft>((entry) => ({
      name: String(entry.name ?? "").trim(),
      character: String(entry.character ?? "").trim(),
      stance: String(entry.stance ?? "").trim(),
      instruct: entry.instruct !== undefined ? String(entry.instruct).trim() : undefined,
      gender: entry.gender === "f" || entry.gender === "m" ? entry.gender : undefined,
    }))
    .filter((draft) => draft.name.length > 0 && draft.character.length > 0);
}

function readPersonaFile(file: string, wanted: number): Draft[] {
  const drafts = parseDrafts(readFileSync(file, "utf8"));
  if (drafts.length === 0) throw new Error(`${file}: no usable personas in it`);
  if (drafts.length < wanted) {
    throw new Error(`${file}: has ${drafts.length} personas, --participants asks for ${wanted}`);
  }
  return drafts;
}

function fallbackDrafts(config: Config): Draft[] {
  return FALLBACK.map((entry) => ({
    name: entry.name,
    gender: entry.gender,
    character: entry.character,
    stance: `${entry.stance} — on the question of ${config.topic}`,
  }));
}
