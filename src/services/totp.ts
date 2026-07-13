import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32ToBuffer(base32: string): Buffer {
  base32 = base32.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < base32.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(base32[i]);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function bufferToBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function generateSecret(): string {
  const buffer = crypto.randomBytes(20);
  return bufferToBase32(buffer);
}

export function generateTotpUri(secret: string, label: string, issuer: string): string {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedLabel = encodeURIComponent(label);
  return `otpauth://totp/${encodedIssuer}:${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

export function generateHOTP(secret: string, counter: number, digits: number = 6): string {
  const key = base32ToBuffer(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac("sha1", key);
  hmac.update(counterBuf);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const mod = 10 ** digits;
  const otp = binary % mod;
  return otp.toString().padStart(digits, "0");
}

export function generateTOTP(secret: string, period: number = 30, digits: number = 6): string {
  const counter = Math.floor(Date.now() / 1000 / period);
  return generateHOTP(secret, counter, digits);
}

export function verifyTOTP(secret: string, token: string, window: number = 1, period: number = 30, digits: number = 6): boolean {
  if (token.length !== digits) return false;

  const counter = Math.floor(Date.now() / 1000 / period);

  for (let offset = -window; offset <= window; offset++) {
    const candidate = generateHOTP(secret, counter + offset, digits);
    if (candidate === token) return true;
  }
  return false;
}
