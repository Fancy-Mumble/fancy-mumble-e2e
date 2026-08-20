/**
 * The thing that makes it a conversation rather than N monologues.
 *
 * One turn at a time: somebody is chosen, a line is generated for them, it is
 * synthesised, and it goes out as speech (and, if asked, as a channel
 * message). What makes it feel live is that the *next* speaker's line is
 * generated and synthesised while the current one is still talking — the LLM
 * sits on one GPU and the TTS on the other, so the only turn that pays the
 * full latency is the first.
 *
 * # The floor
 *
 * A turn is not delivered blindly. While a bot speaks, the director watches
 * for two things and treats them the same way. When the room is heated, the
 * next speaker may start before the current one has finished; both talk for a
 * moment, both stop, and one of them gives way — "sorry, go on" / "no, let me
 * finish" — before the winner carries on from the sentence they were cut off
 * in. And when a *person* in the channel starts talking over a bot, the bot
 * either stops for them or tells them to wait, depending on the standing that
 * person has with the room (see `humans.ts`), and what the person said comes
 * back transcribed and gets answered.
 *
 * # Heat and mood
 *
 * Every line comes back from the model with a mood — how it is delivered, fed
 * to the synthesiser — and a heat, how worked up the speaker is. The room's
 * heat is a running average of those, and it decides how likely a clash is:
 * calm rooms take turns, heated rooms interrupt.
 *
 * People who *type* in the channel are participants too: their line lands in
 * the transcript, and the turn that was being prepared is thrown away so that
 * somebody actually answers them.
 */

import { appendFileSync } from "node:fs";

import type { AudioBot } from "../src/util/audio-bot";
import type { Config } from "./config";
import type { HumanSpeech, Humans } from "./humans";
import { SpokenLine, type Voicing } from "./line";
import type { LlmClient, ChatMessage } from "./llm";
import type { Persona } from "./personas";
import { PHRASE_MOOD, phrase, type Phrasebook, type PhraseKind } from "./phrases";
import type { TtsClient } from "./tts";
import { delay, escapeRegExp, similarity, spoken, weightedPick } from "./util";

export interface Speaker {
  persona: Persona;
  /** `null` in a dry run, where nothing is connected to. */
  bot: AudioBot | null;
  /** Turn number at which they last spoke; -1 for never. */
  lastTurn: number;
}

export interface TranscriptLine {
  who: string;
  text: string;
  at: string;
  source: "bot" | "human" | "note";
}

interface PreparedTurn {
  speaker: Speaker;
  text: string;
  mood: string;
  heat: number;
  line: SpokenLine;
  /** Which revision of the transcript this was written against. */
  generation: number;
  preparedAt: number;
}

/** A line already going out — a speaker who took the floor mid-clash. */
interface InProgress {
  speaking: Promise<boolean>;
  abort: AbortController;
}

interface Outcome {
  /** Somebody else took the floor during this turn and now holds it. */
  handoff?: PreparedTurn;
  inProgress?: InProgress;
}

type Event =
  | { kind: "done" }
  | { kind: "human"; session: number; name: string }
  | { kind: "bot"; turn: PreparedTurn };

export interface DirectorOptions {
  config: Config;
  llm: LlmClient;
  tts: TtsClient | null;
  speakers: Speaker[];
  humans: Humans;
  phrasebooks: Map<string, Phrasebook>;
  log: (who: string, message: string) => void;
  /** Seeded when `--seed` was given, so a whole run can be replayed. */
  random: () => number;
}

/** How similar to something already said before a line is written again. */
const REPETITION = 0.62;
/** Room heat below which nobody interrupts anybody. */
const CLASH_HEAT = 4.5;
/** A speaker this worked up may barge in even when the room as a whole is not. */
const HOTHEAD = 7;
/** Turns to leave between two bot-on-bot clashes. */
const CLASH_SPACING = 3;
/** Somebody talking this long over a bot is interrupting, not coughing. */
const HUMAN_BARGE_MS = 450;

const TURN_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    mood: { type: "string" },
    heat: { type: "integer", minimum: 0, maximum: 10 },
  },
  required: ["text", "mood", "heat"],
  additionalProperties: false,
} as const;

export class Director {
  private readonly transcript: TranscriptLine[] = [];
  private readonly angles: string[] = [];
  private generation = 0;
  private turn = 0;
  private steered = 0;
  private steeredAt = -1;
  private stopped: string | null = null;
  private startedAt = 0;
  /** Running average of the speakers' own heat ratings, 0–10. */
  private heat = 3;
  private lastClashTurn = -CLASH_SPACING;
  /** A person the room just gave way to, whose words are expected. */
  private yieldedTo: string | null = null;
  private speechWaiters: ((speech: HumanSpeech | null) => void)[] = [];
  /** The last thing anybody said and when it landed, for "did they say anything?" */
  private lastSpeech: { speech: HumanSpeech; at: number } | null = null;

  constructor(private readonly opts: DirectorOptions) {}

  /** Everything that was said, for a caller that wants to print a summary. */
  get lines(): readonly TranscriptLine[] {
    return this.transcript;
  }

  get turnsTaken(): number {
    return this.turn;
  }

  stop(reason: string): void {
    if (this.stopped === null) this.stopped = reason;
  }

  /**
   * A person typed something in the channel.
   *
   * Bumping the generation is what makes the bots answer it: any turn already
   * in flight was written without this line and is discarded on arrival.
   */
  humanSaid(who: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.append({ who, text: trimmed, at: new Date().toISOString(), source: "human" });
    this.opts.humans.adjust(who, +0.05, "joined in by text");
    this.generation += 1;
    this.opts.log(who, `typed: ${trimmed}`);
  }

  /**
   * A person said something, and the recogniser caught it.
   *
   * Whether the room *answers* depends on how they said it. Spoken into a gap,
   * it is a contribution and raises their standing; the bots answer if they
   * accept the person, and sometimes even if they do not. Spoken over a bot who
   * then gave way, it is what everybody stopped for. Spoken over a bot who
   * told them to wait, it goes on the record and no further.
   */
  humanSpoke(speech: HumanSpeech): void {
    const { humans } = this.opts;
    this.lastSpeech = { speech, at: Date.now() };
    const waiters = this.speechWaiters;
    this.speechWaiters = [];
    for (const waiter of waiters) waiter(speech);

    this.append({ who: speech.name, text: speech.text, at: new Date().toISOString(), source: "human" });
    this.opts.log(speech.name, `said: ${speech.text}`);

    if (!speech.overSomeone) {
      humans.adjust(speech.name, +0.08, "waited for a gap");
      if (humans.accepted(speech.name) || this.opts.random() < humans.standing(speech.name)) {
        this.generation += 1;
      } else {
        this.opts.log(speech.name, "…and the room lets it pass");
        this.note(`(${speech.name} said that from the side; nobody picked it up.)`);
      }
      return;
    }
    if (this.yieldedTo === speech.name) {
      this.yieldedTo = null;
      this.generation += 1;
      return;
    }
    // Talked over somebody who told them to wait. If the room accepts them
    // anyway, what they said still gets answered — one bot's irritation is not
    // the room's verdict. If it does not, it goes on the record and no further.
    if (humans.accepted(speech.name)) this.generation += 1;
  }

  async run(): Promise<void> {
    this.startedAt = Date.now();
    await this.planAngles();

    let pending = this.prepare(this.pick(null));
    let turn: PreparedTurn | null = null;
    let inProgress: InProgress | null = null;
    let previous: Speaker | null = null;

    while (this.stopped === null && !this.reachedLimit()) {
      if (turn === null) {
        try {
          turn = await pending;
          if (turn.generation !== this.generation) {
            // Somebody spoke while this was being written. Answer them instead.
            this.opts.log(turn.speaker.persona.name, "drops a prepared line; a person spoke");
            turn.line.discard();
            turn = await this.prepare(this.pick(previous));
          }
        } catch (e) {
          this.opts.log("director", `could not prepare a turn: ${(e as Error).message}`);
          await delay(2000);
          if (this.stopped !== null) break;
          pending = this.prepare(this.pick(previous));
          continue;
        }
      }

      this.commit(turn);
      previous = turn.speaker;
      // Start the next line now: it is generated and synthesised underneath
      // the delivery of this one, which is what keeps the gaps short.
      pending = this.prepare(this.pick(previous));

      const outcome = await this.hold(turn, pending, inProgress);
      if (outcome.handoff !== undefined) {
        // The floor changed hands mid-turn. The taker's line was `pending`;
        // it is committed at the top of the loop, and a new one prepared.
        turn = outcome.handoff;
        inProgress = outcome.inProgress ?? null;
        continue;
      }
      turn = null;
      inProgress = null;
      await this.pause();
    }

    // Whatever was in flight is abandoned on purpose — it belongs to a
    // conversation that has ended, and waiting for it would delay the goodbye.
    void pending.then((t) => t.line.discard()).catch(() => undefined);
  }

  // -- one turn -----------------------------------------------------------

  private commit(turn: PreparedTurn): void {
    this.turn += 1;
    turn.speaker.lastTurn = this.turn;
    this.heat = this.heat * 0.55 + turn.heat * 0.45;
    this.append({
      who: turn.speaker.persona.name,
      text: turn.text,
      at: new Date().toISOString(),
      source: "bot",
    });
    const waited = Date.now() - turn.preparedAt;
    this.opts.log(
      turn.speaker.persona.name,
      `[${turn.mood} · heat ${turn.heat}] ${turn.text}` +
        (this.opts.config.verbose
          ? `   [room ${this.heat.toFixed(1)}, ready ${(waited / 1000).toFixed(1)}s ago]`
          : ""),
    );
    if (this.opts.config.postText) turn.speaker.bot?.sendText(turn.text);
  }

  private async prepare(speaker: Speaker): Promise<PreparedTurn> {
    const generation = this.generation;

    // Taken once per turn, not once per prompt: it advances a cursor through
    // the angles, and the retry below would otherwise burn a second one.
    const angle = this.nextAngle();
    const steer =
      angle === null
        ? []
        : [
            `The conversation has been on one point for a while. Turn it towards ` +
              `this, naturally and in character: ${angle}`,
          ];

    let reply = await this.ask(speaker, steer, this.opts.config.temperature);
    if (reply.text.length === 0 || this.repeats(speaker, reply.text)) {
      // One retry, hotter and told why. A model that has run out of things to
      // say will otherwise restate its last point in slightly different words
      // for as long as you leave it running.
      reply = await this.ask(
        speaker,
        [
          ...steer,
          "Do not repeat a point that has already been made in this conversation. " +
            "Say something new: a different angle, a concrete example, or a question " +
            "to someone else in the room.",
        ],
        Math.min(1.2, this.opts.config.temperature + 0.25),
      );
    }
    if (reply.text.length === 0) throw new Error(`${speaker.persona.name} produced an empty line`);

    const line = new SpokenLine(reply.text, this.voicing(speaker, reply.mood), (message) =>
      this.opts.log(speaker.persona.name, message),
    );
    // Only the first sentence ahead of time, and behind whoever is speaking
    // now in the synthesiser's queue: it is what lets the line start the
    // instant its turn comes, and it is all the speculation the synthesiser
    // can afford (see `CONCURRENCY` in `tts.ts`).
    line.prefetch(0, 2);
    return { speaker, ...reply, line, generation, preparedAt: Date.now() };
  }

  private async ask(
    speaker: Speaker,
    extra: string[],
    temperature: number,
  ): Promise<{ text: string; mood: string; heat: number }> {
    const raw = (await this.opts.llm.chatJson(this.promptFor(speaker, extra), TURN_SCHEMA, {
      temperature,
    })) as { text?: unknown; mood?: unknown; heat?: unknown };
    const heat = Number(raw.heat);
    return {
      text: spoken(String(raw.text ?? ""), speaker.persona.name),
      mood: String(raw.mood ?? "").trim().replace(/\.$/, "") || "even",
      heat: Number.isFinite(heat) ? Math.max(0, Math.min(10, Math.round(heat))) : 3,
    };
  }

  /** How this speaker's next line should sound, given how they feel about it. */
  private voicing(speaker: Speaker, mood: string): Voicing | null {
    const { config, tts } = this.opts;
    if (config.mute || tts === null) return null;
    const style = [speaker.persona.instruct, mood ? `${mood}.` : ""].filter(Boolean).join(" ");
    return {
      tts,
      encode: { frameMs: config.frameMs, bitrateKbps: config.bitrateKbps },
      options: {
        voice: speaker.persona.voice,
        instruct: style || undefined,
        language: config.language,
      },
    };
  }

  // -- holding the floor --------------------------------------------------

  /**
   * Deliver a turn, dealing with whoever tries to take the floor meanwhile.
   *
   * Loops because a turn can be interrupted and resumed more than once: the
   * speaker picks up from the chunk they were cut off in, and the watch starts
   * again. Returns a hand-off when somebody else ended up holding the floor.
   */
  private async hold(
    turn: PreparedTurn,
    pending: Promise<PreparedTurn>,
    inProgress: InProgress | null,
  ): Promise<Outcome> {
    const { humans, config } = this.opts;
    const speaker = turn.speaker;
    const line = turn.line;
    let from = 0;
    let resumed = false;

    // Decided once, up front, so the watch has one question to ask. Heated
    // rooms interrupt; calm ones do not; and never two turns running. (Whether
    // the *next speaker* is hot-headed enough to barge in regardless is decided
    // in the watch, once their line exists and their heat is known.)
    const clashAllowed = config.interruptions && this.turn - this.lastClashTurn >= CLASH_SPACING;
    const clashPlanned =
      clashAllowed &&
      this.heat >= CLASH_HEAT &&
      this.opts.random() < Math.min(0.8, ((this.heat - CLASH_HEAT) / 3.5) * 0.9);

    let started = inProgress;
    for (;;) {
      if (this.stopped !== null) return {};
      // Somebody is already talking. Starting now would be the bot barging in
      // on them, and then complaining about it — which is what happened before
      // this check existed. Wait, and let what they said land first.
      if (started === null && humans.speaking()) {
        await humans.silence(30_000);
        await this.awaitSpeech(2000);
        if (this.stopped !== null) return {};
      }
      const abort = started?.abort ?? new AbortController();
      const since = Date.now();
      const speaking = started?.speaking ?? line.speak(speaker.bot, from, abort.signal);
      started = null;
      humans.botSpeaking = true;

      const event = await this.watch(line, speaking, {
        pending: clashAllowed && !resumed ? pending : null,
        planned: clashPlanned,
        startedAt: since,
      });
      humans.botSpeaking = false;

      if (event.kind === "done") return {};

      if (event.kind === "human") {
        const resume = await this.humanClash(turn, event, abort, speaking);
        if (!resume) return {};
        from = line.index;
        resumed = true;
        continue;
      }

      // Another bot barged in.
      const outcome = await this.botClash(turn, event.turn, abort, speaking);
      if (outcome === "resume") {
        from = line.index;
        resumed = true;
        continue;
      }
      return outcome;
    }
  }

  /**
   * Watch a speaking bot until it finishes, or until something happens.
   *
   * A person counts once they have been talking for [`HUMAN_BARGE_MS`] and
   * have not been reacted to recently. Another bot counts once its line is
   * synthesised and the current one is well under way — never in the first
   * seconds, and never in its last sentence, where letting it finish is the
   * same thing as talking over it, minus the rudeness.
   */
  private async watch(
    line: SpokenLine,
    speaking: Promise<boolean>,
    opts: { pending: Promise<PreparedTurn> | null; planned: boolean; startedAt: number },
  ): Promise<Event> {
    let done = false;
    void speaking.then(
      () => (done = true),
      () => (done = true),
    );
    // Whether the next speaker barges in: planned from the room's heat, or
    // decided the moment their line arrives if they personally are worked up
    // enough — a furious reply does not wait for the room average.
    let ready: PreparedTurn | null = null;
    let barging = opts.planned;
    void opts.pending
      ?.then((turn) => {
        ready = turn;
        // A persona that rates itself 7 on every line would otherwise barge
        // in on most of its turns; the odds climb with how far past the mark
        // they are, so it stays something that *happens*, not the rhythm.
        const eagerness = turn.heat >= 9 ? 0.6 : turn.heat >= 8 ? 0.45 : turn.heat >= HOTHEAD ? 0.28 : 0;
        if (!barging && this.opts.random() < eagerness) barging = true;
      })
      .catch(() => undefined);
    const bargeAt = Math.max(1, Math.floor(line.chunks.length * 0.4));

    while (!done) {
      await delay(80);
      if (done || this.stopped !== null) break;

      const talker = this.opts.humans.talker(HUMAN_BARGE_MS, opts.startedAt - 300);
      if (talker !== null) return { kind: "human", ...talker };

      const other = ready as PreparedTurn | null;
      if (
        barging &&
        other !== null &&
        other.generation === this.generation &&
        other.line.ready &&
        line.index >= bargeAt &&
        line.index < line.chunks.length - 1 &&
        Date.now() - opts.startedAt > 2500
      ) {
        return { kind: "bot", turn: other };
      }
    }
    return { kind: "done" };
  }

  /**
   * A person is talking over the speaker. Give way, or tell them to wait?
   *
   * The odds follow their standing, tilted by the room's heat — people on
   * edge are less gracious. Giving way means stopping, saying so, and letting
   * them finish; if the recogniser then delivers words, the turn is over and
   * the next line answers them. Not giving way means stopping just long
   * enough to say "do you mind", then carrying on — and their standing drops,
   * more if they keep going. Returns whether the speaker resumes their line.
   */
  private async humanClash(
    turn: PreparedTurn,
    who: { session: number; name: string },
    abort: AbortController,
    speaking: Promise<boolean>,
  ): Promise<boolean> {
    const { humans, random } = this.opts;
    const speaker = turn.speaker;
    humans.reacted(who.session);

    const standing = humans.standing(who.name);
    const graciousness = Math.max(0.05, Math.min(0.95, standing - Math.max(0, this.heat - 5) * 0.06));
    const since = Date.now();
    abort.abort();
    await speaking;

    if (random() < graciousness) {
      this.opts.log(speaker.persona.name, `stops for ${who.name} (standing ${standing.toFixed(2)})`);
      await this.say(speaker, "welcome");
      this.yieldedTo = who.name;
      this.note(`(${speaker.persona.name} stops so that ${who.name} can speak.)`);
      await humans.silence(30_000);
      // Their words may already have landed while we were waiting for quiet
      // — the recogniser answers in about a second — or may still be coming.
      const heard = this.speechSince(since, who.name) ?? (await this.awaitSpeech(2500));
      if (heard !== null && heard.name === who.name) {
        humans.adjust(who.name, +0.1, "said their piece");
        return false;
      }
      humans.adjust(who.name, -0.05, "interrupted and said nothing we could make out");
      this.yieldedTo = null;
      await this.say(speaker, "resume");
      return true;
    }

    this.opts.log(speaker.persona.name, `tells ${who.name} to wait (standing ${standing.toFixed(2)})`);
    await this.say(speaker, "annoyed");
    humans.adjust(who.name, -0.1, `talked over ${speaker.persona.name}`);
    this.note(`(${who.name} talks over ${speaker.persona.name}, who asks them to wait.)`);
    await delay(1500);
    if (humans.speaking()) {
      humans.adjust(who.name, -0.1, "kept going anyway");
      await humans.silence(15_000);
    } else {
      humans.adjust(who.name, +0.03, "stopped when asked");
    }
    if (random() < 0.5) await this.say(speaker, "resume");
    return true;
  }

  /**
   * Another bot has started talking over the speaker.
   *
   * Both talk for a moment. If the speaker was about to finish anyway, the
   * newcomer simply has the floor and the turn passes. Otherwise both stop,
   * somebody says the small thing people say, and the winner goes on — the
   * original speaker from the sentence they were in, or the newcomer from the
   * top. About once in four they *both* give way, and stand there, and then
   * the winner goes anyway.
   */
  private async botClash(
    turn: PreparedTurn,
    other: PreparedTurn,
    abort: AbortController,
    speaking: Promise<boolean>,
  ): Promise<Outcome | "resume"> {
    const { random } = this.opts;
    const a = turn.speaker;
    const b = other.speaker;
    this.lastClashTurn = this.turn;
    this.opts.log(b.persona.name, `⚡ talks over ${a.persona.name} (room heat ${this.heat.toFixed(1)})`);

    const bAbort = new AbortController();
    const bSpeaking = other.line.speak(b.bot, 0, bAbort.signal);
    const overlapMs = 900 + random() * 1300;
    let aFinished = false;
    await Promise.race([delay(overlapMs), speaking.then(() => (aFinished = true))]);

    if (aFinished) {
      // Overlapped the tail of the line, and now has the floor outright.
      this.note(`(${b.persona.name} starts before ${a.persona.name} has quite finished.)`);
      return { handoff: other, inProgress: { speaking: bSpeaking, abort: bAbort } };
    }

    abort.abort();
    bAbort.abort();
    await Promise.all([speaking, bSpeaking]);
    // Everybody calms down a notch after a collision.
    this.heat = Math.max(0, this.heat - 1.5);
    await delay(250 + random() * 300);

    const aWins = random() < 0.55;
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;
    if (random() < 0.25) {
      await this.say(loser, "yield");
      await delay(150 + random() * 250);
      await this.say(winner, "yield");
      await delay(400 + random() * 400);
      this.note(
        `(${a.persona.name} and ${b.persona.name} talk over each other, both give way, ` +
          `and ${winner.persona.name} goes on.)`,
      );
    } else if (random() < 0.6) {
      await this.say(loser, "yield");
      this.note(
        `(${a.persona.name} and ${b.persona.name} talk over each other; ${loser.persona.name} gives way.)`,
      );
    } else {
      await this.say(winner, "insist");
      this.note(
        `(${a.persona.name} and ${b.persona.name} talk over each other; ${winner.persona.name} insists.)`,
      );
    }
    await delay(200 + random() * 300);

    if (aWins) {
      if (random() < 0.5) await this.say(a, "resume");
      return "resume";
    }
    // The line stops where it stopped; the record says so.
    this.truncate(a, turn);
    return { handoff: other };
  }

  /** Say one of the small phrases, in character, right now. */
  private async say(speaker: Speaker, kind: PhraseKind): Promise<void> {
    const book = this.opts.phrasebooks.get(speaker.persona.name);
    if (book === undefined) return;
    const text = phrase(book, kind, this.opts.random);
    this.opts.log(speaker.persona.name, text);
    const line = new SpokenLine(text, this.voicing(speaker, PHRASE_MOOD[kind]));
    // Ahead of everything else waiting for the synthesiser: this is the beat
    // after a collision, and three seconds of silence there is not a beat.
    line.prefetch(0, 0);
    await line.speak(speaker.bot, 0);
  }

  /** What `name` said since `since`, if the recogniser has delivered it. */
  private speechSince(since: number, name: string): HumanSpeech | null {
    const last = this.lastSpeech;
    if (last === null || last.at < since || last.speech.name !== name) return null;
    return last.speech;
  }

  /** The words a person just said, if they arrive within `ms`. */
  private awaitSpeech(ms: number): Promise<HumanSpeech | null> {
    return new Promise((resolve) => {
      const done = (speech: HumanSpeech | null): void => {
        clearTimeout(timer);
        resolve(speech);
      };
      const timer = setTimeout(() => {
        this.speechWaiters = this.speechWaiters.filter((waiter) => waiter !== done);
        resolve(null);
      }, ms);
      this.speechWaiters.push(done);
    });
  }

  private truncate(speaker: Speaker, turn: PreparedTurn): void {
    const said = turn.line.spoken;
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const entry = this.transcript[i];
      if (entry.who === speaker.persona.name && entry.text === turn.text) {
        entry.text = said.length > 0 ? `${said} —` : "—";
        break;
      }
    }
    this.note(`(${speaker.persona.name} was cut off before finishing.)`);
  }

  private note(text: string): void {
    this.append({ who: "note", text, at: new Date().toISOString(), source: "note" });
    if (this.opts.config.verbose) this.opts.log("room", text);
  }

  private async pause(): Promise<void> {
    const { config, humans } = this.opts;
    const span = Math.max(0, config.pauseMaxMs - config.pauseMinMs);
    await delay(config.pauseMinMs + this.opts.random() * span);

    // Somebody is talking into the gap. Let them finish, and give the
    // recogniser a moment to deliver what they said, so the next line can be
    // about it. Capped, because a stuck flag would otherwise end the
    // conversation without ending the program.
    if (humans.speaking()) {
      await humans.silence(30_000);
      await this.awaitSpeech(2500);
    }
  }

  // -- choosing, prompting, remembering -----------------------------------

  /**
   * Who speaks next.
   *
   * Never the person who just spoke. Being named pulls hard towards answering,
   * because a question asked of one person and answered by another is the most
   * artificial thing a room of bots does — but it is a *weight*, not a rule.
   *
   * It used to be a rule: named, and four times in five they answered. That
   * produced a nine-turn duel in a room of three. Everybody addresses whoever
   * just spoke to them, so the last line always names the person before last,
   * and the pair lock each other in while the third watches.
   *
   * So: silence squared, times three for being named. A name beats an equal
   * silence, and five turns of silence (36) beats a name from someone who
   * spoke last time (4 × 3 = 12).
   */
  private pick(previous: Speaker | null): Speaker {
    const candidates = this.opts.speakers.filter((speaker) => speaker !== previous);
    if (candidates.length === 0) return this.opts.speakers[0];

    const last = this.lastSaid();
    const named = (speaker: Speaker): boolean =>
      last !== undefined &&
      new RegExp(`\\b${escapeRegExp(speaker.persona.name)}\\b`, "i").test(last.text);

    return weightedPick(
      candidates,
      (speaker) => (1 + (this.turn - speaker.lastTurn)) ** 2 * (named(speaker) ? 3 : 1),
      this.opts.random,
    );
  }

  /** The most recent thing anybody actually said, skipping stage notes. */
  private lastSaid(): TranscriptLine | undefined {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      if (this.transcript[i].source !== "note") return this.transcript[i];
    }
    return undefined;
  }

  /**
   * The prompt for one turn.
   *
   * **Everything instructional goes in the leading system message**, including
   * the steering nudge and the do-not-repeat nudge. Those used to be appended
   * after the history, which is the natural place for them and which Qwen3.8's
   * chat template refuses outright: `raise_exception('System message must be at
   * the beginning')`, a 500 from the server, and a run that died at the first
   * steer. A model that accepted it would still be the odd one out.
   */
  private promptFor(speaker: Speaker, extra: string[] = []): ChatMessage[] {
    const { config } = this.opts;
    const others = this.opts.speakers
      .filter((other) => other !== speaker)
      .map((other) => `${other.persona.name} (${other.persona.character})`)
      .join("; ");

    const last = this.lastSaid();
    const temperature =
      this.heat < 3
        ? "calm"
        : this.heat < 5.5
          ? "lively"
          : this.heat < 7.5
            ? "getting heated"
            : "heated — people are talking over each other";

    const system =
      `You are ${speaker.persona.name}, ${speaker.persona.character}. ` +
      `Your view on the subject: ${speaker.persona.stance}.\n` +
      `You are in a live voice chat. The subject is: ${config.topic}\n` +
      `Also in the room: ${others}. Anyone else who appears is a real person listening in.\n` +
      `Speak ${config.language}. The room right now is ${temperature} (${this.heat.toFixed(0)}/10).\n\n` +
      `You answer as JSON with three keys:\n` +
      `- "text": what you say out loud. Plain speech only — no markdown, no lists, no ` +
      `emoji, no asterisks, no stage directions. Never your own name, never a speaker ` +
      `label, never a line for anybody else.\n` +
      `- "mood": how you deliver it, two to five words, as an instruction to a voice ` +
      `actor. E.g. "warm, amused" · "exasperated, fast, rising" · "quiet, hurt" · ` +
      `"dry, deadpan".\n` +
      `- "heat": how worked up YOU are right now, 0 calm to 10 furious.\n\n` +
      `How to talk:\n` +
      `- React to what was just said. Agree, push back, ask something, add a ` +
      `concrete detail. Do not summarise the conversation.\n` +
      `- Have feelings and let them into the words. Interject ("Oh, come on."), ` +
      `laugh ("Ha!"), hesitate ("I mean —"), trail off with a dash when you lose ` +
      `the thread, concede when you are beaten, get sharp when you are provoked.\n` +
      `- Length follows mood: worked up, be short and sharp — five words is a ` +
      `line; calm, up to three sentences. Never more than about 45 words.\n` +
      `- Do not begin your turn with anyone's name. A name mid-sentence is fine ` +
      `when you are answering someone directly. Only names from this room, and ` +
      `never your own.\n` +
      `- Stay in character, and stay interesting to listen to.` +
      // Who just spoke, said plainly. Without it the model picks a name out of
      // the room at random when it wants to address someone — including, twice
      // in one run, its own.
      //
      // A real person gets a stronger form of the same sentence. They are the
      // reason the turn that was already prepared got thrown away, and having
      // done that it would be absurd to carry on arguing with the bot who
      // spoke before them.
      (last !== undefined && last.who !== speaker.persona.name
        ? last.source === "human"
          ? `\n\n${last.who} is a real person in the room, and they have just ` +
            `spoken. Answer them directly and by name, before anything else.`
          : `\n\nThe last person to speak was ${last.who}. You are replying to ${last.who}.`
        : "") +
      (extra.length > 0 ? `\n\n${extra.join("\n")}` : "");

    const messages: ChatMessage[] = [{ role: "system", content: system }];
    for (const line of this.transcript.slice(-config.historyLines)) {
      if (line.source === "note") {
        messages.push({ role: "user", content: line.text });
      } else if (line.who === speaker.persona.name) {
        messages.push({ role: "assistant", content: line.text });
      } else {
        const tag = line.source === "human" ? " (a real person in the room)" : "";
        messages.push({ role: "user", content: `${line.who}${tag}: ${line.text}` });
      }
    }

    if (this.transcript.length === 0) {
      messages.push({
        role: "user",
        content:
          `You are opening the conversation. Say the first thing — get straight ` +
          `into the subject in a sentence or two, in your own voice.`,
      });
    }
    return messages;
  }

  /**
   * A fresh angle every so often.
   *
   * Left alone, three bots will circle one sub-question indefinitely: each
   * answers the last line, and the last line is always about what the previous
   * one was about. The angles are generated once, up front, from the topic.
   */
  private nextAngle(): string | null {
    const { steerEvery } = this.opts.config;
    if (this.angles.length === 0 || steerEvery <= 0) return null;
    if (this.turn === 0 || this.turn % steerEvery !== 0) return null;
    if (this.steered >= this.angles.length) return null;
    // At most one angle per turn. A turn can be prepared more than once — a
    // human interrupting throws the first attempt away — and each attempt would
    // otherwise take a fresh angle and steer the room twice in one breath.
    if (this.steeredAt === this.turn) return null;
    this.steeredAt = this.turn;
    return this.angles[this.steered++];
  }

  private async planAngles(): Promise<void> {
    if (this.opts.config.steerEvery <= 0) return;
    try {
      const answer = await this.opts.llm.chat(
        [
          {
            role: "user",
            content:
              `List six short, specific sub-questions that a lively conversation about ` +
              `"${this.opts.config.topic}" would move through. One per line, no numbering, ` +
              `no preamble. Write them in ${this.opts.config.language}.`,
          },
        ],
        { temperature: 0.9, maxTokens: 300 },
      );
      for (const line of answer.split(/\r?\n/)) {
        const angle = line.replace(/^\s*[-*\d.)]+\s*/, "").trim();
        if (angle.length > 8) this.angles.push(angle);
      }
    } catch (e) {
      // Not fatal: without angles the talk is narrower, not broken.
      this.opts.log("director", `no steering angles (${(e as Error).message})`);
    }
  }

  private repeats(speaker: Speaker, text: string): boolean {
    const own = this.transcript.filter((line) => line.who === speaker.persona.name).slice(-3);
    const recent = this.transcript.filter((line) => line.source !== "note").slice(-5);
    return [...own, ...recent].some((line) => similarity(line.text, text) > REPETITION);
  }

  private append(line: TranscriptLine): void {
    this.transcript.push(line);
    const file = this.opts.config.transcript;
    if (file === undefined) return;
    try {
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (e) {
      this.opts.log("director", `could not write the transcript: ${(e as Error).message}`);
    }
  }

  private reachedLimit(): boolean {
    const { turns, minutes } = this.opts.config;
    if (turns !== null && this.turn >= turns) return true;
    if (minutes !== null && Date.now() - this.startedAt >= minutes * 60_000) return true;
    return false;
  }
}
