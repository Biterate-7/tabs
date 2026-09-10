import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * 32 bytes = 256 bits of entropy from the OS CSPRNG. `Math.random()` would
 * be catastrophic here (it is a seeded PRNG whose internal state is
 * recoverable from a handful of outputs, so one observed session token
 * would leak every other token the same process ever issues) — this module
 * exists so no call site is ever tempted to reach for it.
 */
const TOKEN_BYTES = 32;

/** A fresh, unguessable raw session token. Handed to the browser as a cookie value and never stored anywhere server-side — only its hash is (see hashSessionToken). */
export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** A fresh single-use login nonce, from the same CSPRNG as a session token — see ./nonce.ts for what it binds together. */
export function createNonce(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * SHA-256, unsalted and uniterated — deliberately, and unlike a password.
 *
 * Salting and key stretching exist to defend *low-entropy* secrets against
 * offline guessing. A session token from createSessionToken() has 256 bits
 * of uniform entropy, so there is nothing to guess: brute-forcing it is
 * infeasible regardless of how fast the hash is. What the hash buys is that
 * a dump of the sessions table (a leaked backup, a SQL-injection read, an
 * over-broad log) contains no value that can be replayed as a login. A
 * per-row salt would also break the whole point of storing it — the lookup
 * is BY hash, which requires it to be deterministic.
 */
export function hashSessionToken(token: string): string {
  return sha256Hex(token);
}

/** Same reasoning as hashSessionToken — the nonce is high-entropy, so an unsalted digest is exactly right, and hashing is what keeps the value stored in the browser's nonce cookie from being replayable on its own. */
export function hashNonce(nonce: string): string {
  return sha256Hex(nonce);
}

/** Ids for user and session rows. UUIDv4 rather than lib/id.ts's counter+timestamp scheme, which resets per process and so can collide across serverless instances. */
export function createRecordId(): string {
  return randomUUID();
}

/**
 * Constant-time string comparison for secrets. Used for the login-nonce
 * check, where a timing side channel would otherwise leak the expected
 * value one byte at a time. Length is compared first and non-constant-time
 * (the length of a secret is not itself the secret, and hashing to a fixed
 * width upstream means a mismatched length only ever means "malformed").
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
