/**
 * Small pieces the rest of botroom leans on: a queue that bridges callbacks to
 * `for await`, a seeded random number generator, and text tidying.
 */

/**
 * A push-driven queue that is consumed with `for await`.
 *
 * Everything upstream of the bots is a callback or a Node stream and everything
 * downstream wants an async iterable — TTS chunks arriving from `fetch`, Opus
 * packets arriving from an ffmpeg pipe. This is that adapter, and it is
 * deliberately unbounded: the producers here are one utterance long (a few
 * hundred kilobytes at most), so a bound would only add a way to deadlock.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private failure: unknown = null;

  /**
   * `onCancel` runs when a consumer walks away early — a bot cut off
   * mid-sentence stops reading, and the ffmpeg and the HTTP request behind
   * the queue should stop too rather than finish synthesising into the void.
   */
  constructor(private readonly onCancel?: () => void) {}

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.nudge();
  }

  close(): void {
    this.closed = true;
    this.nudge();
  }

  /** End the stream by throwing into the consumer's `for await`. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.nudge();
  }

  /** Stop from the consuming side: drop what is queued and tell the producer. */
  cancel(): void {
    if (this.closed && this.items.length === 0) return;
    this.closed = true;
    this.items.length = 0;
    this.nudge();
    this.onCancel?.();
  }

  private nudge(): void {
    const waiter = this.wake;
    this.wake = null;
    waiter?.();
  }

  private async next(): Promise<IteratorResult<T>> {
    for (;;) {
      if (this.items.length > 0) return { value: this.items.shift() as T, done: false };
      if (this.failure) throw this.failure;
      if (this.closed) return { value: undefined, done: true };
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  /**
   * Hand-rolled rather than a generator, so `return()` works while a `next()`
   * is still pending. A generator queues the `return` behind the outstanding
   * `next`, which for a consumer waiting on a slow synthesiser means "stop" is
   * honoured only after the next chunk arrives — the one thing an interrupted
   * speaker must not wait for.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: () => {
        this.cancel();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * A seeded generator, so `--seed` reproduces a whole conversation.
 *
 * mulberry32: thirty-two bits of state, good enough to pick a speaker and a
 * pause length, and short enough to read. `Math.random` is used when no seed is
 * given, so a run without one is genuinely different each time.
 */
export function rng(seed: number | null): () => number {
  if (seed === null) return Math.random;
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one, weighted; weights need not sum to anything in particular. */
export function weightedPick<T>(items: T[], weight: (item: T) => number, random: () => number): T {
  const weights = items.map((item) => Math.max(0, weight(item)));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return items[Math.floor(random() * items.length)];
  let ticket = random() * total;
  for (let i = 0; i < items.length; i++) {
    ticket -= weights[i];
    if (ticket <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * A username Mumble will accept.
 *
 * murmur's default validation is `[-=\w\[\]\{\}\(\)\@\|\.]+`, which Starling
 * inherits, so a persona called "Dr. Marisa Toledo" cannot log in under its own
 * name — the spaces alone would be refused. Diacritics go through `\w` only in
 * unicode mode, so they are folded away rather than gambled on.
 */
export function toUsername(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^-=\w[\]{}()@|.]/g, "");
  return folded.slice(0, 40) || "bot";
}

/**
 * What a bot actually says, out of what the model actually returned.
 *
 * Models narrate ("*leans back*"), label their turn ("Marisa:"), wrap lines in
 * quotes, and — with thinking left on — emit a `<think>` block. All four are
 * read aloud by a TTS that has no idea they were not meant for it, so they are
 * stripped here rather than prompted away: the prompt asks too, but a rule the
 * model breaks once every thirty turns is a rule that needs a net under it.
 */
export function spoken(raw: string, speaker: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // An unterminated block means the answer was cut off mid-thought; there is no
  // usable speech in it, so keep whatever follows the opener and let the
  // emptiness be caught by the caller.
  text = text.replace(/^[\s\S]*?<\/think>/i, "");
  text = text.replace(/\*[^*]*\*/g, " ").replace(/_[^_]*_/g, " ");
  text = text.replace(/\((?:laughs?|sighs?|chuckles?|pauses?)[^)]*\)/gi, " ");
  text = text.replace(/^\s*#{1,6}\s*/gm, "");
  text = text.replace(/^\s*[-*]\s+/gm, "");
  // Their own name at the front, however they punctuated it: "Marisa:",
  // "**Marisa**:", and — seen twice in one run — "Marisa, honestly...", which
  // is the same label leak wearing a comma and reads as the speaker talking to
  // themselves. Only the speaker's *own* name is stripped; addressing somebody
  // else by name at the start of a sentence is what people actually do.
  const label = new RegExp(`^\\s*\\**${escapeRegExp(speaker)}\\**\\s*[:,—-]\\s*`, "i");
  text = text.replace(label, "");
  text = text.replace(/\s+/g, " ").trim();
  if (/^["'“”](.*)["'“”]$/s.test(text)) text = text.replace(/^["'“”]|["'“”]$/g, "").trim();
  return text;
}

/**
 * The ISO 639-1 tag for a language the operator typed, if it is one of the
 * ones this has been run in. TTS presets label themselves with these and
 * Whisper is told which to listen for; unknown → `undefined` → both guess.
 */
export function languageTag(language: string): string | undefined {
  const key = language.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(key)) return key;
  return LANGUAGE_TAGS[key];
}

const LANGUAGE_TAGS: Record<string, string> = {
  english: "en",
  german: "de",
  deutsch: "de",
  japanese: "ja",
  chinese: "zh",
  mandarin: "zh",
  korean: "ko",
  spanish: "es",
  french: "fr",
  italian: "it",
  portuguese: "pt",
  russian: "ru",
  dutch: "nl",
  polish: "pl",
};

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A crude similarity, for noticing a bot repeating itself. */
export function similarity(a: string, b: string): number {
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .split(/\s+/)
        .filter((word) => word.length > 3),
    );
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * Cut text into utterance-sized pieces at sentence boundaries.
 *
 * The TTS is asked for one sentence group at a time so its first audio arrives
 * sooner; `Qwen3-TTS` synthesises at around three times real time, so a long
 * paragraph submitted whole would still start late even though it finishes
 * early.
 */
export function sentences(text: string, maxChars = 220): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["'”)]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current.length > 0 && current.length + part.length > maxChars) {
      out.push(current.trim());
      current = "";
    }
    current += part;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out.filter((part) => part.length > 0);
}

/**
 * The pieces a line is *spoken* in — one synthesis request each.
 *
 * Sentence-sized, so a bot that is cut off knows which sentence it was on and
 * can pick up there. But not smaller than a breath: "Ha!" or "No." on its own
 * comes out of the synthesiser as a strange, isolated bark, so anything under
 * `minChars` is glued to what follows it. The last piece may be short; there is
 * nothing to glue it to.
 */
export function speechChunks(text: string, minChars = 28): string[] {
  // One sentence per part — `sentences()` would merge them up to a size, which
  // is what a load bot wants and exactly what a bot that has to resume from
  // "the sentence it was cut off in" does not.
  const parts = (text.match(/[^.!?…]+[.!?…]+["'”)]*|[^.!?…]+$/g) ?? [text])
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const out: string[] = [];
  let carry = "";
  for (const sentence of parts) {
    carry = carry.length > 0 ? `${carry} ${sentence}` : sentence;
    if (carry.length >= minChars) {
      out.push(carry);
      carry = "";
    }
  }
  if (carry.length > 0) {
    if (out.length > 0) out[out.length - 1] = `${out.at(-1)} ${carry}`;
    else out.push(carry);
  }
  return out;
}
