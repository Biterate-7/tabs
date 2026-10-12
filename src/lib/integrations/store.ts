import type {
  ActivityRecord,
  AuthorizationCodeRecord,
  ConnectionRecord,
  CredentialRecord,
  IdempotencyRecord,
  OAuthClientRecord,
  ProjectContextRecord,
  ProposalRecord,
  ProposalStatus,
  WorkspaceNoteRecord,
} from "./records";
import type { HubbleScope } from "./scopes";

/**
 * Where the integration layer keeps its records.
 *
 * The same shape every durable Hubble store has (mcp/tokens.ts,
 * remote/store.ts, activity/history-store.ts): an interface, an in-memory
 * implementation for tests, and a Postgres one (./store-postgres.ts) on the
 * deployment's shared pool.
 *
 * ## Ownership is a predicate, not a check
 *
 * Every method that names a record a person owns also names the person, and
 * implementations fold the owner into the lookup. Another account's id
 * answers exactly as an id that does not exist. The exceptions are the
 * lookups by credential hash and authorization code hash, which is how an
 * owner is *discovered*: possessing the secret is the proof.
 *
 * ## State changes are compare-and-set
 *
 * Consuming a code, rotating a refresh token and moving a proposal between
 * statuses each succeed for exactly one caller. Two concurrent requests
 * cannot both redeem one code or both apply one proposal.
 */
export type IntegrationStore = {
  createConnection(record: ConnectionRecord): Promise<void>;
  getConnection(userId: string, connectionId: string): Promise<ConnectionRecord | undefined>;
  listConnections(userId: string): Promise<ConnectionRecord[]>;
  countActiveConnections(userId: string): Promise<number>;
  updateConnection(
    userId: string,
    connectionId: string,
    patch: { scopes?: HubbleScope[]; workspaceIds?: string[]; label?: string },
    at: number
  ): Promise<ConnectionRecord | undefined>;
  /** Revokes the connection and every credential under it. False when there was nothing live to revoke. */
  revokeConnection(userId: string, connectionId: string, at: number): Promise<boolean>;
  touchConnection(connectionId: string, at: number): Promise<void>;

  createCredential(record: CredentialRecord): Promise<void>;
  findCredential(tokenHash: string): Promise<{ credential: CredentialRecord; connection: ConnectionRecord } | undefined>;
  listCredentials(userId: string, connectionId: string): Promise<CredentialRecord[]>;
  /** Marks a refresh token exchanged. True for exactly one caller. */
  markCredentialUsed(credentialId: string, at: number): Promise<boolean>;
  revokeCredential(credentialId: string, at: number): Promise<void>;
  touchCredential(credentialId: string, at: number): Promise<void>;

  createOAuthClient(record: OAuthClientRecord): Promise<void>;
  getOAuthClient(clientId: string): Promise<OAuthClientRecord | undefined>;

  createAuthorizationCode(record: AuthorizationCodeRecord): Promise<void>;
  /** Marks the code used. `alreadyUsed` when it was redeemed before — a replay. */
  consumeAuthorizationCode(
    codeHash: string,
    at: number
  ): Promise<{ record: AuthorizationCodeRecord; alreadyUsed: boolean } | undefined>;
  setAuthorizationCodeConnection(codeHash: string, connectionId: string): Promise<void>;

  createProposal(record: ProposalRecord): Promise<void>;
  getProposal(userId: string, proposalId: string): Promise<ProposalRecord | undefined>;
  listProposals(userId: string, options: { statuses?: readonly ProposalStatus[]; limit: number }): Promise<ProposalRecord[]>;
  /** Moves a proposal from one of `from` to `to`. Undefined when it was not in one of `from` (someone else moved it first). */
  transitionProposal(
    userId: string,
    proposalId: string,
    from: readonly ProposalStatus[],
    to: ProposalStatus,
    patch: Partial<Pick<ProposalRecord, "decidedAt" | "appliedAt" | "result" | "failure">>
  ): Promise<ProposalRecord | undefined>;

  appendActivity(record: ActivityRecord): Promise<void>;
  listActivity(
    userId: string,
    options: { workspaceId?: string; connectionId?: string; before?: number; limit: number }
  ): Promise<ActivityRecord[]>;
  pruneActivity(userId: string, olderThan: number): Promise<void>;

  getIdempotent(connectionId: string, key: string): Promise<IdempotencyRecord | undefined>;
  /** Stores a result unless one is already stored for the key; returns whichever is stored. */
  putIdempotent(record: IdempotencyRecord): Promise<IdempotencyRecord>;

  getProjectContext(userId: string, workspaceId: string): Promise<ProjectContextRecord | undefined>;
  /** Writes the record if the stored revision is `expectedRevision` (`null`: none stored yet). */
  putProjectContext(record: ProjectContextRecord, expectedRevision: number | null): Promise<"ok" | "conflict">;
  deleteProjectContext(userId: string, workspaceId: string): Promise<boolean>;

  /** Adds a note, or returns the existing one with the same content hash in that workspace. */
  addNote(record: WorkspaceNoteRecord): Promise<{ note: WorkspaceNoteRecord; created: boolean }>;
  listNotes(userId: string, workspaceId: string, options: { offset: number; limit: number }): Promise<{ notes: WorkspaceNoteRecord[]; total: number }>;
  deleteNote(userId: string, noteId: string): Promise<boolean>;
};

const clone = <T>(value: T): T => structuredClone(value);

/** An in-memory store for tests. Never a production fallback: no database means no integrations, reported as such. */
export function createMemoryIntegrationStore(): IntegrationStore & {
  connections: ConnectionRecord[];
  credentials: CredentialRecord[];
  activity: ActivityRecord[];
  proposals: ProposalRecord[];
} {
  const connections: ConnectionRecord[] = [];
  const credentials: CredentialRecord[] = [];
  const clients: OAuthClientRecord[] = [];
  const codes: AuthorizationCodeRecord[] = [];
  const proposals: ProposalRecord[] = [];
  const activity: ActivityRecord[] = [];
  const idempotency: IdempotencyRecord[] = [];
  const contexts: ProjectContextRecord[] = [];
  const notes: WorkspaceNoteRecord[] = [];

  const ownConnection = (userId: string, id: string) => connections.find((c) => c.id === id && c.userId === userId);

  return {
    connections,
    credentials,
    activity,
    proposals,

    async createConnection(record) {
      connections.push(clone(record));
    },
    async getConnection(userId, id) {
      const found = ownConnection(userId, id);
      return found ? clone(found) : undefined;
    },
    async listConnections(userId) {
      return connections.filter((c) => c.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map(clone);
    },
    async countActiveConnections(userId) {
      return connections.filter((c) => c.userId === userId && c.revokedAt === undefined).length;
    },
    async updateConnection(userId, id, patch, at) {
      const found = ownConnection(userId, id);
      if (!found || found.revokedAt !== undefined) return undefined;
      if (patch.scopes) found.scopes = [...patch.scopes];
      if (patch.workspaceIds) found.workspaceIds = [...patch.workspaceIds];
      if (patch.label) found.label = patch.label;
      found.updatedAt = at;
      return clone(found);
    },
    async revokeConnection(userId, id, at) {
      const found = ownConnection(userId, id);
      if (!found || found.revokedAt !== undefined) return false;
      found.revokedAt = at;
      for (const credential of credentials) {
        if (credential.connectionId === id && credential.revokedAt === undefined) credential.revokedAt = at;
      }
      return true;
    },
    async touchConnection(id, at) {
      const found = connections.find((c) => c.id === id);
      if (found) found.lastUsedAt = at;
    },

    async createCredential(record) {
      if (credentials.some((c) => c.tokenHash === record.tokenHash)) throw new Error("duplicate credential hash");
      credentials.push(clone(record));
    },
    async findCredential(tokenHash) {
      const credential = credentials.find((c) => c.tokenHash === tokenHash);
      if (!credential) return undefined;
      const connection = connections.find((c) => c.id === credential.connectionId);
      if (!connection) return undefined;
      return { credential: clone(credential), connection: clone(connection) };
    },
    async listCredentials(userId, connectionId) {
      if (!ownConnection(userId, connectionId)) return [];
      return credentials.filter((c) => c.connectionId === connectionId).map(clone);
    },
    async markCredentialUsed(id, at) {
      const found = credentials.find((c) => c.id === id);
      if (!found || found.usedAt !== undefined) return false;
      found.usedAt = at;
      return true;
    },
    async revokeCredential(id, at) {
      const found = credentials.find((c) => c.id === id);
      if (found && found.revokedAt === undefined) found.revokedAt = at;
    },
    async touchCredential(id, at) {
      const found = credentials.find((c) => c.id === id);
      if (found) found.lastUsedAt = at;
    },

    async createOAuthClient(record) {
      clients.push(clone(record));
    },
    async getOAuthClient(clientId) {
      const found = clients.find((c) => c.clientId === clientId);
      return found ? clone(found) : undefined;
    },

    async createAuthorizationCode(record) {
      codes.push(clone(record));
    },
    async consumeAuthorizationCode(codeHash, at) {
      const found = codes.find((c) => c.codeHash === codeHash);
      if (!found) return undefined;
      const alreadyUsed = found.usedAt !== undefined;
      if (!alreadyUsed) found.usedAt = at;
      return { record: clone(found), alreadyUsed };
    },
    async setAuthorizationCodeConnection(codeHash, connectionId) {
      const found = codes.find((c) => c.codeHash === codeHash);
      if (found) found.connectionId = connectionId;
    },

    async createProposal(record) {
      proposals.push(clone(record));
    },
    async getProposal(userId, id) {
      const found = proposals.find((p) => p.id === id && p.userId === userId);
      return found ? clone(found) : undefined;
    },
    async listProposals(userId, options) {
      return proposals
        .filter((p) => p.userId === userId && (!options.statuses || options.statuses.includes(p.status)))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, options.limit)
        .map(clone);
    },
    async transitionProposal(userId, id, from, to, patch) {
      const found = proposals.find((p) => p.id === id && p.userId === userId);
      if (!found || !from.includes(found.status)) return undefined;
      found.status = to;
      Object.assign(found, clone(patch));
      return clone(found);
    },

    async appendActivity(record) {
      activity.push(clone(record));
    },
    async listActivity(userId, options) {
      return activity
        .filter(
          (a) =>
            a.userId === userId &&
            (options.workspaceId === undefined || a.workspaceId === options.workspaceId) &&
            (options.connectionId === undefined || a.connectionId === options.connectionId) &&
            (options.before === undefined || a.at < options.before)
        )
        .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
        .slice(0, options.limit)
        .map(clone);
    },
    async pruneActivity(userId, olderThan) {
      for (let i = activity.length - 1; i >= 0; i -= 1) {
        if (activity[i].userId === userId && activity[i].at < olderThan) activity.splice(i, 1);
      }
    },

    async getIdempotent(connectionId, key) {
      const found = idempotency.find((r) => r.connectionId === connectionId && r.key === key);
      return found ? clone(found) : undefined;
    },
    async putIdempotent(record) {
      const found = idempotency.find((r) => r.connectionId === record.connectionId && r.key === record.key);
      if (found) return clone(found);
      idempotency.push(clone(record));
      return clone(record);
    },

    async getProjectContext(userId, workspaceId) {
      const found = contexts.find((c) => c.userId === userId && c.workspaceId === workspaceId);
      return found ? clone(found) : undefined;
    },
    async putProjectContext(record, expectedRevision) {
      const index = contexts.findIndex((c) => c.userId === record.userId && c.workspaceId === record.workspaceId);
      const current = index === -1 ? null : contexts[index].revision;
      if (current !== expectedRevision) return "conflict";
      if (index === -1) contexts.push(clone(record));
      else contexts[index] = clone(record);
      return "ok";
    },
    async deleteProjectContext(userId, workspaceId) {
      const index = contexts.findIndex((c) => c.userId === userId && c.workspaceId === workspaceId);
      if (index === -1) return false;
      contexts.splice(index, 1);
      return true;
    },

    async addNote(record) {
      const existing = notes.find(
        (n) => n.userId === record.userId && n.workspaceId === record.workspaceId && n.contentHash === record.contentHash
      );
      if (existing) return { note: clone(existing), created: false };
      notes.push(clone(record));
      return { note: clone(record), created: true };
    },
    async listNotes(userId, workspaceId, options) {
      const all = notes
        .filter((n) => n.userId === userId && n.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt - a.createdAt);
      return { notes: all.slice(options.offset, options.offset + options.limit).map(clone), total: all.length };
    },
    async deleteNote(userId, noteId) {
      const index = notes.findIndex((n) => n.id === noteId && n.userId === userId);
      if (index === -1) return false;
      notes.splice(index, 1);
      return true;
    },
  };
}
