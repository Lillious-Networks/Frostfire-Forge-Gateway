import crypto from "crypto";

export async function hash(password: string) {
  return await Bun.password.hash(password);
}

export async function verify(password: string, hash: string) {
  return await Bun.password.verify(password, hash);
}

// Guest accounts use throwaway random credentials that are never used to log
// in, so Argon2 (Bun.password.hash/verify) is pure wasted CPU at benchmark
// scale - it pins a core during login ramps. Store a sha256 with a marker
// prefix instead; login verification detects the prefix and compares hashes.
export function hashGuestPassword(password: string) {
  return `guest:${crypto.createHash("sha256").update(password).digest("hex")}`;
}

export function verifyGuestPassword(password: string, stored: string) {
  return stored === `guest:${crypto.createHash("sha256").update(password).digest("hex")}`;
}

export function getHash(password: string) {
  const hash = crypto.createHash("sha512").update(password).digest("hex");
  const numberValue = Object.assign([], Array.from(hash.replace(/[a-z]/g, "")));
  const sum = numberValue.reduce(
    (acc: number, _curr: string, i: number) => acc + i,
    0
  );
  return [hash, numberValue, sum];
}

export function createSecureToken() {
  const token = randomBytes(32);
  return {hash: hash(token), value: token};
}

export function verifySecureToken(token: string, hash: string) {
  return Bun.password.verify(token, hash);
}

export function randomBytes(size: number) {
  return crypto.randomBytes(size).toString("hex");
}