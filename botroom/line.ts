/**
 * One line of dialogue as it is actually said: in pieces, interruptibly.
 *
 * A turn used to be one synthesis request and one stream of frames, which is
 * fine until somebody talks over it. Then two things are needed that a single
 * stream cannot give: to stop *now*, and to know where to pick up. So a line is
 * cut into sentence-sized chunks (`speechChunks`), each its own request. The
 * next chunk is always being synthesised while the current one plays, so the
 * seams cost nothing, and a bot cut off in chunk three resumes at chunk three —
 * re-synthesised, because the first attempt was cancelled with the rest of it.
 */

import type { AudioBot } from "../src/util/audio-bot";
import { opusFrames, type EncodeOptions } from "./speech";
import type { SpeakOptions, TtsClient } from "./tts";
import { delay, speechChunks } from "./util";

/** Everything needed to turn a chunk of text into frames for one speaker. */
export interface Voicing {
  tts: TtsClient;
  encode: EncodeOptions;
  options: SpeakOptions;
}

export class SpokenLine {
  readonly chunks: string[];
  private readonly frames: (Promise<AsyncIterable<Buffer> | null> | undefined)[];
  private readonly used: boolean[];
  /** Aborted when the line is discarded; drops requests still in the queue. */
  private readonly control = new AbortController();
  /**
   * The chunk being spoken, or the next one to be spoken. `chunks.length` once
   * the whole line is out; after an interruption, the chunk that was cut.
   */
  index = 0;

  constructor(
    readonly text: string,
    private readonly voicing: Voicing | null,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.chunks = speechChunks(text);
    this.frames = new Array<Promise<AsyncIterable<Buffer> | null> | undefined>(this.chunks.length);
    this.used = new Array<boolean>(this.chunks.length).fill(false);
  }

  /** How much of it has actually been said, for the record. */
  get spoken(): string {
    return this.chunks.slice(0, this.index).join(" ");
  }

  get finished(): boolean {
    return this.index >= this.chunks.length;
  }

  /**
   * Begin synthesising chunk `i` now, if it is not already on its way.
   *
   * `priority` orders it against everything else waiting for the synthesiser
   * (see `SpeakOptions.priority`): a line being spoken asks for its next
   * sentence at 1, a line being prepared for later at 2.
   */
  prefetch(i: number, priority = 1): void {
    if (i < 0 || i >= this.chunks.length) return;
    if (this.frames[i] !== undefined && !this.used[i]) return;
    this.frames[i] = this.synthesise(this.chunks[i], priority);
    this.used[i] = false;
  }

  /** True once the first chunk's frames exist, i.e. the line can start at once. */
  get ready(): boolean {
    return this.frames[0] !== undefined && !this.used[0];
  }

  /**
   * Say the line from chunk `from`. Resolves `true` when it was said to the
   * end, `false` when `signal` cut it off — `index` then says where.
   */
  async speak(bot: AudioBot | null, from: number, signal?: AbortSignal): Promise<boolean> {
    for (let i = from; i < this.chunks.length; i++) {
      if (signal?.aborted) return false;
      this.index = i;
      this.prefetch(i, 1);
      this.prefetch(i + 1, 1);
      const frames = await this.frames[i];
      this.used[i] = true;
      if (signal?.aborted) {
        // Cut off while the sentence was still being synthesised. Nobody will
        // hear it; stop the request rather than let it finish for no one.
        void frames?.[Symbol.asyncIterator]().return?.();
        return false;
      }
      if (frames !== null && frames !== undefined && bot !== null) {
        try {
          await bot.speak(frames, { signal });
        } catch (e) {
          // The synthesiser or the encoder failed part-way. One silent
          // sentence is a much smaller thing than a run that stops.
          this.log(`voice dropped out mid-sentence: ${(e as Error).message}`);
        }
      } else {
        // No voice — muted, dry run, or synthesis failed for this chunk. Hold
        // the floor for about as long as saying it would take, so the room
        // keeps its rhythm.
        await delay(readingTimeMs(this.chunks[i]), signal);
      }
      if (signal?.aborted) return false;
    }
    this.index = this.chunks.length;
    return true;
  }

  /** Let go of any audio synthesised for a line that will not be spoken. */
  discard(): void {
    this.control.abort();
    for (const pending of this.frames) {
      void pending?.then((frames) => frames?.[Symbol.asyncIterator]().return?.());
    }
  }

  private async synthesise(chunk: string, priority: number): Promise<AsyncIterable<Buffer> | null> {
    if (this.voicing === null) return null;
    try {
      const speech = await this.voicing.tts.speak(chunk, {
        ...this.voicing.options,
        priority,
        signal: this.control.signal,
      });
      // Speech runs at roughly twelve to fifteen characters a second. Twice
      // that plus a margin is generous for any delivery and still catches the
      // synthesiser running away (see `EncodeOptions.maxFrames`).
      const maxSeconds = Math.min(40, Math.max(5, (chunk.length / 12) * 2 + 3));
      return opusFrames(speech, {
        ...this.voicing.encode,
        maxFrames: Math.ceil((maxSeconds * 1000) / this.voicing.encode.frameMs),
      });
    } catch (e) {
      if (!this.control.signal.aborted) {
        this.log(`no voice for "${chunk.slice(0, 40)}…": ${(e as Error).message}`);
      }
      return null;
    }
  }
}

/** Roughly how long the text would take to say, for runs with no audio. */
export function readingTimeMs(text: string): number {
  const words = text.split(/\s+/).filter((word) => word.length > 0).length;
  return Math.max(700, Math.round((words / 150) * 60_000) + 200);
}
