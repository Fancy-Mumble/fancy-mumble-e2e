/**
 * The people in the room who are not bots.
 *
 * Two things are tracked about them. **What they are doing right now** — is
 * anyone talking, since when, was it a cough or a sentence — comes from the
 * audio packets the first bot's connection sees on the tunnel; nothing is
 * decoded for that, only counted. **What they said** is decoded: a talk-spurt
 * is collected, wrapped as Ogg Opus and sent to a speech recogniser, and the
 * text arrives a second or so after they stop, the way it would for a person
 * who was half-listening and has to replay it.
 *
 * # Standing
 *
 * Every human has a standing with the room, from 0 to 1, that starts somewhere
 * middling and moves with how they behave. It decides how the bots take being
 * talked over: high, and the speaker stops with a "sorry, go ahead"; low, and
 * they get told to wait. It is per person, by name, and it survives a
 * reconnect. Speaking in a gap and saying something intelligible raises it;
 * talking over people and carrying on after being asked not to lowers it. Half
 * is the line between "one of us" and "that person": above it, what they say
 * is answered; below it, it is heard but not necessarily engaged with.
 */

import { oggOpus, opusPacketSamples } from "./ogg";
import { languageTag } from "./util";

export interface HumanSpeech {
  session: number;
  name: string;
  text: string;
  /** How long they spoke, in seconds. */
  seconds: number;
  /** Whether a bot was speaking when they started. */
  overSomeone: boolean;
}

export interface HumansOptions {
  stt: SttClient | null;
  language: string;
  random: () => number;
  /** Something a person said, transcribed. */
  onSpeech: (speech: HumanSpeech) => void;
  log: (who: string, message: string) => void;
}

interface Spurt {
  session: number;
  name: string;
  packets: Buffer[];
  samples: number;
  startedAt: number;
  lastAt: number;
  overSomeone: boolean;
  timer: NodeJS.Timeout | null;
}

/** A pause this long ends a talk-spurt, when no terminator arrives. */
const SPURT_GAP_MS = 700;
/** Nothing shorter than this goes to the recogniser — a cough, a key click. */
const MIN_SPURT_MS = 400;
/** After a reaction to somebody, leave them alone this long. */
const REACTION_COOLDOWN_MS = 8000;

export class Humans {
  private readonly spurts = new Map<number, Spurt>();
  private readonly standings = new Map<string, number>();
  private readonly reactedAt = new Map<number, number>();
  /** Whether a bot holds the floor right now; set by the director. */
  botSpeaking = false;

  constructor(private readonly opts: HumansOptions) {}

  /** One audio packet from a person, as the tunnel delivered it. */
  voice(session: number, name: string, opus: Buffer | null, terminator: boolean): void {
    const now = Date.now();
    let spurt = this.spurts.get(session);
    if (spurt === undefined || now - spurt.lastAt > SPURT_GAP_MS) {
      if (spurt !== undefined) this.finish(spurt);
      spurt = {
        session,
        name,
        packets: [],
        samples: 0,
        startedAt: now,
        lastAt: now,
        overSomeone: this.botSpeaking,
        timer: null,
      };
      this.spurts.set(session, spurt);
    }
    spurt.lastAt = now;
    spurt.name = name;
    if (opus !== null && opus.length > 0) {
      spurt.packets.push(opus);
      spurt.samples += opusPacketSamples(opus);
    }
    if (spurt.timer) clearTimeout(spurt.timer);
    if (terminator) {
      this.finish(spurt);
    } else {
      spurt.timer = setTimeout(() => this.finish(spurt as Spurt), SPURT_GAP_MS);
    }
  }

  /** Is anybody talking right now? */
  speaking(now = Date.now()): boolean {
    for (const spurt of this.spurts.values()) if (now - spurt.lastAt < 500) return true;
    return false;
  }

  /**
   * Somebody who has been talking for at least `forMs` and has not been
   * reacted to lately — the person to react to, if there is one.
   */
  talker(forMs: number, since = 0, now = Date.now()): { session: number; name: string } | null {
    for (const spurt of this.spurts.values()) {
      if (now - spurt.lastAt >= 500) continue;
      if (now - spurt.startedAt < forMs) continue;
      // Somebody who was already talking when the bot began is not barging in;
      // the bot is. That case is handled by not starting until they finish.
      if (spurt.startedAt < since) continue;
      const reacted = this.reactedAt.get(spurt.session);
      if (reacted !== undefined && now - reacted < REACTION_COOLDOWN_MS) continue;
      return { session: spurt.session, name: spurt.name };
    }
    return null;
  }

  reacted(session: number): void {
    this.reactedAt.set(session, Date.now());
  }

  /** Waits for the current talker(s) to fall silent, or for `capMs`. */
  async silence(capMs: number, quietMs = 900): Promise<void> {
    const until = Date.now() + capMs;
    let quietSince: number | null = null;
    while (Date.now() < until) {
      if (this.speaking()) quietSince = null;
      else if (quietSince === null) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  standing(name: string): number {
    let value = this.standings.get(name);
    if (value === undefined) {
      // Somewhere between "who is this" and "fine, go on". Never so low that a
      // first-time speaker is snapped at, never so high that manners are moot.
      value = 0.35 + this.opts.random() * 0.4;
      this.standings.set(name, value);
    }
    return value;
  }

  adjust(name: string, delta: number, why: string): void {
    const before = this.standing(name);
    const after = Math.max(0, Math.min(1, before + delta));
    this.standings.set(name, after);
    this.opts.log(name, `standing ${before.toFixed(2)} → ${after.toFixed(2)} (${why})`);
  }

  /** Whether the room treats this person as one of the conversation. */
  accepted(name: string): boolean {
    return this.standing(name) >= 0.5;
  }

  private finish(spurt: Spurt): void {
    if (spurt.timer) clearTimeout(spurt.timer);
    spurt.timer = null;
    if (this.spurts.get(spurt.session) === spurt) this.spurts.delete(spurt.session);

    const seconds = spurt.samples / 48_000;
    if (seconds * 1000 < MIN_SPURT_MS || this.opts.stt === null) return;
    const { session, name, packets, overSomeone } = spurt;
    void this.opts.stt
      .transcribe(oggOpus(packets), languageTag(this.opts.language))
      .then((text) => {
        if (text.length === 0) return;
        this.opts.onSpeech({ session, name, text, seconds, overSomeone });
      })
      .catch((e: unknown) => this.opts.log(name, `could not transcribe: ${(e as Error).message}`));
  }
}

/**
 * Whisper, behind `whisper-asr-webservice`.
 *
 * `POST /asr` with the audio as a file; `encode=true` has the service run its
 * own ffmpeg first, which is why Ogg Opus can go straight in. `vad_filter`
 * drops the silence Whisper is otherwise prone to hallucinating words into,
 * which for two seconds of somebody clearing their throat is the difference
 * between nothing and "Thank you for watching".
 */
export class SttClient {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/openapi.json`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async transcribe(ogg: Buffer, language: string | undefined): Promise<string> {
    const query = new URLSearchParams({
      encode: "true",
      task: "transcribe",
      output: "json",
      vad_filter: "true",
    });
    if (language !== undefined) query.set("language", language);
    const form = new FormData();
    form.set("audio_file", new Blob([new Uint8Array(ogg)], { type: "audio/ogg" }), "speech.ogg");
    const response = await fetch(`${this.url}/asr?${query}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`asr: ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as { text?: string };
    return (body.text ?? "").trim();
  }
}
