// Fill the local Starling's root channel with a realistic message history:
// several bots, short and long texts, links, and inline images.
// Usage (from the repo root): node --import tsx scripts/perf/flood.mts [total=3000] [perSecond=25] [bots=5] [channel=0]
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { MumbleWire, MSG } from "../../src/util/mumble-wire.ts";

const [total = 3000, perSecond = 25, bots = 5, channel = 0] = process.argv.slice(2).map(Number);
const TEXT_MESSAGE = 11;

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
const uintField = (n: number, v: number) => Buffer.concat([varint(n << 3), varint(v)]);
const bytesField = (n: number, b: Buffer) => Buffer.concat([varint((n << 3) | 2), varint(b.length), b]);
const stringField = (n: number, s: string) => bytesField(n, Buffer.from(s, "utf8"));

/** A small noisy PNG (does not compress), as a data URL. */
function noisePng(width: number, height: number): string {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    randomBytes(width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const WORDS = ("the quick brown fox jumps over a lazy dog while the server keeps humming along and " +
  "everyone in the channel argues about the best noise gate threshold for a cheap headset microphone " +
  "meanwhile somebody shares a screenshot of the new settings page and asks whether the blur is intentional " +
  "okay sure fine great thanks nice wow really hmm lol brb afk gg wp").split(/\s+/);
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function nextMessage(i: number): string {
  const roll = Math.random();
  if (roll < 0.05) return `${cap(words(4))} <img src="${noisePng(120, 90)}">`;
  if (roll < 0.13) return `${cap(words(6))} <a href="http://127.0.0.1:${process.env.LINK_PORT ?? "61194"}/healthz?m=${i}">http://127.0.0.1/healthz?m=${i}</a>`;
  if (roll < 0.28) return cap(words(40 + Math.floor(Math.random() * 60))) + ".";
  if (roll < 0.36) return `**${cap(words(3))}** _${words(5)}_ \`code ${i}\` ${words(4)}`;
  return cap(words(3 + Math.floor(Math.random() * 14))) + pick([".", "!", "?", "", " :)"]);
}

const clients: MumbleWire[] = [];
for (let b = 1; b <= bots; b++) {
  const c = await MumbleWire.login("127.0.0.1", 64738, `bot-${b}`);
  if (channel !== 0) await c.enter(channel);
  clients.push(c);
}
console.log(`logged in ${clients.length} bots, sessions ${clients.map((c) => c.session).join(",")}`);
const send = (c: MumbleWire, type: number, payload: Buffer) => (c as unknown as { send(t: number, p: Buffer): void }).send(type, payload);
const keepalive = setInterval(() => { for (const c of clients) send(c, MSG.ping, Buffer.alloc(0)); }, 10_000);

const started = Date.now();
let sent = 0;
let images = 0;
for (let i = 0; i < total; i++) {
  const c = clients[i % clients.length];
  const text = nextMessage(i);
  if (text.includes("<img")) images++;
  send(c, TEXT_MESSAGE, Buffer.concat([uintField(1, c.session), uintField(3, channel), stringField(5, text)]));
  sent++;
  if (sent % 250 === 0) console.log(`sent ${sent}/${total} (${images} images) after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await new Promise((r) => setTimeout(r, 1000 / perSecond));
}
console.log(`done: ${sent} messages, ${images} with images, in ${((Date.now() - started) / 1000).toFixed(1)}s`);
clearInterval(keepalive);
// Stay connected a moment so the last messages land before the sockets close.
await new Promise((r) => setTimeout(r, 2000));
for (const c of clients) c.close();
