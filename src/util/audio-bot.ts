/**
 * A Mumble client that exists only to talk: it logs in, sits in a room, and
 * streams Opus.
 *
 * # Why this is not `MumbleWire`
 *
 * That module is deliberately tiny and says so — enough to log in, ask to move,
 * and tell an admission from a refusal — because a *test* that needs a client
 * should use the client. This is not a test. It is a load generator, and the
 * one thing it must do is the one thing `MumbleWire` refuses to grow: put audio
 * frames on the wire, at a real cadence, for as long as you leave it running.
 *
 * # Two flavours, on purpose
 *
 * `classic` announces no Fancy fields at all and sends the pre-1.5 binary audio
 * packet (type 4). `fancy` announces `fancy_protocol = 1` and sends the
 * protobuf audio packet (type 0) that Mumble 1.5 introduced. Those are the two
 * decoders in Starling's `voice/src/packet.rs`, and running both at once is the
 * point: a server that gets one of them wrong looks perfectly healthy to a
 * fleet that only speaks the other.
 *
 * Note the split is *not* the same question. The audio framing follows the
 * announced **Mumble** version (`supports_protobuf_audio`, ≥ 1.5), and the
 * epoch follows `fancy_protocol`. They are paired here because that is how real
 * clients come — a stock 1.4 client and a Fancy 1.6 client — but they are two
 * fields, and a server may disagree with either independently.
 *
 * # Why audio goes down the TCP tunnel
 *
 * Mumble carries audio over UDP and falls back to `UDPTunnel` inside the
 * control connection when UDP cannot get through. The bots use the tunnel
 * unconditionally, for two reasons: the deployment this was written against
 * drops inbound UDP entirely, and the tunnel needs no OCB2/XChaCha20 key
 * schedule, so there is no cipher implementation here to get subtly wrong. The
 * server decodes the identical payload either way.
 *
 * **It therefore does not exercise the UDP path.** A bot fleet that is all
 * green proves the control plane, the routing and both audio decoders; it
 * proves nothing about the voice socket.
 */

import tls from "node:tls";
import { once } from "node:events";

import { encodeToOpus, describe, type OpusStream, type SourceSpec } from "./opus-source";

/** Upstream TCP message types this module uses. */
const MSG = {
  version: 0,
  udpTunnel: 1,
  authenticate: 2,
  ping: 3,
  reject: 4,
  serverSync: 5,
  channelRemove: 6,
  channelState: 7,
  userRemove: 8,
  userState: 9,
  textMessage: 11,
  permissionDenied: 12,
} as const;

/**
 * How long to leave between control messages sent back-to-back on one
 * connection.
 *
 * The gateway charges `ChannelState` and `UserState` against a bucket sized
 * like murmur's, about one a second. Only the room keeper sends a run of them;
 * a bot sends one and has its own connection, so this is not a global pace.
 */
const CONTROL_BUCKET_MS = 1100;

/** Which dialect a bot speaks. */
export type Flavour = "classic" | "fancy";

/** One bot's identity, room and sound. */
export interface BotSpec {
  /** The name it logs in under. */
  username: string;
  /** Only for a registered account; guests leave it unset. */
  password?: string;
  flavour: Flavour;
  /** Room to sit in. Created under the root when it does not exist. */
  room: string;
  /**
   * A clip to loop for as long as the bot is up — the load-generator case.
   *
   * Leave it unset for a bot that only speaks when told to, and drive it with
   * [`AudioBot.speak`] instead. A bot with no source connects, joins its room
   * and then sits silent, which is what a conversational bot wants between
   * its turns.
   */
  source?: SourceSpec;
  /** Opus frame duration; 10, 20, 40 or 60. */
  frameMs?: number;
  bitrateKbps?: number;
  /** Restart the clip when it runs out. */
  loop?: boolean;
}

/** A `TextMessage` that arrived on this connection. */
export interface TextEvent {
  /** The session that sent it, or 0 when the server itself did. */
  actor: number;
  /** That session's name, if this connection has seen a `UserState` for it. */
  actorName: string | undefined;
  message: string;
  /** Channels it was addressed to; empty for a direct message. */
  channelIds: number[];
  /** Sessions it was addressed to; non-empty means it was private. */
  sessions: number[];
}

/** What a running bot reports about itself. */
export interface BotStats {
  username: string;
  flavour: Flavour;
  room: string;
  channelId: number | null;
  session: number;
  packetsSent: number;
  bytesSent: number;
  loops: number;
  connected: boolean;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// protobuf: the two wire cases, and enough decoding to read a handshake
// ---------------------------------------------------------------------------

/**
 * A protobuf varint.
 *
 * Arithmetic, not bitwise: `version_v2` is a 64-bit field whose real values sit
 * above 2^48, and JavaScript's `&` and `>>` coerce to *32 bits* first, so a
 * bitwise implementation silently truncates exactly the field that matters most
 * here. Every value stays under `Number.MAX_SAFE_INTEGER`.
 */
function varint(value: number): Buffer {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return Buffer.from(out);
}

const tag = (field: number, wire: number): Buffer => varint((field << 3) | wire);
const uintField = (field: number, value: number): Buffer =>
  Buffer.concat([tag(field, 0), varint(value)]);
const boolField = (field: number, value: boolean): Buffer =>
  Buffer.concat([tag(field, 0), varint(value ? 1 : 0)]);
function stringField(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([tag(field, 2), varint(bytes.length), bytes]);
}
function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(value.length), value]);
}

type Decoded = Map<number, (number | Buffer)[]>;

/** Every scalar field in a message, as `field number -> values`. */
function decode(payload: Buffer): Decoded {
  const out: Decoded = new Map();
  const put = (field: number, value: number | Buffer): void => {
    const existing = out.get(field);
    if (existing) existing.push(value);
    else out.set(field, [value]);
  };
  let at = 0;
  while (at < payload.length) {
    let key = 0;
    let shift = 0;
    while (at < payload.length) {
      const byte = payload[at++];
      key += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    const field = key >>> 3;
    switch (key & 7) {
      case 0: {
        let value = 0;
        let vshift = 0;
        while (at < payload.length) {
          const byte = payload[at++];
          value += (byte & 0x7f) * Math.pow(2, vshift);
          vshift += 7;
          if ((byte & 0x80) === 0) break;
        }
        put(field, value);
        break;
      }
      case 2: {
        let len = 0;
        let lshift = 0;
        while (at < payload.length) {
          const byte = payload[at++];
          len += (byte & 0x7f) * Math.pow(2, lshift);
          lshift += 7;
          if ((byte & 0x80) === 0) break;
        }
        put(field, payload.subarray(at, at + len));
        at += len;
        break;
      }
      case 5:
        put(field, payload.readUInt32LE(at));
        at += 4;
        break;
      case 1:
        put(field, Number(payload.readBigUInt64LE(at)));
        at += 8;
        break;
      default:
        return out; // an unknown wire type; nothing here needs to recover
    }
  }
  return out;
}

const num = (fields: Decoded, field: number): number | undefined => {
  const value = fields.get(field)?.[0];
  return typeof value === "number" ? value : undefined;
};
const str = (fields: Decoded, field: number): string | undefined => {
  const value = fields.get(field)?.[0];
  return Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
};
/** Every value of a repeated scalar field — `TextMessage` has three of them. */
const numbers = (fields: Decoded, field: number): number[] =>
  (fields.get(field) ?? []).filter((value): value is number => typeof value === "number");

/**
 * Mumble's own variable-length integer, which is **not** protobuf's.
 *
 * Big-endian, with the length in a unary prefix. Only used by the legacy audio
 * packet, and only for values small enough that the first three cases matter,
 * but the rest are written out because a sequence number climbs all day and a
 * bot left running overnight will reach them.
 */
function mumbleVarint(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([0x80 | ((value >> 8) & 0x3f), value & 0xff]);
  if (value < 0x200000) {
    return Buffer.from([0xc0 | ((value >> 16) & 0x1f), (value >> 8) & 0xff, value & 0xff]);
  }
  if (value < 0x10000000) {
    return Buffer.from([
      0xe0 | ((value >> 24) & 0x0f),
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
  const wide = Buffer.alloc(5);
  wide[0] = 0xf0;
  wide.writeUInt32BE(value >>> 0, 1);
  return wide;
}

/**
 * Read one Mumble varint, for the *server to client* direction.
 *
 * Only the four short forms and the 32-bit escape are decoded, because the one
 * caller wants a session id out of the front of an audio packet and a session
 * id is small. Anything else — the 64-bit form, the negative and the inverted
 * encodings, all of which exist — returns `null` rather than a wrong number:
 * this is used to notice that somebody is speaking, and a guess would be worse
 * than a shrug.
 */
function readMumbleVarint(data: Buffer, at: number): { value: number; size: number } | null {
  if (at >= data.length) return null;
  const lead = data[at];
  if ((lead & 0x80) === 0x00) return { value: lead & 0x7f, size: 1 };
  if ((lead & 0xc0) === 0x80) {
    return at + 1 < data.length ? { value: ((lead & 0x3f) << 8) | data[at + 1], size: 2 } : null;
  }
  if ((lead & 0xe0) === 0xc0) {
    return at + 2 < data.length
      ? { value: ((lead & 0x1f) << 16) | (data[at + 1] << 8) | data[at + 2], size: 3 }
      : null;
  }
  if ((lead & 0xf0) === 0xe0) {
    return at + 3 < data.length
      ? {
          value: (lead & 0x0f) * 2 ** 24 + (data[at + 1] << 16) + (data[at + 2] << 8) + data[at + 3],
          size: 4,
        }
      : null;
  }
  if ((lead & 0xfc) === 0xf0) {
    return at + 4 < data.length ? { value: data.readUInt32BE(at + 1), size: 5 } : null;
  }
  return null;
}

/** An audio packet that arrived on the tunnel, taken apart as far as needed. */
export interface IncomingVoice {
  sender: number;
  /** The Opus payload, or `null` when the packet was not Opus or was malformed. */
  opus: Buffer | null;
  /** The sender's talk-spurt ends with this packet. */
  terminator: boolean;
}

/**
 * Who sent an audio packet, and what they said — as bytes, not as sound.
 *
 * The two formats differ throughout. The legacy packet is `type|target`, then
 * session, sequence, and (for Opus) a header varint whose low 13 bits are the
 * payload length and bit 13 the terminator, then the payload; anything after
 * it is positional data and is ignored. The protobuf `Audio` carries
 * `sender_session` in field 3, the payload in field 5 and the terminator in
 * field 16. Nothing here decodes Opus. What a caller does with the payload —
 * hand it to a recogniser, count it — is its business; this connection is
 * still not a listening client.
 */
function parseVoice(packet: Buffer): IncomingVoice | null {
  if (packet.length < 2) return null;
  const type = packet[0] >> 5;
  if (type === 4) {
    const session = readMumbleVarint(packet, 1);
    if (session === null) return null;
    const sequence = readMumbleVarint(packet, 1 + session.size);
    if (sequence === null) return { sender: session.value, opus: null, terminator: false };
    const at = 1 + session.size + sequence.size;
    const header = readMumbleVarint(packet, at);
    if (header === null) return { sender: session.value, opus: null, terminator: false };
    const length = header.value & 0x1fff;
    const start = at + header.size;
    return {
      sender: session.value,
      opus: start + length <= packet.length ? packet.subarray(start, start + length) : null,
      terminator: (header.value & 0x2000) !== 0,
    };
  }
  if (type === 0) {
    const fields = decode(packet.subarray(1));
    const sender = num(fields, 3);
    if (sender === undefined) return null;
    const payload = fields.get(5)?.[0];
    return {
      sender,
      opus: Buffer.isBuffer(payload) ? payload : null,
      terminator: (num(fields, 16) ?? 0) !== 0,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * A Mumble version in the v2 encoding: `major << 48 | minor << 32 | patch << 16`.
 *
 * **The bottom sixteen bits are padding and the shifts are easy to lose.** This
 * function first read `major << 32 | minor << 16 | patch`, which encodes 1.6.0
 * as 0x0001_0006_0000 — a number that decodes to *0.1.6*, below every gate the
 * field exists to pass. Starling then served those bots the pre-1.5 audio
 * framing while they sent protobuf, and the server logged them as
 * "decrypted but did not parse; this peer is inaudible".
 *
 * It is worth knowing that this is a rake the project has stepped on before, in
 * the server: the same missing shift is called out on `MUMBLE_VERSION_V2` in
 * `session-lifecycle/src/handshake.rs`, with the same note that the handshake
 * completes either way and nothing looks wrong.
 *
 * Multiplication rather than `<<` for the same reason as [`varint`]: `1 << 48`
 * is 0 in JavaScript.
 */
const v2 = (major: number, minor: number, patch: number): number =>
  major * 2 ** 48 + minor * 2 ** 32 + patch * 2 ** 16;

/** The pre-1.5 packing of the same version, 8 bits per part. */
const v1 = (major: number, minor: number, patch: number): number =>
  (major << 16) | (minor << 8) | patch;

/** The Fancy feature level a `fancy` bot claims, in the same packing. */
const FANCY_VERSION = v2(0, 4, 2);

export interface BotOptions {
  host: string;
  port: number;
  /** Called for every notable event, so a runner can log with its own format. */
  onEvent?: (bot: string, message: string) => void;
  connectTimeoutMs?: number;
  /**
   * Called for every `TextMessage` this connection receives, including the
   * echo of the ones it sends itself — the server sends those back like any
   * other, and a caller that does not want them filters on `actor`.
   */
  onText?: (event: TextEvent) => void;
  /**
   * Called for every audio packet that arrives on the tunnel from anyone but
   * this bot itself, with the sender and the still-encoded payload (see
   * [`parseVoice`]). Nothing is decoded here; a caller that only wants to know
   * whether somebody is talking can ignore everything but the session.
   */
  onVoice?: (voice: IncomingVoice) => void;
}

/** How much audio to have in hand before an utterance starts going out. */
const PREBUFFER_FRAMES = 10;

/**
 * How far ahead of real time a talker may run, in frames.
 *
 * **This is what stops the clicking.** The Fancy client has no jitter buffer:
 * it primes on 100 ms of audio the first time and then only re-primes after
 * 1.5 s of silence, so a talk-spurt that begins after a shorter pause — every
 * sentence seam, every gap between turns — plays with whatever lead the sender
 * gives it. A sender that paces at exactly real time gives it none: each 20 ms
 * packet lands just as the previous one is consumed, every 10 ms callback
 * comes up a few samples short, and the client's underrun ramp fires fifty
 * times a second. That is a click train under the speech.
 *
 * So the schedule allows the sender to be up to this many frames *early*.
 * Whenever it has frames in hand — at the start of a spurt, and again after a
 * stall — it sends them at once until it is this far ahead, then paces. The
 * receiver ends up with a lead of this much to absorb jitter, and the cost is
 * the same amount of latency, which a listener cannot tell from a breath.
 */
const LEAD_FRAMES = 6;

export class AudioBot {
  private socket!: tls.TLSSocket;
  private buffered = Buffer.alloc(0);
  private stream: OpusStream | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private cursor = 0;
  private sequence = 0;
  private stopping = false;

  /** Channels seen during the handshake and after, by lowercased name. */
  private readonly channels = new Map<string, number>();

  /** Everyone this connection has seen a `UserState` for, by session. */
  private readonly names = new Map<number, string>();

  /** Channels *this* connection created, so [`stop`] can take them away. */
  private readonly created = new Set<number>();

  session = 0;
  channelId: number | null = null;
  packetsSent = 0;
  bytesSent = 0;
  loops = 0;
  lastError: string | undefined;

  private constructor(
    readonly spec: BotSpec,
    private readonly opts: BotOptions,
  ) {}

  say(message: string): void {
    this.opts.onEvent?.(this.spec.username, message);
  }

  /** The frame duration in use, defaulted. */
  get frameMs(): number {
    return this.spec.frameMs ?? 20;
  }

  /**
   * Connect, log in, encode the audio, and settle in the room.
   *
   * The encode happens here rather than at first frame because it is the slow
   * step — several seconds for a long file — and doing it inside the send loop
   * would stall the first second of every stream.
   */
  static async start(spec: BotSpec, opts: BotOptions): Promise<AudioBot> {
    const bot = new AudioBot(spec, opts);
    if (spec.source) {
      const stream = await encodeToOpus(spec.source, bot.frameMs, spec.bitrateKbps ?? 48);
      bot.stream = stream;
      bot.say(
        `encoded ${describe(spec.source)} -> ${stream.packets.length} frames ` +
          `(${((stream.packets.length * bot.frameMs) / 1000).toFixed(1)} s)`,
      );
    }
    await bot.login();
    await bot.enterRoom();
    // A bot with no clip is a talker rather than a load generator: it sits
    // quiet until somebody hands it an utterance through [`speak`].
    if (spec.source) bot.startStreaming();
    return bot;
  }

  private async login(): Promise<void> {
    const socket = tls.connect({
      host: this.opts.host,
      port: this.opts.port,
      rejectUnauthorized: false,
      // Mumble servers present a self-signed certificate with no SAN, which
      // Node rejects before `rejectUnauthorized` is consulted.
      checkServerIdentity: () => undefined,
    });
    this.socket = socket;
    await once(socket, "secureConnect");
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.absorb(chunk));
    socket.on("error", (e: Error) => {
      this.lastError = e.message;
      this.say(`socket error: ${e.message}`);
    });
    socket.on("close", () => {
      if (!this.stopping) this.say("disconnected by the server");
      this.halt();
    });

    const fancy = this.spec.flavour === "fancy";
    this.send(
      MSG.version,
      Buffer.concat([
        // Both encodings, always. A server reads whichever it understands, and
        // a 1.6 announced only in `version_v1` overflows its 8-bit fields.
        uintField(1, fancy ? v1(1, 6, 0) : v1(1, 4, 0)),
        uintField(5, fancy ? v2(1, 6, 0) : v2(1, 4, 0)),
        stringField(2, fancy ? "FancyMumble 0.4.2" : "Mumble 1.4.0"),
        stringField(3, "Windows"),
        stringField(4, "11"),
        // Only a `fancy` bot claims the epoch, and only a peer that claims it
        // gets Starling's second `Version` and its native message sets.
        ...(fancy ? [uintField(6, FANCY_VERSION), uintField(1000, 1)] : []),
      ]),
    );
    this.send(
      MSG.authenticate,
      Buffer.concat([
        stringField(1, this.spec.username),
        ...(this.spec.password ? [stringField(2, this.spec.password)] : []),
        boolField(5, true), // opus
      ]),
    );

    const sync = await this.until(
      (type) => type === MSG.serverSync || type === MSG.reject,
      this.opts.connectTimeoutMs ?? 15000,
      "ServerSync",
    );
    if (sync.type === MSG.reject) {
      const reason = str(sync.fields, 2) ?? "no reason given";
      throw new Error(`login refused: ${reason}`);
    }
    this.session = num(sync.fields, 1) ?? 0;
    if (this.session === 0) throw new Error("the server issued no session id");
    this.say(`logged in as session ${this.session} (${this.spec.flavour})`);

    // Keep-alive. Mumble's own client pings every 5 s and a server is entitled
    // to reap a connection that never does.
    this.pinger = setInterval(() => {
      if (this.socket.writable) this.send(MSG.ping, uintField(1, Date.now()));
    }, 5000);
  }

  /**
   * Sit in `spec.room`, creating it under the root if nobody has yet.
   *
   * The channel is created **temporary**, so it is collected the moment the
   * last bot leaves it (`metadata/src/lib.rs`, "temporary channel collected").
   * A load test that leaves a dozen rooms behind on a live server is a mess
   * somebody else has to clean up.
   */
  private async enterRoom(): Promise<void> {
    // No room named means "wherever the server puts me", which is the root.
    // Worth having as its own case: the root channel is *not* reliably called
    // "Root" — Starling names it after the instance — so asking for a name to
    // stay put ends in a bot trying to create a channel it is already in and
    // being refused.
    if (this.spec.room.trim().length === 0) {
      this.channelId = 0;
      return;
    }

    const wanted = this.spec.room.toLowerCase();
    // Already on the tree — the usual case when a room keeper made it — or
    // ours to create. A refusal leaves the bot in the root, still streaming.
    const id = this.channels.get(wanted) ?? (await this.createRoom(this.spec.room));
    if (id === null || id === undefined) {
      this.say(`no room ${JSON.stringify(this.spec.room)}; staying in the root`);
      this.channelId = 0;
      return;
    }

    this.send(MSG.userState, Buffer.concat([uintField(1, this.session), uintField(5, id)]));
    const moved = await this.until(
      (type, fields) =>
        (type === MSG.userState && num(fields, 1) === this.session && num(fields, 5) !== undefined) ||
        type === MSG.permissionDenied,
      8000,
      "the move to be acknowledged",
    ).catch(() => null);

    if (moved === null || moved.type === MSG.permissionDenied) {
      this.say(`could not enter ${JSON.stringify(this.spec.room)}; staying put`);
      this.channelId = 0;
      return;
    }
    this.channelId = num(moved.fields, 5) ?? 0;
    this.say(`in ${JSON.stringify(this.spec.room)} (channel ${this.channelId})`);
  }

  /**
   * Create `name` under the root, and return its id — or `null` when the
   * server refuses.
   *
   * **Temporary**, so the server collects it once the last occupant leaves
   * (`metadata/src/lib.rs`, "temporary channel collected"). A load test that
   * leaves a dozen rooms behind on someone's live server is a mess somebody
   * else has to tidy.
   *
   * A refusal is normal rather than exceptional: creating channels is a
   * permission, and a guest on a stock configuration does not have it. The
   * caller falls back to the root, which is a worse test but a real one.
   */
  async createRoom(name: string): Promise<number | null> {
    const wanted = name.toLowerCase();
    const known = this.channels.get(wanted);
    if (known !== undefined) return known;

    this.say(`creating room ${JSON.stringify(name)}`);
    this.send(
      MSG.channelState,
      Buffer.concat([
        uintField(2, 0), // parent: the root
        stringField(3, name),
        boolField(8, true), // temporary
      ]),
    );
    const made = await this.until(
      (type, fields) =>
        (type === MSG.channelState && str(fields, 3)?.toLowerCase() === wanted) ||
        type === MSG.permissionDenied,
      8000,
      `the room ${name} to appear`,
    ).catch(() => null);

    if (made === null || made.type === MSG.permissionDenied) {
      const why = made ? (str(made.fields, 2) ?? "permission denied") : "no answer";
      this.say(`cannot create ${JSON.stringify(name)} (${why})`);
      return null;
    }
    const id = num(made.fields, 1) ?? null;
    if (id !== null) this.created.add(id);
    return id;
  }

  /**
   * Log in as `credentials` and create every room in `rooms`, then stay.
   *
   * Two things make the stay necessary rather than tidy. The rooms are
   * temporary, so one with nobody in it is liable to be collected before the
   * first bot arrives; and creating a channel is a permission the bots
   * themselves do not have, so somebody who does has to be the one to ask.
   *
   * Returns a connection with no audio attached. Close it when the fleet stops
   * and the rooms go with it.
   */
  static async roomKeeper(
    rooms: string[],
    credentials: { username: string; password?: string },
    opts: BotOptions,
  ): Promise<AudioBot> {
    const keeper = new AudioBot(
      {
        username: credentials.username,
        password: credentials.password,
        // The keeper never sends audio, so the flavour only decides which
        // `Version` it announces; classic is the smaller claim.
        flavour: "classic",
        room: "",
        source: { kind: "lavfi", filter: "anullsrc", seconds: 1 },
      },
      opts,
    );
    await keeper.login();

    // **Paced, and retried.** `ChannelState` is charged against the gateway's
    // control bucket, which is murmur's ~1/s (`gateway/src/listener.rs`,
    // `is_rate_limited`), and a shed frame is neither answered nor logged — the
    // comment on that function says so outright. Creating six rooms in a burst
    // therefore loses some of them *silently*: the first run of this dropped
    // exactly one, and it looked like the server ignoring one channel name.
    for (const room of rooms) {
      let id = await keeper.createRoom(room);
      if (id === null) {
        keeper.say(`retrying ${JSON.stringify(room)} after the rate limiter`);
        await delay(1500);
        id = await keeper.createRoom(room);
      }
      if (id === null) keeper.say(`gave up on ${JSON.stringify(room)}`);
      await delay(CONTROL_BUCKET_MS);
    }
    return keeper;
  }

  /**
   * Begin sending, one frame every `frameMs`, until stopped.
   *
   * The schedule is absolute rather than a fixed `setInterval`: each frame is
   * due at `start + n * frameMs`, so a slow tick is followed by a short one and
   * the stream does not drift away from real time. A drifting sender is
   * indistinguishable at the far end from a server that is buffering, which is
   * exactly the thing under test.
   */
  private startStreaming(): void {
    const started = performance.now();
    let n = 0;

    const tick = (): void => {
      if (this.stopping || !this.socket.writable) return;
      this.sendFrame();
      n += 1;
      const due = started + n * this.frameMs;
      this.timer = setTimeout(tick, Math.max(0, due - performance.now()));
    };
    this.timer = setTimeout(tick, 0);
    this.say(`streaming ${this.frameMs} ms frames`);
  }

  private sendFrame(): void {
    if (!this.stream) return;
    const { packets } = this.stream;
    const last = this.cursor >= packets.length - 1;
    const opus = packets[this.cursor];

    // The terminator tells the far end the talk-spurt ended, which is what
    // stops its jitter buffer waiting for a frame that is never coming.
    const terminator = last && !this.spec.loop;
    this.write(this.audioPacket(opus, terminator));

    // The wire counts sequence in 10 ms units regardless of frame size, so a
    // 20 ms frame advances it by two. Getting this wrong makes a stream that
    // decodes perfectly and plays at the wrong speed.
    this.sequence += this.frameMs / 10;
    this.cursor += 1;

    if (this.cursor >= packets.length) {
      if (this.spec.loop) {
        this.cursor = 0;
        this.loops += 1;
      } else {
        this.say("clip finished");
        this.halt();
      }
    }
  }

  private write(payload: Buffer): void {
    this.send(MSG.udpTunnel, payload);
    this.packetsSent += 1;
    this.bytesSent += payload.length;
  }

  /** One audio frame in whichever format this bot's announced version implies. */
  private audioPacket(opus: Buffer, terminator: boolean): Buffer {
    return this.spec.flavour === "fancy"
      ? protobufAudio(this.sequence, opus, terminator)
      : legacyAudio(this.sequence, opus, terminator);
  }

  // -- talking ------------------------------------------------------------

  /** The name this connection knows for `session`, if it has seen one. */
  nameOf(session: number): string | undefined {
    return this.names.get(session);
  }

  /**
   * Post a message to the channel the bot is in.
   *
   * Charged against the gateway's control bucket at roughly one a second
   * (`gateway/src/listener.rs`, `is_rate_limited`), and a shed message is
   * neither answered nor logged. One line per utterance is far under that, but
   * a caller that wants to say two things in a row has to pace them itself —
   * this deliberately does not queue, because a bot that silently lags its own
   * speech is harder to diagnose than one that drops a line.
   */
  sendText(message: string): void {
    if (!this.socket?.writable) return;
    this.send(
      MSG.textMessage,
      Buffer.concat([uintField(3, this.channelId ?? 0), stringField(5, message)]),
    );
  }

  /** True while an utterance is on the wire. */
  get speaking(): boolean {
    return this.utterances > 0;
  }

  /**
   * Say one utterance: take Opus frames as they are produced and pace them onto
   * the wire, resolving once the last one has been sent.
   *
   * This is the counterpart to the clip loop. The frames arrive from a TTS
   * synthesis that is still running, so the queue can run dry mid-sentence;
   * when it does the clock **restarts** rather than catching up, and the
   * sender runs ahead again by [`LEAD_FRAMES`] as soon as it can, so the
   * receiver gets its lead back. The sequence stays contiguous across the
   * pause: the Fancy client's mixer inserts silence for a sequence gap on
   * top of the silence the stall already caused, which would double every
   * hiccup, and a stall short enough to matter is one it has already
   * papered over.
   *
   * Utterances queue behind one another: two overlapping calls would interleave
   * their frames into one unintelligible stream.
   *
   * `signal` cuts the utterance off — the bot is being talked over, or has
   * decided to give way. The frame in hand goes out flagged as the terminator
   * so the far end closes the talk-spurt cleanly instead of waiting out its
   * jitter buffer, and the source is told to stop producing. Resolves normally;
   * being interrupted is not an error.
   */
  speak(packets: AsyncIterable<Buffer>, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const turn = this.speaking$.then(() => this.utter(packets, opts.signal));
    // The chain has to survive a failed utterance, or one TTS error silently
    // mutes the bot for the rest of the run.
    this.speaking$ = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private speaking$: Promise<void> = Promise.resolve();
  private utterances = 0;

  private async utter(packets: AsyncIterable<Buffer>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const queue: Buffer[] = [];
    let finished = false;
    let failure: unknown = null;
    let wake: (() => void) | null = null;

    const nudge = (): void => {
      const waiter = wake;
      wake = null;
      waiter?.();
    };
    const more = (): Promise<void> => new Promise((resolve) => (wake = resolve));
    signal?.addEventListener("abort", nudge, { once: true });

    // The iterator is held by hand rather than driven by `for await`, so that
    // an interruption can call `return()` on it from the outside while a
    // `next()` is still waiting on the synthesiser. That is what stops the
    // producer; breaking out of a `for await` would only stop the consumer.
    const source = packets[Symbol.asyncIterator]();
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await source.next();
          if (done || signal?.aborted) break;
          queue.push(value);
          nudge();
        }
      } catch (e) {
        if (!signal?.aborted) failure = e;
      } finally {
        finished = true;
        nudge();
      }
    })();

    this.utterances += 1;
    try {
      // Fill the pipe before opening the tap. The synthesiser is faster than
      // real time but its *first* chunk takes a few hundred milliseconds, and
      // starting on frame one guarantees an underrun in the first word.
      while (!finished && !signal?.aborted && queue.length < PREBUFFER_FRAMES) await more();

      // The schedule: frame `n` is due at `base + (n - LEAD_FRAMES) * frameMs`,
      // clamped to now. `base` resets after a stall, so the lead is rebuilt.
      let base = performance.now();
      let sent = 0;
      while (!this.stopping && this.socket?.writable) {
        if (signal?.aborted) {
          // Cut off. Whatever frame is in hand carries the terminator; if
          // there is none, the talk-spurt simply ends and the far end times it
          // out, which is what a real client hears from a dropped connection.
          const last = queue.shift();
          if (last !== undefined) {
            this.write(this.audioPacket(last, true));
            this.sequence += this.frameMs / 10;
          }
          break;
        }

        // One frame of lookahead: the terminator rides on the *last* frame, so
        // a frame can only go out once it is known not to be the last one.
        if (queue.length === 0 || (queue.length === 1 && !finished)) {
          if (finished && queue.length === 0) break;
          await more();
          base = performance.now();
          sent = 0;
          continue;
        }

        const opus = queue.shift() as Buffer;
        const terminator = finished && queue.length === 0;
        this.write(this.audioPacket(opus, terminator));
        // 10 ms units on the wire regardless of frame size; see [`sendFrame`].
        this.sequence += this.frameMs / 10;
        sent += 1;

        const due = base + (sent - LEAD_FRAMES) * this.frameMs;
        await delay(Math.max(0, due - performance.now()));
      }
    } finally {
      this.utterances -= 1;
      signal?.removeEventListener("abort", nudge);
      // Tell the source to stop, whether we finished, were stopped, or were
      // interrupted. On a finished source this is a no-op.
      await source.return?.().catch(() => undefined);
      await pump;
    }
    if (failure) throw failure;
  }

  /** Everything a runner wants to print. */
  stats(): BotStats {
    return {
      username: this.spec.username,
      flavour: this.spec.flavour,
      room: this.spec.room,
      channelId: this.channelId,
      session: this.session,
      packetsSent: this.packetsSent,
      bytesSent: this.bytesSent,
      loops: this.loops,
      connected: this.socket?.writable === true && !this.stopping,
      lastError: this.lastError,
    };
  }

  /**
   * Stop sending, remove any rooms this connection created, and close.
   *
   * **The removal is not belt-and-braces.** A temporary channel is collected
   * when its last occupant *leaves*, so one that nobody ever entered has no
   * such event to fire and stays on the tree for good. That is not theoretical:
   * a fleet stopped during start-up left an empty `AFK` room behind on a live
   * server, and only a by-hand `ChannelRemove` got rid of it. Whatever this
   * created, it takes with it.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.halt();

    if (this.socket?.writable && this.created.size > 0) {
      for (const id of this.created) {
        this.send(MSG.channelRemove, uintField(1, id));
        // Paced like the creates: `ChannelRemove` is charged against the same
        // control bucket, and a shed one is silently dropped.
        await delay(CONTROL_BUCKET_MS);
      }
    }

    if (this.socket?.writable) {
      this.socket.end();
      await Promise.race([once(this.socket, "close"), delay(2000)]);
    }
  }

  private halt(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
  }

  // -- framing ------------------------------------------------------------

  private send(type: number, payload: Buffer): void {
    const head = Buffer.alloc(6);
    head.writeUInt16BE(type, 0);
    head.writeUInt32BE(payload.length, 2);
    this.socket.write(Buffer.concat([head, payload]));
  }

  private absorb(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 6) {
      const type = this.buffered.readUInt16BE(0);
      const length = this.buffered.readUInt32BE(2);
      if (this.buffered.length < 6 + length) break;
      const payload = this.buffered.subarray(6, 6 + length);
      this.buffered = this.buffered.subarray(6 + length);
      // The tunnel carries other people's audio back. Only the sender is read
      // out of it — decoding the Opus would make this a client. Everything
      // else is a control message worth reading.
      if (type === MSG.udpTunnel) {
        if (this.opts.onVoice) {
          const voice = parseVoice(payload);
          if (voice !== null && voice.sender !== this.session) this.opts.onVoice(voice);
        }
      } else {
        this.dispatch(type, decode(payload));
      }
    }
  }

  private dispatch(type: number, fields: Decoded): void {
    this.remember(type, fields);
    if (type === MSG.textMessage) this.deliverText(fields);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(type, fields)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve({ type, fields });
      }
    }
  }

  /**
   * Keep the tree and the roster up to date.
   *
   * Names are learned here and nowhere else: a `TextMessage` carries only the
   * sender's session, so without this the bots would be answering numbers.
   */
  private remember(type: number, fields: Decoded): void {
    switch (type) {
      case MSG.channelState: {
        const name = str(fields, 3);
        const id = num(fields, 1);
        if (name !== undefined && id !== undefined) this.channels.set(name.toLowerCase(), id);
        return;
      }
      case MSG.channelRemove: {
        const id = num(fields, 1);
        for (const [name, known] of this.channels) if (known === id) this.channels.delete(name);
        return;
      }
      case MSG.userState: {
        const session = num(fields, 1);
        const name = str(fields, 3);
        if (session !== undefined && name !== undefined) this.names.set(session, name);
        return;
      }
      case MSG.userRemove: {
        const session = num(fields, 1);
        if (session !== undefined) this.names.delete(session);
        return;
      }
      default:
        return;
    }
  }

  private deliverText(fields: Decoded): void {
    if (!this.opts.onText) return;
    const actor = num(fields, 1) ?? 0;
    this.opts.onText({
      actor,
      actorName: this.names.get(actor),
      message: str(fields, 5) ?? "",
      channelIds: numbers(fields, 3),
      sessions: numbers(fields, 2),
    });
  }

  private readonly waiters: {
    match: (type: number, fields: Decoded) => boolean;
    resolve: (frame: { type: number; fields: Decoded }) => void;
  }[] = [];

  /** Wait for the first frame `match` accepts. */
  private until(
    match: (type: number, fields: Decoded) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<{ type: number; fields: Decoded }> {
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (frame: { type: number; fields: Decoded }) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`${this.spec.username}: timed out waiting for ${what}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

// ---------------------------------------------------------------------------
// The two audio packet formats, as `voice/src/packet.rs` decodes them
// ---------------------------------------------------------------------------

/**
 * Pre-1.5 binary Opus packet, client to server.
 *
 * `(4 << 5) | target`, then the sequence, then a 13-bit length with the
 * terminator in bit 13, then the frame. No session id: that field exists only
 * server-to-client, and writing one here shifts every subsequent value.
 */
export function legacyAudio(sequence: number, opus: Buffer, terminator: boolean): Buffer {
  const header = Buffer.from([(4 << 5) | 0]);
  const lengthAndTerminator = (opus.length & 0x1fff) | (terminator ? 0x2000 : 0);
  return Buffer.concat([
    header,
    mumbleVarint(sequence),
    mumbleVarint(lengthAndTerminator),
    opus,
  ]);
}

/**
 * Mumble 1.5+ protobuf audio packet, client to server.
 *
 * Byte 0 is `(0 << 5) | target` and carries the target *instead of* the
 * message's own `Header` oneof, which is left unset — a payload that sets both
 * disagrees with itself.
 */
export function protobufAudio(sequence: number, opus: Buffer, terminator: boolean): Buffer {
  return Buffer.concat([
    Buffer.from([0]),
    uintField(4, sequence), // frame_number
    bytesField(5, opus), // opus_data
    ...(terminator ? [boolField(16, true)] : []),
  ]);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
