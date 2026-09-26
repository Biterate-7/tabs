import { isAgentProviderId } from "@/lib/agents/connectors/types";
import { isProviderAuthMethod, isProviderConnectionStatus } from "./types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentProviderConnection, ProviderConnectionStatus } from "./types";

/**
 * Where provider connections are recorded.
 *
 * ## Ownership is in the signature, not in a check
 *
 * Every method takes an `ownerId` as its first argument, and every
 * implementation folds it into the predicate rather than fetching a row and
 * comparing afterwards. `find(id)` — the shape that invites a forgotten check
 * at a new call site — does not exist on this interface at all.
 *
 * That is the same discipline `remote/store.ts` follows for projects, and it
 * is what makes §13's "User A must never retrieve User B's connection" a
 * property of the type rather than a rule somebody has to remember. A caller
 * who does not know whose connection they are asking for cannot ask.
 *
 * ## One connection per provider per user
 *
 * Enforced by `upsert` rather than by letting callers create freely. Two
 * Anthropic keys for one person is a real thing to want eventually, but it
 * turns every "is Claude connected?" question into "which one?", and every
 * session-start into a picker. This phase answers the question once; the
 * uniqueness constraint is the thing a later phase would relax, and relaxing a
 * constraint is safe in a way that adding one is not.
 */

/** What a caller supplies to create or replace a connection. No secret: that goes to the secret store. */
export type ConnectionUpsert = {
  id: string;
  ownerId: string;
  provider: AgentProviderId;
  authMethod: AgentProviderConnection["authMethod"];
  displayName: string;
  status: ProviderConnectionStatus;
  createdAt: number;
  updatedAt: number;
  lastValidatedAt?: number;
  lastFailureCode?: AgentProviderConnection["lastFailureCode"];
};

/** The fields a later validation, rotation or revocation may move. */
export type ConnectionPatch = {
  displayName?: string;
  status?: ProviderConnectionStatus;
  lastValidatedAt?: number;
  /** `null` clears it — a connection that has just validated has no failure. */
  lastFailureCode?: AgentProviderConnection["lastFailureCode"] | null;
};

export type ConnectionStore = {
  /** Every connection this owner holds. Never anybody else's, at any argument. */
  list(ownerId: string): Promise<AgentProviderConnection[]>;
  /** One connection by id, scoped. Resolves to `undefined` for another owner's id. */
  find(ownerId: string, connectionId: string): Promise<AgentProviderConnection | undefined>;
  /** This owner's connection for a provider, if any. The session-start lookup. */
  findByProvider(
    ownerId: string,
    provider: AgentProviderId
  ): Promise<AgentProviderConnection | undefined>;
  /** Creates, or replaces this owner's existing connection for the same provider. */
  upsert(connection: ConnectionUpsert): Promise<AgentProviderConnection>;
  /** Moves the mutable fields. Returns `undefined` if the connection is not this owner's. */
  update(
    ownerId: string,
    connectionId: string,
    patch: ConnectionPatch,
    at: number
  ): Promise<AgentProviderConnection | undefined>;
  /** Removes the row. Returns whether one was removed, so a route can answer 404 honestly. */
  remove(ownerId: string, connectionId: string): Promise<boolean>;
};

/* ------------------------------------------------------------------ *
 * In-memory
 * ------------------------------------------------------------------ */

/**
 * Connections in process memory.
 *
 * The development and test implementation, mirroring `auth/store/memory.ts`.
 * It enforces every rule the Postgres one does — owner scoping, one connection
 * per provider per owner — because a memory store that was more permissive
 * would let tests pass against behaviour production does not have.
 */
export function createMemoryConnectionStore(): ConnectionStore {
  const rows = new Map<string, AgentProviderConnection>();

  const ownedBy = (ownerId: string) =>
    [...rows.values()].filter((row) => row.ownerId === ownerId);

  return {
    async list(ownerId) {
      return ownedBy(ownerId).sort((a, b) => b.createdAt - a.createdAt);
    },

    async find(ownerId, connectionId) {
      const row = rows.get(connectionId);
      return row && row.ownerId === ownerId ? { ...row } : undefined;
    },

    async findByProvider(ownerId, provider) {
      const row = ownedBy(ownerId).find((candidate) => candidate.provider === provider);
      return row ? { ...row } : undefined;
    },

    async upsert(input) {
      // Replace this owner's existing connection for the provider, keeping the
      // caller's id. The old row's id disappearing is intentional: the caller
      // decides whether a rotation preserves identity (it does) or a fresh
      // connect mints a new one (it does).
      for (const row of ownedBy(input.ownerId)) {
        if (row.provider === input.provider && row.id !== input.id) rows.delete(row.id);
      }

      const connection: AgentProviderConnection = {
        id: input.id,
        ownerId: input.ownerId,
        provider: input.provider,
        authMethod: input.authMethod,
        displayName: input.displayName,
        status: input.status,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        ...(input.lastValidatedAt !== undefined ? { lastValidatedAt: input.lastValidatedAt } : {}),
        ...(input.lastFailureCode !== undefined ? { lastFailureCode: input.lastFailureCode } : {}),
      };

      rows.set(connection.id, connection);
      return { ...connection };
    },

    async update(ownerId, connectionId, patch, at) {
      const row = rows.get(connectionId);
      if (!row || row.ownerId !== ownerId) return undefined;

      const next: AgentProviderConnection = { ...row, updatedAt: at };
      if (patch.displayName !== undefined) next.displayName = patch.displayName;
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.lastValidatedAt !== undefined) next.lastValidatedAt = patch.lastValidatedAt;
      if (patch.lastFailureCode === null) delete next.lastFailureCode;
      else if (patch.lastFailureCode !== undefined) next.lastFailureCode = patch.lastFailureCode;

      rows.set(connectionId, next);
      return { ...next };
    },

    async remove(ownerId, connectionId) {
      const row = rows.get(connectionId);
      if (!row || row.ownerId !== ownerId) return false;
      rows.delete(connectionId);
      return true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Row reading
 * ------------------------------------------------------------------ */

/**
 * Reads a persisted row into the domain type, refusing anything it cannot read.
 *
 * Shared by the Postgres store. A row whose provider, auth method or status is
 * not one this build knows about is dropped rather than coerced: a connection
 * Hubble cannot describe is one it must not offer to start a session with,
 * and a default would silently make it usable.
 */
export function readConnectionRow(row: {
  id: unknown;
  owner_id: unknown;
  provider: unknown;
  auth_method: unknown;
  display_name: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  last_validated_at: unknown;
  last_failure_code: unknown;
}): AgentProviderConnection | undefined {
  if (typeof row.id !== "string" || typeof row.owner_id !== "string") return undefined;
  if (!isAgentProviderId(row.provider)) return undefined;
  if (!isProviderAuthMethod(row.auth_method)) return undefined;
  if (!isProviderConnectionStatus(row.status)) return undefined;

  const connection: AgentProviderConnection = {
    id: row.id,
    ownerId: row.owner_id,
    provider: row.provider,
    authMethod: row.auth_method,
    displayName: typeof row.display_name === "string" ? row.display_name : "",
    status: row.status,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };

  if (row.last_validated_at !== null && row.last_validated_at !== undefined) {
    connection.lastValidatedAt = toMillis(row.last_validated_at);
  }
  // A failure code this build does not recognise is dropped rather than
  // carried: it would render as an empty sentence, which is worse than the
  // absence the UI already handles.
  if (typeof row.last_failure_code === "string") {
    const code = row.last_failure_code;
    if (KNOWN_FAILURE_CODES.has(code)) {
      connection.lastFailureCode = code as AgentProviderConnection["lastFailureCode"];
    }
  }

  return connection;
}

const KNOWN_FAILURE_CODES = new Set([
  "connection_valid",
  "invalid_credentials",
  "malformed_credential",
  "provider_unavailable",
  "rate_limited",
  "validation_failed",
]);

/** Epoch-ms BIGINTs come back from `pg` as strings. Lossless for every value this schema holds. */
function toMillis(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}
