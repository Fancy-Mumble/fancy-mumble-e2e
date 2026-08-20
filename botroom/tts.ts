/**
 * The voice side: text in, PCM out, as it is synthesised.
 *
 * Written against `ghcr.io/malaiwah/qwen3-tts-server`, which is
 * OpenAI-compatible and adds `/v1/audio/speech/pcm-stream` — 24 kHz int16
 * mono, emitted at token granularity, first chunk in a couple of hundred
 * milliseconds. That endpoint is the whole reason a bot can start talking
 * before its sentence has finished synthesising.
 *
 * # The stream is framed, not raw
 *
 * Every chunk on that endpoint is prefixed with a big-endian 32-bit byte
 * length, and the stream ends with a zero-length frame (`server.py`,
 * `generate_pcm`: `struct.pack(">I", len(pcm)) + pcm`). It is documented
 * nowhere the docs are read, and treating the body as raw samples splices
 * two bogus samples into the waveform every 320 ms — a click at three hertz
 * under every sentence, which is exactly what this shipped with for a day.
 * [`deframe`] strips them.
 *
 * The fallback is the plain OpenAI `/v1/audio/speech`, which every other
 * server (Kokoro, OpenAI itself) implements and which returns a whole file.
 * Its bytes are not parsed here: they are handed to ffmpeg, which already has
 * to run and already knows every container. A `Speech` therefore says which of
 * the two it is, and nothing in this file needs a WAV header reader.
 */

export interface Voice {
  id: string;
  name: string;
  /** Comma-separated language tags the preset claims, e.g. `en,zh`. */
  lang: string;
  gender?: string;
}

export type Speech = (
  /** Raw samples, already known to be this rate, this many channels. */
  | { kind: "pcm"; sampleRate: number; channels: number; chunks: AsyncIterable<Buffer> }
  /** A container ffmpeg will sniff — wav, mp3, ogg. */
  | { kind: "encoded"; chunks: AsyncIterable<Buffer> }
) & {
  /**
   * Abandon the request. A speaker who has been cut off has no use for the
   * rest of the sentence, and the synthesiser is a shared GPU — every second
   * it spends finishing a line nobody will hear is a second another bot waits.
   */
  cancel: () => void;
};

export interface TtsOptions {
  url: string;
  apiKey?: string;
  model: string;
  language: string;
  timeoutMs?: number;
}

export interface SpeakOptions {
  voice: string;
  /** A style hint, e.g. "Amused, speaking quickly." Ignored by plain servers. */
  instruct?: string;
  language?: string;
  /**
   * Where this goes in the queue when the synthesiser is busy: lower first.
   * 0 for something that has to come out *now* — "sorry, go on" — 1 for the
   * next sentence of whoever is speaking, 2 for a line being prepared ahead.
   */
  priority?: number;
  /** Abandon the request, whether it is waiting its turn or already running. */
  signal?: AbortSignal;
}

/**
 * How many requests to have running at once.
 *
 * One, and for a reason found the hard way. The Qwen3-TTS server serialises
 * generation on the GPU, and a request whose client has gone away — a bot cut
 * off mid-sentence — is finished anyway. So every speculative request costs
 * everybody: with two chunks prefetched per line, a phrase, and a person in
 * the channel, requests were waiting close to two minutes and timing out. One
 * at a time, ordered by who needs it soonest, and the queue lives here where
 * a request that is no longer wanted can be dropped before it ever costs a
 * millisecond of GPU. Three times real time is plenty for one lane.
 */
const CONCURRENCY = Math.max(1, Number(process.env.TTS_CONCURRENCY ?? "1") || 1);

/** What the streaming endpoint produces, per its documentation. */
const PCM_STREAM_RATE = 24_000;

export class TtsClient {
  /** Set once the streaming endpoint has proved absent, so we stop asking. */
  private streaming = true;
  private inFlight = 0;
  private readonly waiting: { priority: number; at: number; go: () => void; drop: () => void }[] = [];

  constructor(private readonly opts: TtsOptions) {}

  /** How many requests are queued or running right now, for logs. */
  get backlog(): number {
    return this.waiting.length + this.inFlight;
  }

  private acquire(priority: number, signal?: AbortSignal): Promise<void> {
    if (this.inFlight < CONCURRENCY && this.waiting.length === 0) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        priority,
        at: Date.now(),
        go: () => {
          signal?.removeEventListener("abort", onAbort);
          this.inFlight += 1;
          resolve();
        },
        drop: () => {
          signal?.removeEventListener("abort", onAbort);
          reject(new DOMException("speech request abandoned before it started", "AbortError"));
        },
      };
      const onAbort = (): void => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        entry.drop();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
      this.waiting.sort((a, b) => a.priority - b.priority || a.at - b.at);
    });
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiting.shift();
    next?.go();
  }

  async voices(): Promise<Voice[]> {
    const response = await this.fetch("/v1/voices", { method: "GET" });
    if (!response.ok) throw new Error(`GET /v1/voices: ${response.status} ${response.statusText}`);
    const body = (await response.json()) as { data?: Partial<Voice>[] };
    return (body.data ?? [])
      .filter((voice): voice is Voice => typeof voice.id === "string")
      .map((voice) => ({
        id: voice.id,
        name: voice.name ?? voice.id,
        lang: voice.lang ?? "",
        gender: voice.gender,
      }));
  }

  /** True while the low-latency endpoint is still in use. */
  get isStreaming(): boolean {
    return this.streaming;
  }

  /**
   * Which model the endpoint serves, if it says.
   *
   * For the log. The Qwen3-TTS *Base* model warns on every request that it
   * "does not follow instructions reliably", which made the mood hint the
   * obvious suspect when speech came out garbled — but eighteen sentences
   * with hints from "quiet, hurt" to "screaming, unhinged, fast" all came
   * back word-perfect through Whisper on an idle server. The garbling was
   * the server being starved (see `CONCURRENCY`), and the hints stay.
   */
  async describe(): Promise<string | null> {
    try {
      const response = await this.fetch("/v1/models", { method: "GET" });
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: { id?: string; owned_by?: string }[] };
      const real = (body.data ?? []).find(
        (entry) => typeof entry.id === "string" && !/^tts-1/.test(entry.id),
      );
      return real?.id ?? null;
    } catch {
      return null;
    }
  }

  async speak(text: string, options: SpeakOptions): Promise<Speech> {
    const control = new AbortController();
    const cancel = (): void => control.abort();
    if (options.signal) {
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    }
    await this.acquire(options.priority ?? 1, control.signal);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.release();
    };
    // Whatever happens to the request — finished, cancelled, failed — the lane
    // is freed exactly once. The body reader's own `finally` does it for the
    // normal case; the abort path covers a request cancelled while waiting for
    // headers, when there is no body yet to finish.
    control.signal.addEventListener("abort", release, { once: true });
    const body = {
      model: this.opts.model,
      input: text,
      voice: options.voice,
      language: options.language ?? this.opts.language,
      ...(options.instruct ? { instruct: options.instruct } : {}),
    };

    try {
      if (this.streaming) {
        const response = await this.post("/v1/audio/speech/pcm-stream", body, control.signal);
        if (response.ok && response.body) {
          return {
            kind: "pcm",
            sampleRate: PCM_STREAM_RATE,
            channels: 1,
            chunks: deframe(read(response.body, release)),
            cancel,
          };
        }
        // 404 is "this server is not Qwen3-TTS"; anything else is a real failure
        // and should not be papered over by silently degrading every later turn.
        if (response.status !== 404 && response.status !== 405) {
          throw new Error(
            `speech synthesis failed: ${response.status} ${response.statusText}: ` +
              `${(await response.text()).slice(0, 300)}`,
          );
        }
        this.streaming = false;
      }

      const response = await this.post(
        "/v1/audio/speech",
        { ...body, response_format: "wav" },
        control.signal,
      );
      if (!response.ok || !response.body) {
        throw new Error(
          `speech synthesis failed: ${response.status} ${response.statusText}: ` +
            `${(await response.text()).slice(0, 300)}`,
        );
      }
      return { kind: "encoded", chunks: read(response.body, release), cancel };
    } catch (e) {
      release();
      throw e;
    }
  }

  private post(route: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.fetch(
      route,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  private fetch(route: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.opts.apiKey) headers.set("authorization", `Bearer ${this.opts.apiKey}`);
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    return fetch(`${this.opts.url}${route}`, {
      ...init,
      headers,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  }
}

/**
 * A `fetch` body as buffers.
 *
 * Each chunk is copied rather than wrapped: the consumer hands these to a child
 * process's stdin, which writes them whenever it pleases, and a view onto a
 * buffer the runtime may reuse is the kind of bug that shows up as one
 * corrupted syllable an hour into a run.
 */
/**
 * Strip the length prefixes off the PCM stream and yield only samples.
 *
 * A prefix can straddle two HTTP chunks, and so can a payload; the carry
 * handles both. Anything after the zero-length end frame is ignored. A
 * server that sends unframed audio would fail the very first prefix (a
 * "length" in the hundreds of millions), so that case is detected and the
 * rest of the stream passed through as it is — better one odd sample than a
 * silent bot against a differently framed endpoint.
 */
async function* deframe(chunks: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  let carry: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let raw = false;
  for await (const chunk of chunks) {
    if (raw) {
      yield chunk;
      continue;
    }
    let data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let at = 0;
    for (;;) {
      if (remaining > 0) {
        const take = Math.min(remaining, data.length - at);
        if (take > 0) yield data.subarray(at, at + take);
        at += take;
        remaining -= take;
        if (remaining > 0) break;
      }
      if (data.length - at < 4) break;
      const length = data.readUInt32BE(at);
      if (length === 0) return;
      if (length > 1 << 24) {
        // Not a frame length: this stream is not framed after all.
        raw = true;
        yield data.subarray(at);
        at = data.length;
        break;
      }
      at += 4;
      remaining = length;
    }
    carry = at < data.length ? Buffer.from(data.subarray(at)) : Buffer.alloc(0);
    data = Buffer.alloc(0);
  }
}

async function* read(body: ReadableStream<Uint8Array>, done: () => void): AsyncIterable<Buffer> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) return;
      if (value && value.byteLength > 0) yield Buffer.from(value);
    }
  } finally {
    // `cancel`, not `releaseLock`: a consumer that stopped early wants the
    // connection dropped, and on a stream that has already ended this is a
    // no-op rather than an error.
    reader.cancel().catch(() => undefined);
    done();
  }
}
