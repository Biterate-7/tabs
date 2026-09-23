import { createHash, randomBytes } from "node:crypto";

/**
 * TabDump MCP access tokens.
 *
 * ## What one is
 *
 * A credential a signed-in TabDump user mints for an MCP client — Claude
 * Desktop, today — so that client can read *their* TabDump context and
 * nothing else. It is TabDump's own token for TabDump's own API:
 *
 *   - not the browser session cookie (HttpOnly, and a cookie that an MCP
 *     client held would also authenticate every write route);
 *   - not an Anthropic API key, and not a Claude.ai or Claude Desktop login —
 *     TabDump never sees, stores or relays those;
 *   - not a deployment-wide operator key. There is no such thing on this path.
 *
 * ## How it is held
 *
 * Shown to the user exactly once, at creation. Stored only as a SHA-256 hash,
 * so a database read yields nothing that authenticates. The schema's CHECK
 * constraint makes that structural: a column that must match 64 hex
 * characters cannot hold a `tdmcp_` token by mistake.
 *
 * SHA-256 rather than a slow password hash is deliberate and standard for
 * this shape of secret: the token is 256 bits of CSPRNG output, so there is
 * no dictionary to grind, and lookup must be by hash to be a single indexed
 * read.
 *
 * ## What one can do
 *
 * `read`, and only `read`. The scope list is closed and has one member; the
 * schema refuses any other value. Every tool behind it is read-only, and the
 * MCP layer has no path to the agent control plane at all (see ./server.ts).
 */

export const MCP_TOKEN_PREFIX = "tdmcp_";

/** base64url of 32 random bytes. */
const TOKEN_BODY_LENGTH = 43;
const TOKEN_PATTERN = new RegExp(`^${MCP_TOKEN_PREFIX}[A-Za-z0-9_-]{${TOKEN_BODY_LENGTH}}$`);

/** A token that nobody used for 90 days is a token nobody remembers issuing. */
export const MCP_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Live tokens per account. One per device is the realistic ceiling; this is generous. */
export const MAX_ACTIVE_MCP_TOKENS = 10;

/** `last_used_at` is refreshed at most this often, so reads do not become writes. */
export const MCP_TOKEN_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const MAX_MCP_TOKEN_NAME_LENGTH = 60;

export type McpTokenScope = "read";
export const MCP_TOKEN_SCOPES: readonly McpTokenScope[] = ["read"] as const;

export type McpTokenRecord = {
  id: string;
  userId: string;
  name: string;
  /** SHA-256 of the token, lowercase hex. Never the token. */
  tokenHash: string;
  /** The last four characters, so a user can tell two tokens apart. */
  hint: string;
  scopes: readonly McpTokenScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

/** What the settings page may see. No hash, no token. */
export type McpTokenView = {
  id: string;
  name: string;
  hint: string;
  scopes: readonly McpTokenScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  revoked: boolean;
};

/**
 * Storage for token records.
 *
 * Every method that names a token by id also names its owner, and the
 * implementations fold the owner into the query. `findByHash` is the one
 * exception, because it is how an owner is *discovered*: the hash is the
 * credential, and possessing the token is the proof.
 */
export type McpTokenStore = {
  create(record: McpTokenRecord): Promise<void>;
  findByHash(tokenHash: string): Promise<McpTokenRecord | undefined>;
  listForUser(userId: string): Promise<McpTokenRecord[]>;
  countActive(userId: string, now: number): Promise<number>;
  revoke(userId: string, tokenId: string, at: number): Promise<boolean>;
  touch(tokenId: string, at: number): Promise<void>;
};

export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedMcpToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function mintMcpToken(): { token: string; tokenHash: string; hint: string } {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashMcpToken(token), hint: token.slice(-4) };
}

function mintTokenId(): string {
  return `mcpt_${randomBytes(12).toString("base64url")}`;
}

/**
 * The bearer token on a request, if it carries one in the only place this
 * API reads it.
 *
 * Header only. A token in a query string ends up in access logs, browser
 * history and referrers; this endpoint does not read one there at all.
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function toMcpTokenView(record: McpTokenRecord): McpTokenView {
  return {
    id: record.id,
    name: record.name,
    hint: record.hint,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
    revoked: record.revokedAt !== undefined,
  };
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters out, whitespace collapsed. A name is a label a user
  // reads in a list; it is never interpreted.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > MAX_MCP_TOKEN_NAME_LENGTH) return null;
  return cleaned;
}

export type IssueMcpTokenResult =
  | { ok: true; token: string; view: McpTokenView }
  | { ok: false; reason: "invalid-name" | "too-many-tokens" };

export async function issueMcpToken(
  store: McpTokenStore,
  input: { userId: string; name: unknown; now: number }
): Promise<IssueMcpTokenResult> {
  const name = cleanName(input.name);
  if (!name) return { ok: false, reason: "invalid-name" };

  if ((await store.countActive(input.userId, input.now)) >= MAX_ACTIVE_MCP_TOKENS) {
    return { ok: false, reason: "too-many-tokens" };
  }

  const minted = mintMcpToken();
  const record: McpTokenRecord = {
    id: mintTokenId(),
    userId: input.userId,
    name,
    tokenHash: minted.tokenHash,
    hint: minted.hint,
    scopes: [...MCP_TOKEN_SCOPES],
    createdAt: input.now,
    expiresAt: input.now + MCP_TOKEN_TTL_MS,
  };
  await store.create(record);

  // The only time the token exists outside the caller's own hands.
  return { ok: true, token: minted.token, view: toMcpTokenView(record) };
}

export type McpAuthFailure = "missing" | "malformed" | "unknown" | "revoked" | "expired";

export type McpAuthResult =
  | { ok: true; userId: string; tokenId: string; scopes: readonly McpTokenScope[] }
  | { ok: false; reason: McpAuthFailure };

export async function authenticateMcpToken(
  store: McpTokenStore,
  presented: string | null,
  now: number
): Promise<McpAuthResult> {
  if (presented === null) return { ok: false, reason: "missing" };
  // Refused before any lookup, so a garbage header costs no database read.
  if (!isWellFormedMcpToken(presented)) return { ok: false, reason: "malformed" };

  const record = await store.findByHash(hashMcpToken(presented));
  if (!record) return { ok: false, reason: "unknown" };
  if (record.revokedAt !== undefined) return { ok: false, reason: "revoked" };
  if (record.expiresAt <= now) return { ok: false, reason: "expired" };

  if (record.lastUsedAt === undefined || now - record.lastUsedAt >= MCP_TOKEN_TOUCH_INTERVAL_MS) {
    // Best effort. A failed bookkeeping write must not turn a valid read
    // into a refusal.
    await store.touch(record.id, now).catch(() => {});
  }

  return { ok: true, userId: record.userId, tokenId: record.id, scopes: record.scopes };
}

/** An in-memory store, for tests and for a deployment with no database (where the MCP route refuses anyway). */
export function createMemoryMcpTokenStore(): McpTokenStore & { records: McpTokenRecord[] } {
  const records: McpTokenRecord[] = [];
  const isActive = (record: McpTokenRecord, now: number) =>
    record.revokedAt === undefined && record.expiresAt > now;

  return {
    records,
    async create(record) {
      if (records.some((existing) => existing.tokenHash === record.tokenHash)) {
        throw new Error("duplicate token hash");
      }
      records.push({ ...record, scopes: [...record.scopes] });
    },
    async findByHash(tokenHash) {
      const found = records.find((record) => record.tokenHash === tokenHash);
      return found ? { ...found } : undefined;
    },
    async listForUser(userId) {
      return records
        .filter((record) => record.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((record) => ({ ...record }));
    },
    async countActive(userId, now) {
      return records.filter((record) => record.userId === userId && isActive(record, now)).length;
    },
    async revoke(userId, tokenId, at) {
      const found = records.find((record) => record.id === tokenId && record.userId === userId);
      if (!found || found.revokedAt !== undefined) return false;
      found.revokedAt = at;
      return true;
    },
    async touch(tokenId, at) {
      const found = records.find((record) => record.id === tokenId);
      if (found) found.lastUsedAt = at;
    },
  };
}
