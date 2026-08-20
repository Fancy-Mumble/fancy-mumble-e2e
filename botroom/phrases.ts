/**
 * The little things people say when a conversation collides.
 *
 * "Sorry — go on." "No, no, you first." "As I was saying." "Do you mind?" A
 * clash is resolved with these, not with a generated turn: they have to come
 * out within a beat of the collision, and a round trip through the model is
 * three seconds of two people standing there. So each persona gets a small
 * stock of them at start-up, in their own voice and in the conversation's
 * language, from one model call. English fallbacks cover the model returning
 * nonsense; a run that cannot negotiate a clash is a run that cannot clash.
 */

import type { LlmClient } from "./llm";
import type { Persona } from "./personas";

export type PhraseKind =
  /** Both started at once, and this one gives way. */
  | "yield"
  /** Both started at once, and this one keeps the floor. */
  | "insist"
  /** Picking a sentence back up after being interrupted. */
  | "resume"
  /** To someone outside the conversation who keeps talking over it. */
  | "annoyed"
  /** Giving way gracefully to a person who has joined in. */
  | "welcome";

export type Phrasebook = Record<PhraseKind, string[]>;

const FALLBACK: Phrasebook = {
  yield: ["Sorry — go on.", "No, no, you first.", "Go ahead."],
  insist: ["Let me finish.", "Hang on, I'm not done.", "One second — let me get this out."],
  resume: ["As I was saying,", "Anyway —", "Right, so,"],
  annoyed: [
    "Sorry, do you mind? We're in the middle of something.",
    "Hang on — we were talking.",
    "Could you let us finish?",
  ],
  welcome: ["Oh — sorry, go ahead.", "Please, go on.", "Sorry, you were saying?"],
};

/** How each kind is delivered, as a hint to the synthesiser. */
export const PHRASE_MOOD: Record<PhraseKind, string> = {
  yield: "Quick and apologetic.",
  insist: "Firm, not shouting.",
  resume: "Picking the thread back up.",
  annoyed: "Irritated, clipped.",
  welcome: "Warm, a little surprised.",
};

const SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          yield: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
          insist: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
          resume: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
          annoyed: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
          welcome: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
        },
        required: ["name", "yield", "insist", "resume", "annoyed", "welcome"],
        additionalProperties: false,
      },
    },
  },
  required: ["people"],
  additionalProperties: false,
} as const;

export async function makePhrasebooks(
  llm: LlmClient,
  personas: Persona[],
  language: string,
  log: (message: string) => void,
): Promise<Map<string, Phrasebook>> {
  const books = new Map<string, Phrasebook>();
  for (const persona of personas) books.set(persona.name, FALLBACK);

  const roster = personas
    .map((persona) => `- ${persona.name}: ${persona.character}`)
    .join("\n");
  const prompt =
    `These people are in a lively spoken conversation in ${language}:\n${roster}\n\n` +
    `For each of them, write short things they would actually say, in ${language}, ` +
    `in their own voice — two each, under eight words, no names in them:\n` +
    `  yield: two people started talking at once and this one lets the other go first\n` +
    `  insist: two people started talking at once and this one keeps talking\n` +
    `  resume: picking their own sentence back up after being cut off\n` +
    `  annoyed: telling someone who is not part of the conversation, and keeps talking ` +
    `over it, to stop\n` +
    `  welcome: giving way graciously to a newcomer who wants to say something\n` +
    `Return JSON with a "people" array.`;

  try {
    const parsed = (await llm.chatJson([{ role: "user", content: prompt }], SCHEMA, {
      temperature: 0.9,
      maxTokens: 1200,
    })) as { people?: Partial<Record<PhraseKind | "name", unknown>>[] };
    let filled = 0;
    for (const entry of parsed.people ?? []) {
      const name = String(entry.name ?? "");
      if (!books.has(name)) continue;
      const book = { ...FALLBACK };
      for (const kind of Object.keys(FALLBACK) as PhraseKind[]) {
        const phrases = Array.isArray(entry[kind])
          ? (entry[kind] as unknown[]).map(String).map((s) => s.trim()).filter((s) => s.length > 0)
          : [];
        if (phrases.length > 0) book[kind] = phrases;
      }
      books.set(name, book);
      filled += 1;
    }
    if (filled < personas.length) {
      log(`phrasebook covers ${filled} of ${personas.length}; the rest use stock phrases`);
    }
  } catch (e) {
    log(`no phrasebook from the model (${(e as Error).message}); using stock phrases`);
  }
  return books;
}

export function phrase(book: Phrasebook, kind: PhraseKind, random: () => number): string {
  const options = book[kind].length > 0 ? book[kind] : FALLBACK[kind];
  return options[Math.floor(random() * options.length)];
}
