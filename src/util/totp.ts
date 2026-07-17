import { createHmac } from "node:crypto";

/**
 * Minimal RFC 6238 TOTP generator (HMAC-SHA1, 30 s period, 6 digits) matching
 * the server's `Totp` helper. Used by the account-settings e2e to act as the
 * "authenticator app" during 2FA enrolment and login.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an RFC 3548 base32 string (padding / spaces ignored). */
export function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let buffer = 0;
  const out: number[] = [];
  for (const raw of encoded.toUpperCase()) {
    if (raw === "=" || raw === " " || raw === "-") continue;
    const idx = BASE32_ALPHABET.indexOf(raw);
    if (idx < 0) throw new Error(`invalid base32 character: ${raw}`);
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** The 6-digit TOTP code for `secretBase32` at `unixTime` (default: now). */
export function totpCode(secretBase32: string, unixTime = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(unixTime / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const value =
    ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(value % 1_000_000).padStart(6, "0");
}
