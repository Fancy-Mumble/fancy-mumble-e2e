/**
 * Node-side halves of Discord's local IPC protocol, for driving the client's
 * rich-presence listener from a test.
 *
 * Two roles are needed to exercise the feature end to end:
 *
 *  - {@link DiscordIpcClient} plays a *game* - the thing that publishes
 *    presence. It is what the client under test is supposed to serve.
 *  - {@link FakeDiscord} plays the *Discord desktop client* - the thing our
 *    client must not displace, and must forward to when it is running.
 *
 * The wire format is an 8-byte little-endian header (`opcode`, `length`)
 * followed by that many bytes of JSON. `net` speaks Unix sockets and Windows
 * named pipes through the same API, so nothing here is platform-specific.
 */

import { existsSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Frame opcodes defined by the Discord IPC protocol. */
export enum Opcode {
  Handshake = 0,
  Frame = 1,
  Close = 2,
  Ping = 3,
  Pong = 4,
}

/** One decoded frame. `payload` is `null` for a zero-length body. */
export interface IpcFrame {
  opcode: Opcode;
  payload: any;
}

/** Number of slots Discord defines; clients scan them in order. */
export const SLOT_COUNT = 10;

/**
 * The address of one IPC slot.
 *
 * `runtimeDir` is ignored on Windows, where the pipe namespace is global -
 * which is also why the presence tests cannot isolate themselves there.
 */
export function slotAddress(runtimeDir: string, slot: number): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\discord-ipc-${slot}`
    : path.join(runtimeDir, `discord-ipc-${slot}`);
}

/**
 * A runtime directory that is private for Discord's IPC slots and otherwise
 * indistinguishable from the real one.
 *
 * Isolation is not optional here: the app binds `discord-ipc-0` under
 * `XDG_RUNTIME_DIR`, so without a private one a test would fight the
 * developer's own Discord for the slot and, if it won, silently take over
 * their presence for the duration of the run.
 *
 * But that same directory is where the Wayland compositor, D-Bus and PipeWire
 * keep their sockets, so handing the client an *empty* one stops it opening a
 * window at all ("Failed to initialize GTK") - which looks nothing like the
 * env problem it is. Symlinking every entry except the `discord-ipc-*` ones
 * isolates exactly the namespace under test and leaves the rest working.
 */
export function makeIsolatedRuntimeDir(): string {
  // Short prefix: a Unix socket path is capped near 108 bytes and the slot
  // filename is appended to this.
  const dir = mkdtempSync(path.join(os.tmpdir(), "fm-ipc-"));
  const real = process.env.XDG_RUNTIME_DIR;
  if (!real || !existsSync(real)) return dir;
  for (const entry of readdirSync(real)) {
    if (entry.startsWith("discord-ipc-")) continue;
    try {
      symlinkSync(path.join(real, entry), path.join(dir, entry));
    } catch {
      // An entry we cannot link is one this client will have to do without.
    }
  }
  return dir;
}

function encodeFrame(opcode: Opcode, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * Reassembles frames from a byte stream and hands them out one at a time.
 *
 * A socket delivers arbitrary chunks, so a frame can arrive split across
 * reads or several can arrive together; both cases are real here because the
 * client answers a handshake and a command back to back.
 */
class FramePump {
  private buffer = Buffer.alloc(0);
  private readonly ready: IpcFrame[] = [];
  private waiters: Array<(frame: IpcFrame) => void> = [];
  private failure: Error | null = null;

  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 8) return;
      const length = this.buffer.readUInt32LE(4);
      if (this.buffer.length < 8 + length) return;
      const opcode = this.buffer.readUInt32LE(0) as Opcode;
      const body = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      const frame: IpcFrame = { opcode, payload: body.length > 0 ? JSON.parse(body) : null };
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.ready.push(frame);
    }
  }

  /** Fail every pending and future wait, e.g. once the socket closes. */
  fail(error: Error): void {
    this.failure = error;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter({ opcode: Opcode.Close, payload: { __closed: true } });
  }

  async next(timeoutMs: number): Promise<IpcFrame> {
    const queued = this.ready.shift();
    if (queued) return queued;
    if (this.failure) throw this.failure;
    return new Promise<IpcFrame>((resolve, reject) => {
      const deliver = (frame: IpcFrame) => {
        clearTimeout(timer);
        if (frame.payload?.__closed) reject(this.failure ?? new Error("connection closed"));
        else resolve(frame);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== deliver);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a Discord IPC frame`));
      }, timeoutMs);
      this.waiters.push(deliver);
    });
  }

  /** Whether a frame is already buffered, without waiting for one. */
  get pendingCount(): number {
    return this.ready.length;
  }

  /**
   * Drain everything already decoded, synchronously.
   *
   * The fake server must not `await` between deciding it has frames and
   * consuming them: 'data' can fire again in that gap and a second handler
   * would interleave with the first, double-answering the handshake.
   */
  takeAll(): IpcFrame[] {
    return this.ready.splice(0);
  }
}

function connectSocket(address: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** An application publishing rich presence, i.e. what a game would be. */
export class DiscordIpcClient {
  private readonly pump = new FramePump();

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk) => this.pump.feed(chunk));
    socket.on("close", () => this.pump.fail(new Error("Discord IPC connection closed")));
    // Without this a peer that hangs up mid-test raises an unhandled 'error'
    // and takes the whole node:test process down with it.
    socket.on("error", (e) => this.pump.fail(e));
  }

  static async connect(address: string): Promise<DiscordIpcClient> {
    return new DiscordIpcClient(await connectSocket(address));
  }

  /** Send the opening handshake and return the `READY` dispatch. */
  async handshake(clientId: string, timeoutMs = 15000): Promise<any> {
    this.send(Opcode.Handshake, { v: 1, client_id: clientId });
    const frame = await this.pump.next(timeoutMs);
    if (frame.opcode === Opcode.Close) {
      throw new Error(`handshake refused: ${JSON.stringify(frame.payload)}`);
    }
    return frame.payload;
  }

  /** Publish an activity and return the response, which echoes the nonce. */
  async setActivity(
    activity: unknown,
    opts: { pid?: number; nonce?: string; timeoutMs?: number } = {},
  ): Promise<any> {
    const nonce = opts.nonce ?? `e2e-${Date.now()}`;
    this.send(Opcode.Frame, {
      cmd: "SET_ACTIVITY",
      nonce,
      args: { pid: opts.pid ?? process.pid, activity },
    });
    return (await this.pump.next(opts.timeoutMs ?? 15000)).payload;
  }

  /** Wait for the next unsolicited frame (used to assert none arrives). */
  async nextFrame(timeoutMs: number): Promise<IpcFrame> {
    return this.pump.next(timeoutMs);
  }

  /** Whether anything is already queued, without waiting. */
  get bufferedFrames(): number {
    return this.pump.pendingCount;
  }

  private send(opcode: Opcode, payload: unknown): void {
    this.socket.write(encodeFrame(opcode, payload));
  }

  close(): void {
    this.socket.destroy();
  }
}

/** The `READY` a real Discord client sends; the username identifies it. */
const FAKE_DISCORD_READY = {
  cmd: "DISPATCH",
  evt: "READY",
  data: { v: 1, user: { id: "1", username: "real-discord", discriminator: "0" } },
};

/**
 * Stands in for the Discord desktop client, recording everything forwarded to
 * it and answering like the real one.
 */
export class FakeDiscord {
  /** Every JSON body this endpoint received, oldest first. */
  readonly received: any[] = [];

  /** Live connections, so {@link close} can actually end them. */
  private readonly sockets = new Set<net.Socket>();

  private constructor(
    private readonly server: net.Server,
    readonly address: string,
  ) {}

  static async listen(address: string): Promise<FakeDiscord> {
    const server = net.createServer();
    const fake = new FakeDiscord(server, address);
    server.on("connection", (socket) => fake.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => resolve());
    });
    return fake;
  }

  private serve(socket: net.Socket): void {
    const pump = new FramePump();
    let greeted = false;
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      pump.feed(chunk);
      for (const frame of pump.takeAll()) {
        this.received.push(frame.payload);
        if (!greeted) {
          greeted = true;
          socket.write(encodeFrame(Opcode.Frame, FAKE_DISCORD_READY));
          continue;
        }
        // Every command gets a response carrying its nonce back, or whoever
        // sent it blocks forever waiting for one.
        socket.write(
          encodeFrame(Opcode.Frame, {
            cmd: frame.payload?.cmd ?? null,
            data: null,
            evt: null,
            nonce: frame.payload?.nonce ?? null,
          }),
        );
      }
    });
  }

  /** Wait until a recorded frame satisfies `predicate`, then return it. */
  async waitFor(predicate: (body: any) => boolean, timeoutMs = 15000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `Discord received no matching frame within ${timeoutMs}ms; saw: ` +
            JSON.stringify(this.received.map((f) => f?.cmd ?? Object.keys(f ?? {}))),
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Stop listening and drop every connection.
   *
   * Destroying the sockets first is what makes this return: `server.close()`
   * only stops *new* connections and then waits for the open ones to end, and
   * the client under test holds its bridge connection open indefinitely - so
   * closing without this hangs forever rather than failing.
   */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
