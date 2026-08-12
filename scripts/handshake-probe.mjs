/**
 * Time a Mumble control handshake, phase by phase, against any server.
 *
 * Speaks the wire directly — no client, no UI — so the numbers are about the
 * server alone. It presents a client certificate when given one, because a
 * stock Mumble client always does and that changes which path the server takes.
 *
 * The point of it is to partition a slow connect: if this reports ServerSync in
 * tens of milliseconds while a real client takes seconds against the same
 * server, the server is not what is slow.
 *
 *   node scripts/handshake-probe.mjs <host> [port] [username] [fancy]
 *
 * Environment:
 *   PROBE_PASSWORD   password to authenticate with (registered login path,
 *                    which is the only one that pays the PBKDF2 cost)
 *   PROBE_CERT       PEM client certificate, as a stock client presents
 *   PROBE_KEY        its private key
 *   PROBE_MS         how long to keep listening after ServerSync (default 3000)
 *
 * The fifth argument, the literal `fancy`, announces `fancy_protocol = 1` —
 * epoch-1, what a Fancy client claims. Omit it to behave like a stock client.
 */

import tls from "node:tls";
import net from "node:net";
import fs from "node:fs";

const HOST = process.argv[2] ?? "127.0.0.1";
const PORT = Number(process.argv[3] ?? 64738);
const USER = process.argv[4] ?? `probe-${Math.floor(Math.random() * 100000)}`;
const FANCY = process.argv[5] === "fancy";

/** Upstream's TCP message table, for naming what arrives. */
const TYPE = {
  0: "Version", 1: "UDPTunnel", 2: "Authenticate", 3: "Ping", 4: "Reject",
  5: "ServerSync", 6: "ChannelRemove", 7: "ChannelState", 8: "UserRemove",
  9: "UserState", 10: "BanList", 11: "TextMessage", 12: "PermissionDenied",
  13: "ACL", 14: "QueryUsers", 15: "CryptSetup", 16: "ContextActionModify",
  17: "ContextAction", 18: "UserList", 19: "VoiceTarget", 20: "PermissionQuery",
  21: "CodecVersion", 22: "UserStats", 23: "RequestBlob", 24: "ServerConfig",
  25: "SuggestConfig",
};

const t0 = process.hrtime.bigint();
const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
const mark = (what) => console.log(`${ms().toFixed(1).padStart(8)} ms  ${what}`);

// -- just enough protobuf to build two messages ----------------------------
const varint = (n) => {
  const out = [];
  let v = BigInt(n);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
const pVarint = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const pStr = (field, s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
};

/** Mumble's TCP framing: u16 type, u32 length, payload. */
const frame = (type, payload) => {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(type, 0);
  head.writeUInt32BE(payload.length, 2);
  return Buffer.concat([head, payload]);
};

const versionMsg = Buffer.concat([
  pVarint(5, 0x0001_0005_0000n),
  pStr(2, "handshake-probe"),
  pStr(3, process.platform),
  pStr(4, "0"),
  ...(FANCY ? [pVarint(1000, 1)] : []),
]);

const PASSWORD = process.env.PROBE_PASSWORD ?? "";
const authMsg = Buffer.concat([
  pStr(1, USER),
  ...(PASSWORD ? [pStr(2, PASSWORD)] : []),
  pVarint(5, 1), // opus
]);

// -- run -------------------------------------------------------------------
mark(`start (${HOST}:${PORT} as ${USER}${PASSWORD ? ", with password" : ""})`);
const raw = net.connect({ host: HOST, port: PORT }, () => mark("TCP connected"));
raw.setNoDelay(true);

const tlsOpts = { socket: raw, rejectUnauthorized: false };
if (process.env.PROBE_CERT) {
  tlsOpts.cert = fs.readFileSync(process.env.PROBE_CERT);
  tlsOpts.key = fs.readFileSync(process.env.PROBE_KEY);
}

const sock = tls.connect(tlsOpts, () => {
  mark(`TLS established (${sock.getProtocol()}, ${sock.getCipher().name})`);
  sock.write(frame(0, versionMsg));
  mark("-> Version sent");
  sock.write(frame(2, authMsg));
  mark("-> Authenticate sent");
});
sock.setNoDelay(true);

let buf = Buffer.alloc(0);
const counts = new Map();
let synced = false;

sock.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 6) {
    const type = buf.readUInt16BE(0);
    const len = buf.readUInt32BE(2);
    if (buf.length < 6 + len) break;
    const payload = buf.subarray(6, 6 + len);
    buf = buf.subarray(6 + len);
    const name = TYPE[type] ?? `type ${type}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    // The tree and the roster are one line each; a tally follows at the end.
    if (name === "ChannelState" || name === "UserState") {
      if (counts.get(name) === 1) mark(`<- ${name} (first)`);
    } else {
      mark(`<- ${name} (${payload.length} B)`);
    }
    if (name === "ServerSync") synced = true;
  }
});

sock.on("error", (e) => { mark(`error: ${e.message}`); process.exit(1); });
sock.on("close", () => mark("server closed the connection"));

setTimeout(() => {
  mark("--- done ---");
  console.log("counts:", Object.fromEntries(counts));
  console.log(synced ? "ServerSync reached" : "NO ServerSync — the handshake never completed");
  process.exit(0);
}, Number(process.env.PROBE_MS ?? 3000));
