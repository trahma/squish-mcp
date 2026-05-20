import { randomBytes } from "node:crypto";

// Crockford base32 (no I, L, O, U) — same alphabet as ULID.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A short, lexicographically-sortable ULID-style ID: 10 chars of timestamp
 * (48-bit ms) + 16 chars of randomness = 26 chars total. Sorts by creation
 * time, collision-resistant, URL-safe. No external dependency.
 */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }

  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += ALPHABET[bytes[i]! % 32];
  }

  return time + rand;
}
