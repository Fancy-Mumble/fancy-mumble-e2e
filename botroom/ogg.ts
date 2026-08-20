/**
 * Ogg Opus, written: the container the bots' *listening* side needs.
 *
 * `speech.ts` reads Ogg that ffmpeg produced a moment ago and ignores every
 * checksum. This is the other direction: Opus packets picked off the Mumble
 * tunnel — a person talking in the channel — have to be handed to a speech
 * recogniser, and neither Whisper's web service nor the ffmpeg in front of it
 * accepts bare packets. So they are wrapped in the smallest correct Ogg Opus
 * stream that exists, and this time the CRC is real: libavformat drops a page
 * whose checksum does not match, and a recogniser fed only the pages that
 * happened to survive returns fragments and confidence.
 */

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, no init, no final xor. */
const CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = ((r & 0x80000000) !== 0 ? (r << 1) ^ 0x04c11db7 : r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
})();

function crc32(page: Buffer): number {
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}

/**
 * How many 48 kHz samples one Opus packet carries, from its TOC byte.
 *
 * Needed for the granule positions, which Ogg Opus requires to be honest.
 * Mumble clients send 10, 20, 40 or 60 ms frames and may pack several into one
 * packet, so this reads the frame duration table and the frame count rather
 * than assuming twenty milliseconds. RFC 6716 §3.1.
 */
export function opusPacketSamples(packet: Buffer): number {
  if (packet.length === 0) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  const code = toc & 0x03;
  let frameSamples: number;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frameSamples = [480, 960][config & 1];
  else frameSamples = [120, 240, 480, 960][config & 3];
  let frames: number;
  if (code === 0) frames = 1;
  else if (code < 3) frames = 2;
  else frames = packet.length > 1 ? packet[1] & 0x3f : 1;
  return frameSamples * frames;
}

const OPUS_RATE = 48_000;
/** libopus encoders put 3840 samples of pre-skip in the header; decoders trim it. */
const PRE_SKIP = 3840;

/** One Ogg Opus stream, mono, from packets in order. */
export function oggOpus(packets: Buffer[]): Buffer {
  const serial = (Math.random() * 0x7fffffff) >>> 0;
  let pageNo = 0;
  const pages: Buffer[] = [];

  const page = (segments: Buffer[], granule: bigint, flags: number): void => {
    // Lacing: each packet is 255-byte segments ending in one shorter than 255.
    const lacing: number[] = [];
    for (const segment of segments) {
      let rest = segment.length;
      while (rest >= 255) {
        lacing.push(255);
        rest -= 255;
      }
      lacing.push(rest);
    }
    const header = Buffer.alloc(27 + lacing.length);
    header.write("OggS", 0, "latin1");
    header[4] = 0; // stream structure version
    header[5] = flags;
    header.writeBigInt64LE(granule, 6);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(pageNo++, 18);
    header.writeUInt32LE(0, 22); // CRC placeholder
    header[26] = lacing.length;
    for (let i = 0; i < lacing.length; i++) header[27 + i] = lacing[i];
    const whole = Buffer.concat([header, ...segments]);
    whole.writeUInt32LE(crc32(whole), 22);
    pages.push(whole);
  };

  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1; // version
  head[9] = 1; // channels
  head.writeUInt16LE(PRE_SKIP, 10);
  head.writeUInt32LE(OPUS_RATE, 12);
  head.writeInt16LE(0, 16); // output gain
  head[18] = 0; // channel mapping family
  page([head], 0n, 0x02); // BOS

  const vendor = Buffer.from("botroom", "utf8");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, "latin1");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length); // no comments
  page([tags], 0n, 0);

  // Audio: a page every so many packets. Ogg allows up to 255 segments a page;
  // fifty packets is a second of speech and keeps every page well inside that
  // even for packets that need several segments.
  let granule = 0n;
  for (let at = 0; at < packets.length; at += 50) {
    const slice = packets.slice(at, at + 50);
    for (const packet of slice) granule += BigInt(opusPacketSamples(packet));
    const last = at + 50 >= packets.length;
    page(slice, granule, last ? 0x04 : 0); // EOS on the last
  }
  if (packets.length === 0) page([], 0n, 0x04);

  return Buffer.concat(pages);
}
