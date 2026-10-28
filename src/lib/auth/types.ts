/**
 * The account model Hubble owns. Google is only ever the identity
 * *provider* here — every user record, session, and authorization decision
 * below belongs to this app, so swapping or adding a second provider later
 * would touch `googleSub` and nothing else.
 *
 * Types only (no "use server"/"server-only", no runtime imports) so the
 * client-side auth state in src/components/auth/ can share `PublicUser`
 * with the route handlers that produce it.
 */

/** A Hubble account. `googleSub` is the join key to the identity provider — never the email (see the note on `email`). */
export type AuthUser = {
  /** Hubble's own id (a UUID). This — never `googleSub` — is what the rest of the app scopes data by. */
  id: string;
  /**
   * Google's `sub` claim: stable for the life of the Google account and
   * never reused, which is exactly why it (and not the email) is the
   * provider identity key. A Google account's email can change; its `sub`
   * cannot.
   */
  googleSub: string;
  /**
   * Last-seen verified email. Stored for display/support only — it is
   * deliberately NOT unique and never used to look an account up, so a user
   * who changes their Google email keeps the same Hubble account, and
   * someone who later acquires a recycled address can never inherit one.
   */
  email: string;
  name: string;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * A server-side session. The browser only ever holds the raw token (in an
 * HttpOnly cookie); this record stores `tokenHash`, so a leaked copy of the
 * session table can't be replayed as a login.
 */
export type AuthSession = {
  id: string;
  userId: string;
  /** SHA-256 of the raw token — see hashSessionToken in ./tokens.ts for why an unsalted hash is right here. */
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
};

/**
 * A device credential: what Hubble Desktop holds instead of a web session.
 *
 * Its own row and its own token type, never a web session cookie (see
 * docs/auth-architecture.md, "pairing flow"): signing out of the website
 * leaves Hubble Desktop signed in, and disconnecting Hubble Desktop leaves
 * the website signed in.
 *
 * One row has two lives. A signed-in web session creates it *pending*
 * (`codeHash` set, `tokenHash` null): a single-use pairing code bound to the
 * user and to the desktop's PKCE challenge. It is redeemed exactly once into
 * a *live* credential (`codeHash` null, `tokenHash` set). As with sessions,
 * only hashes are stored.
 */
export type DeviceSession = {
  id: string;
  userId: string;
  /** SHA-256 of the pairing code, until it is redeemed. */
  codeHash: string | null;
  /** base64url(SHA-256(verifier)) the desktop sent when it asked to pair (RFC 7636 S256). */
  codeChallenge: string;
  /** SHA-256 of the device token, once redeemed. */
  tokenHash: string | null;
  /** What the person sees in the list of connected desktops ("Hubble Desktop on LAPTOP-7"). */
  label: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
};

/** Everything the browser is ever told about the signed-in user. No session token, no `googleSub`, no internal timestamps. */
export type PublicUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
};

export function toPublicUser(user: AuthUser): PublicUser {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl };
}

/** The verified profile fields lifted off a Google ID token, after ./google.ts has checked its signature and claims. */
export type GoogleIdentity = {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl: string | null;
};

/**
 * The only persistence surface the auth system talks to. Two
 * implementations ship (see ./store/): a Postgres one for real deployments,
 * and an in-memory one for local development. Keeping this an interface is
 * what lets Hubble own its account system without also committing the
 * whole app to one database — nothing outside src/lib/auth/store/ knows
 * which is in play.
 *
 * Every method is async because the Postgres implementation is; the memory
 * one just resolves immediately.
 */
export interface AuthStore {
  /** Human-readable id for diagnostics/logging (`"postgres"`, `"memory"`). Never contains a connection string. */
  readonly kind: string;
  /** True when this store survives a process restart. False for the memory store, which is why it is refused in production. */
  readonly durable: boolean;

  findUserByGoogleSub(googleSub: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  /**
   * Inserts a new account. Implementations MUST enforce uniqueness on
   * `googleSub` at the storage layer (not just by checking first) so two
   * concurrent first-time logins for the same Google account can't both
   * win — see the ON CONFLICT handling in findOrCreateUser.
   */
  createUser(input: Omit<AuthUser, "createdAt" | "updatedAt">): Promise<AuthUser>;
  /** Refreshes the profile fields Google re-asserts on every login. Never touches `id` or `googleSub`. */
  updateUserProfile(id: string, profile: Pick<AuthUser, "email" | "name" | "avatarUrl">): Promise<AuthUser>;

  createSession(session: AuthSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null>;
  /**
   * Best-effort `lastUsedAt` bump, optionally extending `expiresAt` at the
   * same time (the sliding-window renewal in ./session.ts). Failures here
   * must never fail the request that triggered them.
   */
  touchSession(id: string, lastUsedAt: number, expiresAt?: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Signs the user out everywhere — the hook a future "sign out of all devices" / account-deletion flow needs. */
  deleteSessionsForUser(userId: string): Promise<void>;
  /** Housekeeping for expired rows. Called opportunistically, never on the hot path. */
  deleteExpiredSessions(now: number): Promise<void>;

  // ---- Device credentials (Hubble Desktop). See DeviceSession and ../device.ts.

  createDevicePairing(pairing: DeviceSession): Promise<void>;
  /** A still-pending pairing, by its code's hash. */
  findDevicePairingByCodeHash(codeHash: string): Promise<DeviceSession | null>;
  /**
   * Turns a pending pairing into a live credential, atomically: it succeeds
   * only while the row still carries `codeHash`, so of two concurrent
   * redemptions of one code exactly one wins. Null when already redeemed or gone.
   */
  redeemDevicePairing(id: string, codeHash: string, tokenHash: string, expiresAt: number, now: number): Promise<DeviceSession | null>;
  /** A live (redeemed) credential, by its token's hash. */
  findDeviceSessionByTokenHash(tokenHash: string): Promise<DeviceSession | null>;
  touchDeviceSession(id: string, lastUsedAt: number, expiresAt?: number): Promise<void>;
  deleteDeviceSession(id: string): Promise<void>;
  /** An account's live credentials, newest first. Pending pairings are not listed. */
  listDeviceSessions(userId: string): Promise<DeviceSession[]>;
}
