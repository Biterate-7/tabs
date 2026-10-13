import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CredentialKind } from "./records";

/**
 * Hubble's integration secrets: how they are minted, recognised and held.
 *
 * Every secret is 256 bits of CSPRNG output behind a fixed prefix, and only
 * its SHA-256 is ever stored — so a database read yields nothing that
 * authenticates, and lookup is one indexed read. A slow password hash would
 * add nothing: there is no dictionary to grind for a random 256-bit value.
 *
 * The prefixes are part of the format, not decoration. A request's token is
 * matched against its kind's exact pattern *before* any lookup, so a garbage
 * header costs no database read, and a secret pasted into the wrong place
 * (an authorization code used as a bearer token, say) is refused for its
 * shape alone.
 */

export const CREDENTIAL_PREFIX: Record<CredentialKind, string> = {
  access: "hbat_",
  refresh: "hbrt_",
  personal: "hbpat_",
  test: "hbtest_",
};

export const AUTHORIZATION_CODE_PREFIX = "hbcode_";
export const CLIENT_SECRET_PREFIX = "hbcs_";
export const CLIENT_ID_PREFIX = "hbcl_";

/** base64url of 32 random bytes. */
const BODY = "[A-Za-z0-9_-]{43}";

const PATTERNS: Record<CredentialKind, RegExp> = {
  access: new RegExp(`^hbat_${BODY}$`),
  refresh: new RegExp(`^hbrt_${BODY}$`),
  personal: new RegExp(`^hbpat_${BODY}$`),
  test: new RegExp(`^hbtest_${BODY}$`),
};

const CODE_PATTERN = new RegExp(`^${AUTHORIZATION_CODE_PREFIX}${BODY}$`);
const CLIENT_SECRET_PATTERN = new RegExp(`^${CLIENT_SECRET_PREFIX}${BODY}$`);
export const CLIENT_ID_PATTERN = /^hbcl_[A-Za-z0-9_-]{22}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function mintCredential(kind: CredentialKind): { token: string; tokenHash: string; hint: string } {
  const token = secret(CREDENTIAL_PREFIX[kind]);
  return { token, tokenHash: sha256Hex(token), hint: token.slice(-4) };
}

/** Which kind of bearer credential a value is shaped as, if any. */
export function credentialKindOf(value: string): CredentialKind | undefined {
  for (const kind of Object.keys(PATTERNS) as CredentialKind[]) if (PATTERNS[kind].test(value)) return kind;
  return undefined;
}

export function mintAuthorizationCode(): { code: string; codeHash: string } {
  const code = secret(AUTHORIZATION_CODE_PREFIX);
  return { code, codeHash: sha256Hex(code) };
}

export function isWellFormedAuthorizationCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

export function mintClientSecret(): { secret: string; secretHash: string } {
  const value = secret(CLIENT_SECRET_PREFIX);
  return { secret: value, secretHash: sha256Hex(value) };
}

export function isWellFormedClientSecret(value: unknown): value is string {
  return typeof value === "string" && CLIENT_SECRET_PATTERN.test(value);
}

export function mintClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(16).toString("base64url")}`;
}

export function mintRecordId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** Constant-time comparison of two hex digests of equal length. */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** PKCE S256: base64url(SHA-256(verifier)), compared in constant time. RFC 7636 §4.6. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  // RFC 7636 §4.1: 43–128 characters of the unreserved set.
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  if (computed.length !== challenge.length) return false;
  return timingSafeEqual(Buffer.from(computed, "ascii"), Buffer.from(challenge, "ascii"));
}

/** Lifetimes. An access token is an hour; a refresh token keeps a connection alive while it is used. */
export const CREDENTIAL_TTL_MS: Record<CredentialKind, number> = {
  access: 60 * 60 * 1000,
  refresh: 30 * 24 * 60 * 60 * 1000,
  personal: 90 * 24 * 60 * 60 * 1000,
  test: 2 * 60 * 1000,
};

export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
