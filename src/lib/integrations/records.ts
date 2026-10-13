import type { HubbleScope, IntegrationClient } from "./scopes";

/**
 * The integration layer's durable records.
 *
 * Plain data, shared by the in-memory store (tests, and the shape a store
 * must honour) and the Postgres one (./store-postgres.ts, ./schema.sql).
 * Credentials appear here only as hashes: no record type has a field a live
 * token, secret or authorization code could be put in.
 */

/**
 * A connection: one AI client's grant to one Hubble account.
 *
 * The unit of permission. What the client may do (`scopes`) and where
 * (`workspaceIds`) live here, not on a token, so changing or revoking a
 * connection takes effect for every credential issued under it on the next
 * request.
 */
export type ConnectionRecord = {
  id: string;
  userId: string;
  client: IntegrationClient;
  /** What the person (or the registering client) called it. A label, never interpreted. */
  label: string;
  method: "oauth" | "token";
  /** The OAuth client this connection was authorized for. Absent for token connections. */
  oauthClientId?: string;
  scopes: HubbleScope[];
  /** The only workspaces this connection can see. Never empty; never "all". */
  workspaceIds: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

export type CredentialKind =
  /** OAuth access token (`hbat_`): short-lived, audience-bound. */
  | "access"
  /** OAuth refresh token (`hbrt_`): rotated on every use. */
  | "refresh"
  /** Personal token (`hbpat_`) pasted into a CLI or config file. */
  | "personal"
  /** Hubble's own connection test (`hbtest_`): minutes long, revoked after the test. */
  | "test";

export type CredentialRecord = {
  id: string;
  connectionId: string;
  kind: CredentialKind;
  /** SHA-256 of the credential, lowercase hex. Never the credential. */
  tokenHash: string;
  /** Last four characters, so a person can tell two personal tokens apart. */
  hint: string;
  /** The resource (MCP endpoint URL) an access token was issued for — its audience. */
  resource?: string;
  createdAt: number;
  expiresAt: number;
  /** A refresh token that has been exchanged. Presenting it again is reuse. */
  usedAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
};

/** A client registered through OAuth Dynamic Client Registration (RFC 7591). */
export type OAuthClientRecord = {
  clientId: string;
  /** Self-declared; shown to the person as the client's claim, never trusted. */
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  /** SHA-256 of the client secret, for confidential clients. */
  secretHash?: string;
  createdAt: number;
};

/** An issued authorization code. Single use, minutes long, and only its hash is kept. */
export type AuthorizationCodeRecord = {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: HubbleScope[];
  workspaceIds: string[];
  client: IntegrationClient;
  label: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  /** The connection the code was exchanged into — revoked if the code is replayed. */
  connectionId?: string;
};

export type ProposalStatus = "pending" | "approved" | "declined" | "applying" | "applied" | "failed" | "expired";

export type ProposalOperation =
  | { kind: "create_collection"; name: string; tabIds: string[]; reason?: string; confidence?: "high" | "medium" | "unclear" }
  | { kind: "rename_collection"; collectionId: string; name: string; reason?: string; confidence?: "high" | "medium" | "unclear" }
  | { kind: "add_tabs_to_collection"; collectionId: string; tabIds: string[]; reason?: string; confidence?: "high" | "medium" | "unclear" };

/** One step as a person reads it on the approval card: names and titles, never ids. */
export type ProposalStep = {
  kind: ProposalOperation["kind"];
  line: string;
  subject: string;
  to?: string;
  tabCount?: number;
  tabs: string[];
  moreTabs?: number;
  movesFrom: string[];
  reason?: string;
  confidence?: "high" | "medium" | "unclear";
};

export type ProposalResult = {
  verified: boolean;
  steps: { index: number; line: string; verified: boolean; collectionId?: string }[];
};

/** A reorganization an AI client proposed, waiting for — or past — the person's decision. */
export type ProposalRecord = {
  id: string;
  userId: string;
  connectionId: string;
  client: IntegrationClient;
  workspaceId: string;
  /** The sync cursor the proposal was validated against. */
  baseVersion: number;
  operations: ProposalOperation[];
  steps: ProposalStep[];
  tabCount: number;
  /** What the plan changes, encoded, so a revalidation can prove it still does exactly that. */
  effect: string;
  /** The client's one-line summary, shown as its words. */
  summary?: string;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  appliedAt?: number;
  result?: ProposalResult;
  /** A fixed reason code when status is failed or expired. */
  failure?: string;
};

export type ActivityKind = "read" | "write" | "proposal" | "approval" | "decline" | "apply" | "connection";
export type ActivityOutcome = "ok" | "denied" | "failed" | "pending" | "partial";
export type ActivityActor = "ai_client" | "user" | "connection_test";

/**
 * One audited integration action.
 *
 * Ids, counts and fixed wording only. No resource text, no search query, no
 * prompt, no token: `detail` is built from templates in ./activity.ts whose
 * only free text is a collection or workspace name the person already owns.
 */
export type ActivityRecord = {
  id: string;
  userId: string;
  connectionId?: string;
  client?: IntegrationClient;
  actor: ActivityActor;
  kind: ActivityKind;
  /** The MCP tool or the operation. */
  operation: string;
  workspaceId?: string;
  targets: string[];
  outcome: ActivityOutcome;
  errorCategory?: string;
  detail?: string;
  at: number;
};

/** A remembered mutation result, so a retried call returns it instead of acting twice. */
export type IdempotencyRecord = {
  connectionId: string;
  key: string;
  operation: string;
  result: unknown;
  createdAt: number;
};

export type ContextSource = { kind: "integration"; client: IntegrationClient; connectionId: string } | { kind: "user" };

export type ProjectDecision = { id: string; text: string; at: number; source: ContextSource };
export type ProjectTask = { id: string; text: string; status: "open" | "done"; createdAt: number; updatedAt: number; source: ContextSource };

/**
 * A workspace's saved project context, version 1.
 *
 * Only what a person or an authorized client explicitly asked Hubble to
 * save. Nothing is inferred or summarised into it by Hubble, and a field is
 * absent rather than empty when nobody saved one.
 */
export type ProjectContextRecord = {
  schemaVersion: 1;
  userId: string;
  workspaceId: string;
  /** Bumped on every write — the optimistic-concurrency token `expectedRevision` is compared to. */
  revision: number;
  goal?: string;
  summary?: string;
  decisions: ProjectDecision[];
  tasks: ProjectTask[];
  /** Saved tabs the context names as relevant. Ids only; resolved against the workspace when read. */
  resourceTabIds: string[];
  createdAt: number;
  updatedAt: number;
  updatedBy: ContextSource;
};

export type WorkspaceNoteRecord = {
  id: string;
  userId: string;
  workspaceId: string;
  collectionId?: string;
  title: string;
  body: string;
  /** SHA-256 of title + body + collection, so a retried save does not make a second copy. */
  contentHash: string;
  createdAt: number;
  source: ContextSource;
};
