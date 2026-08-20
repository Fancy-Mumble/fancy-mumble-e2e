/**
 * The text side: one OpenAI-compatible chat client.
 *
 * There is exactly one client rather than one per engine because llama.cpp's
 * `llama-server`, vLLM and Ollama all serve `/v1/chat/completions` with the
 * same request shape. The engine is a deployment decision (see
 * `docs/BOTROOM-PLAN.md` §6), not something the bots should know about.
 *
 * # Thinking has to be off
 *
 * Qwen3.8 reasons by default, at "xhigh" effort. Left on, a two-sentence
 * conversational turn arrives after several seconds of invisible deliberation
 * and the room falls silent between speakers. The switch is
 * `chat_template_kwargs: {enable_thinking: false}`, which llama-server applies
 * when it was started with `--jinja` and vLLM applies always — but Ollama and
 * older builds reject the unknown field outright with a 400. So the first
 * refusal retries without it and remembers, and [`spoken`] strips any `<think>`
 * block that arrives anyway. Belt and braces, because the failure mode of
 * getting this wrong is a conversation that looks fine and is unusably slow.
 */

import { spoken } from "./util";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Strip a leading "Name:" label and any narration from the answer. */
  speaker?: string;
  stop?: string[];
}

export interface LlmOptions {
  url: string;
  model: string;
  apiKey?: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  timeoutMs?: number;
}

export class LlmClient {
  private thinkingKwarg = true;

  constructor(private readonly opts: LlmOptions) {}

  get model(): string {
    return this.opts.model;
  }

  /** The models the endpoint admits to having, for a start-up check. */
  async models(): Promise<string[]> {
    const response = await this.fetch("/v1/models", { method: "GET" });
    if (!response.ok) throw new Error(`GET /v1/models: ${response.status} ${response.statusText}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((entry) => entry.id ?? "").filter((id) => id.length > 0);
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: options.temperature ?? this.opts.temperature,
      top_p: options.topP ?? this.opts.topP,
      max_tokens: options.maxTokens ?? this.opts.maxTokens,
      stream: false,
    };
    if (options.stop) body.stop = options.stop;
    if (this.thinkingKwarg) body.chat_template_kwargs = { enable_thinking: false };

    let response = await this.post("/v1/chat/completions", body);
    if (response.status === 400 && this.thinkingKwarg) {
      // The endpoint does not know the field. Say so once — a run that silently
      // leaves thinking on is the slow, mystifying failure this guards.
      this.thinkingKwarg = false;
      delete body.chat_template_kwargs;
      response = await this.post("/v1/chat/completions", body);
    }
    if (!response.ok) {
      throw new Error(
        `chat completion failed: ${response.status} ${response.statusText}: ` +
          `${(await response.text()).slice(0, 400)}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    return options.speaker !== undefined ? spoken(content, options.speaker) : content.trim();
  }

  /** True once the endpoint has refused `chat_template_kwargs`. */
  get thinkingSwitchAccepted(): boolean {
    return this.thinkingKwarg;
  }

  /**
   * A reply shaped by a JSON schema.
   *
   * llama-server, vLLM and recent Ollama all take OpenAI's
   * `response_format: {type: "json_schema"}` and constrain decoding to it, so
   * the shape is guaranteed rather than hoped for — which matters when the
   * answer decides how a bot *sounds* and a stray sentence of prose would be
   * read aloud. An endpoint that rejects the field gets the schema in the
   * prompt instead and a lenient parse; the parse is the weak half, and it is
   * only reached on servers this was not written against.
   */
  async chatJson(messages: ChatMessage[], schema: object, options: ChatOptions = {}): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: options.temperature ?? this.opts.temperature,
      top_p: options.topP ?? this.opts.topP,
      max_tokens: options.maxTokens ?? this.opts.maxTokens,
      stream: false,
    };
    if (this.thinkingKwarg) body.chat_template_kwargs = { enable_thinking: false };

    let response: Response | null = null;
    if (this.jsonSchema) {
      body.response_format = { type: "json_schema", json_schema: { name: "reply", strict: true, schema } };
      response = await this.post("/v1/chat/completions", body);
      if (response.status === 400) {
        const why = await response.text();
        if (/thinking|template_kwargs/i.test(why) && this.thinkingKwarg) {
          this.thinkingKwarg = false;
          delete body.chat_template_kwargs;
          response = await this.post("/v1/chat/completions", body);
        } else {
          this.jsonSchema = false;
          response = null;
        }
      }
    }
    if (response === null) {
      delete body.response_format;
      body.messages = [
        ...messages,
        {
          role: "system",
          content: `Answer with a single JSON object matching this schema and nothing else: ${JSON.stringify(schema)}`,
        },
      ];
      response = await this.post("/v1/chat/completions", body);
    }
    if (!response.ok) {
      throw new Error(
        `chat completion failed: ${response.status} ${response.statusText}: ` +
          `${(await response.text()).slice(0, 400)}`,
      );
    }
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = (payload.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "");
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`the model returned no JSON object: ${content.slice(0, 120)}`);
    return JSON.parse(content.slice(start, end + 1));
  }

  private jsonSchema = true;

  private post(route: string, body: unknown): Promise<Response> {
    return this.fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private fetch(route: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.opts.apiKey) headers.set("authorization", `Bearer ${this.opts.apiKey}`);
    return fetch(`${this.opts.url}${route}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
  }
}
