import tls from "node:tls";
import { once } from "node:events";

/**
 * A Mumble control-protocol client, spoken directly rather than through the UI.
 *
 * # Why this exists next to a Selenium suite
 *
 * Everything else here drives the real desktop client, and that is the right
 * default: it tests what a user touches. It is the wrong tool for a *server
 * parity* question. Some of what a server does has no pixels - whether a
 * refusal arrives as `PermissionDenied` or as silence is invisible in a UI that
 * renders both as "nothing happened", and that difference is exactly what a
 * ported server gets wrong.
 *
 * So this speaks the protocol. It is deliberately tiny: enough to log in, ask
 * to move, and tell an admission from a refusal. It is not a Mumble client and
 * should not grow into one - when a test needs a client, it should use the
 * client.
 *
 * # Why the protobuf is hand-rolled
 *
 * Adding a protobuf runtime and a build step to generate stubs would be a
 * dependency and a code-generation stage for six fields, all of them scalars,
 * none of which have changed since 2009. The encoder below is the wire format's
 * two cases - varint and length-delimited - and nothing else.
 *
 * # TLS
 *
 * Unverified, which is how every Mumble client actually trusts a server: by
 * fingerprint on first use, not by CA chain. A server certificate here is
 * self-signed by construction.
 */

/** Control-message type ids, from `Mumble.proto`'s documented ordering. */
export const MSG = {
  version: 0,
  authenticate: 2,
  ping: 3,
  serverSync: 5,
  channelState: 7,
  userState: 9,
  permissionDenied: 12,
} as const;

/** `ChanACL::Perm::Enter` (`vendor/server/src/ACL.h`). */
export const PERM_ENTER = 0x04;

// ---------------------------------------------------------------------------
// The two protobuf wire cases
// ---------------------------------------------------------------------------

function varint(value: number): Buffer {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return Buffer.from(out);
}

function tag(field: number, wire: number): Buffer {
  return varint((field << 3) | wire);
}

function uintField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function stringField(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([tag(field, 2), varint(bytes.length), bytes]);
}

/**
 * Every scalar field in a message, as `field number -> values`.
 *
 * Repeated because protobuf allows it and because a decoder that silently kept
 * only the last occurrence would be a subtle lie. Length-delimited fields are
 * returned as raw buffers; nothing here needs to recurse into a submessage.
 */
type Decoded = Map<number, (number | Buffer)[]>;

function decode(payload: Buffer): Decoded {
  const fields: Decoded = new Map();
  let at = 0;

  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= payload.length) throw new Error("truncated varint");
      const byte = payload[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };

  const push = (field: number, value: number | Buffer) => {
    const held = fields.get(field);
    if (held) held.push(value);
    else fields.set(field, [value]);
  };

  while (at < payload.length) {
    const key = readVarint();
    const field = key >>> 3;
    switch (key & 0x7) {
      case 0:
        push(field, readVarint());
        break;
      case 2: {
        const length = readVarint();
        push(field, payload.subarray(at, at + length));
        at += length;
        break;
      }
      case 5:
        at += 4;
        break;
      case 1:
        at += 8;
        break;
      default:
        // A group, or a corrupt frame. Either way nothing below reads it and
        // guessing a length would desynchronise the rest of the message.
        return fields;
    }
  }
  return fields;
}

function uint(fields: Decoded, field: number): number | undefined {
  const value = fields.get(field)?.[0];
  return typeof value === "number" ? value : undefined;
}

// ---------------------------------------------------------------------------

/** One frame off the wire. */
export interface Frame {
  type: number;
  fields: Decoded;
}

/** What the server made of a request to enter a channel. */
export type EntryAnswer =
  | { admitted: true; channel: number }
  | { admitted: false; permission?: number; channel?: number; reason?: string };

export class MumbleWire {
  private socket: tls.TLSSocket;
  private buffered = Buffer.alloc(0);
  private queue: Frame[] = [];
  private waiters: (() => void)[] = [];
  /** This connection's session id, once `ServerSync` has arrived. */
  session = 0;

  private constructor(socket: tls.TLSSocket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.absorb(chunk));
    // A closed socket must not hang a waiter forever; the read below times out
    // on its own, and this keeps the process from holding the handle open.
    socket.on("error", () => this.wake());
    socket.on("close", () => this.wake());
  }

  /** Connect and complete the handshake, returning the logged-in client. */
  static async login(
    host: string,
    port: number,
    username: string,
    options: { tokens?: string[]; timeoutMs?: number } = {},
  ): Promise<MumbleWire> {
    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      // Mumble servers commonly present a self-signed certificate with no SAN,
      // which Node rejects before `rejectUnauthorized` is even consulted.
      checkServerIdentity: () => undefined,
    });
    await once(socket, "secureConnect");

    const client = new MumbleWire(socket);
    // A `Version` with only the legacy field is what a pre-1.5 client sends and
    // every server still accepts; nothing here depends on the negotiated
    // version, so the smaller message is the one with fewer ways to be wrong.
    client.send(MSG.version, uintField(1, (1 << 16) | (5 << 8) | 0));
    client.send(
      MSG.authenticate,
      Buffer.concat([
        stringField(1, username),
        ...(options.tokens ?? []).map((token) => stringField(3, token)),
        uintField(5, 1), // opus
      ]),
    );

    const sync = await client.until(
      (frame) => frame.type === MSG.serverSync,
      options.timeoutMs ?? 15000,
      "ServerSync",
    );
    client.session = uint(sync.fields, 1) ?? 0;
    if (client.session === 0) throw new Error("the server issued no session id");
    return client;
  }

  /**
   * Ask to enter `channel`, and report what the server said.
   *
   * Both outcomes are real answers, and a test asserting one has to be able to
   * see the other: a channel that quietly moves nobody and a channel that
   * refuses out loud are the same timeout otherwise.
   */
  async enter(channel: number, options: { tokens?: string[]; timeoutMs?: number } = {}): Promise<EntryAnswer> {
    this.send(
      MSG.userState,
      Buffer.concat([
        uintField(1, this.session),
        uintField(5, channel),
        // `UserState.temporary_access_tokens`, field 20 - the password typed
        // into the "this channel is locked" dialog.
        ...(options.tokens ?? []).map((token) => stringField(20, token)),
      ]),
    );

    const answer = await this.until(
      (frame) =>
        (frame.type === MSG.userState &&
          uint(frame.fields, 1) === this.session &&
          uint(frame.fields, 5) !== undefined) ||
        frame.type === MSG.permissionDenied,
      options.timeoutMs ?? 10000,
      "an answer to the channel switch",
    );

    if (answer.type === MSG.userState) {
      return { admitted: true, channel: uint(answer.fields, 5)! };
    }
    const reason = answer.fields.get(4)?.[0];
    return {
      admitted: false,
      permission: uint(answer.fields, 1),
      channel: uint(answer.fields, 2),
      reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : undefined,
    };
  }

  /**
   * Replace this connection's access tokens without reconnecting.
   *
   * A second `Authenticate` on a live session, which is how a stock client
   * submits a channel password it has just been given.
   */
  retoken(username: string, tokens: string[]): void {
    this.send(
      MSG.authenticate,
      Buffer.concat([stringField(1, username), ...tokens.map((token) => stringField(3, token))]),
    );
  }

  close(): void {
    this.socket.destroy();
  }

  // -- plumbing -----------------------------------------------------------

  private send(type: number, payload: Buffer): void {
    const header = Buffer.alloc(6);
    header.writeUInt16BE(type, 0);
    header.writeUInt32BE(payload.length, 2);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private absorb(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    for (;;) {
      if (this.buffered.length < 6) break;
      const length = this.buffered.readUInt32BE(2);
      if (this.buffered.length < 6 + length) break;
      const type = this.buffered.readUInt16BE(0);
      const payload = this.buffered.subarray(6, 6 + length);
      this.buffered = this.buffered.subarray(6 + length);
      // Type 1 is tunnelled audio and is not protobuf at all; decoding it as
      // such would produce nonsense fields rather than an error.
      if (type !== 1) this.queue.push({ type, fields: decode(payload) });
    }
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resume of waiting) resume();
  }

  /** The next frame matching `want`, skipping everything else. */
  private async until(
    want: (frame: Frame) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.queue.length > 0) {
        const frame = this.queue.shift()!;
        if (want(frame)) return frame;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
