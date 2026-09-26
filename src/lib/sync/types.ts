/**
 * The workspace synchronization contract.
 *
 * These types describe how local Hubble state will eventually be
 * represented on the server and how a client will ask what changed. Nothing
 * in the running application uses them yet — Hubble is still local-first,
 * localStorage is still the source of truth, and no mutation path touches
 * the network. This is the contract a later phase implements against.
 *
 * The DTOs here are deliberately NOT the database row shapes (those live in
 * ./repository.ts and stay private to it). Rows are snake_case, carry
 * `sync_version`, and change whenever the schema does; the protocol should
 * not inherit any of that. They are also not the client's own types: a
 * `Tab` carries derived fields (normalizedUrl, domain, isDuplicate, favicon)
 * that are recomputed locally and never sent. See schema.sql for the
 * field-by-field reasoning.
 */

/** Every entity the server represents. Collection membership is not here: it travels as part of its collection. */
export type SyncEntityType = "workspace" | "tab" | "section" | "group" | "collection" | "dependency";

export const SYNC_ENTITY_TYPES: readonly SyncEntityType[] = [
  "workspace",
  "tab",
  "section",
  "group",
  "collection",
  "dependency",
] as const;

/**
 * An opaque position in one workspace's change stream.
 *
 * A string rather than a number, even though it is currently a decimal
 * integer, because a client must never do arithmetic on it — only send back
 * what the server last gave it. That keeps the encoding free to change.
 *
 * Deliberately NOT a wall-clock timestamp. Two records can share a
 * millisecond, clocks move backwards, and a client's clock is not the
 * server's. See schema.sql for why the underlying value is drawn from a
 * per-workspace counter taken under a row lock rather than from a global
 * sequence.
 */
export type SyncCursor = string;

/** The cursor meaning "I have nothing; send me everything." */
export const SYNC_CURSOR_START: SyncCursor = "0";

/**
 * Identity of an entity within the protocol.
 *
 * `dependency` is the reason this is a discriminated shape rather than a
 * bare id: its identity is the (parentTabId, childTabId) pair, not a minted
 * id, so there is nothing to put in an `entityId` field that would not be a
 * redundant restatement of the pair. Forcing one would invent a second
 * identity that could disagree with the columns beside it.
 */
export type SyncEntityRef =
  | { entityType: Exclude<SyncEntityType, "dependency">; entityId: string }
  | { entityType: "dependency"; parentTabId: string; childTabId: string };

/** Workspace-level fields the server owns. Device-local state (camera, sidebar, selection, graph layout) is deliberately absent. */
export type WorkspaceSyncPayload = {
  id: string;
  name: string;
  logo?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * A tab as it crosses the wire.
 *
 * Missing on purpose: normalizedUrl and domain (derived from url),
 * isDuplicate (recomputed across the list), favicon (written but never
 * read). A receiving client recomputes all four.
 */
export type TabSyncPayload = {
  id: string;
  url: string;
  title?: string;
  notes?: string;
  category?: string;
  confidence?: number;
  isFavorite?: boolean;
  pinned?: boolean;
  sectionId?: string;
  sectionLocked?: boolean;
  organizationStatus?: "classified" | "uncertain" | "fallback" | "manual";
  organizationReason?: string;
  groupId?: string;
  lastAccessedAt?: number;
  source?: "tabs" | "history";
  historyVisitCount?: number;
  historyLastVisitedAt?: number;
  /** Optional exactly as on the client: a tab predating Phase 2 has neither, and nothing invents them. */
  createdAt?: number;
  updatedAt?: number;
};

export type SectionSyncPayload = {
  id: string;
  parentId: string | null;
  name: string;
  source: "ai" | "user";
  createdAt: number;
  updatedAt: number;
};

export type GroupSyncPayload = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/** `tabIds` is ordered and is part of the collection's own payload — membership is not separately versioned. */
export type CollectionSyncPayload = {
  id: string;
  name: string;
  tabIds: string[];
  createdAt: number;
  updatedAt: number;
};

/** No `id`: the pair is the identity. See SyncEntityRef. */
export type DependencySyncPayload = {
  parentTabId: string;
  childTabId: string;
  type?: "main-document" | "research" | "data-source" | "reference" | "tool" | "other";
  createdAt: number;
  updatedAt?: number;
};

export type SyncPayloadFor<T extends SyncEntityType> = T extends "workspace"
  ? WorkspaceSyncPayload
  : T extends "tab"
    ? TabSyncPayload
    : T extends "section"
      ? SectionSyncPayload
      : T extends "group"
        ? GroupSyncPayload
        : T extends "collection"
          ? CollectionSyncPayload
          : DependencySyncPayload;

/**
 * One change in a workspace's stream.
 *
 * A delete carries no payload — only enough identity for a client to remove
 * its local copy — which is exactly what a tombstone row holds.
 */
export type SyncChange =
  | ({
      operation: "upsert";
      workspaceId: string;
      cursor: SyncCursor;
    } & (
      | { entityType: "workspace"; entityId: string; entity: WorkspaceSyncPayload }
      | { entityType: "tab"; entityId: string; entity: TabSyncPayload }
      | { entityType: "section"; entityId: string; entity: SectionSyncPayload }
      | { entityType: "group"; entityId: string; entity: GroupSyncPayload }
      | { entityType: "collection"; entityId: string; entity: CollectionSyncPayload }
      | { entityType: "dependency"; parentTabId: string; childTabId: string; entity: DependencySyncPayload }
    ))
  | ({
      operation: "delete";
      workspaceId: string;
      cursor: SyncCursor;
      /** When the server recorded the deletion, epoch ms. */
      deletedAt: number;
    } & SyncEntityRef);

/**
 * The shape a future `GET changes since cursor` returns.
 *
 * `changes` is in cursor order. `nextCursor` is what the client sends next
 * time, and is the cursor of the last change returned (or the cursor it sent
 * in, when nothing changed) — never a value the client computes.
 *
 * `hasMore` exists because a first sync of a large workspace must be
 * pageable: the client keeps calling with `nextCursor` until it is false.
 */
export type SyncChangesPage = {
  workspaceId: string;
  changes: SyncChange[];
  nextCursor: SyncCursor;
  hasMore: boolean;
};

/**
 * What a client sends to push local state up.
 *
 * `baseCursor` is the cursor the client last successfully read. It is what
 * makes conflict detection possible at all: the server can see that the
 * client is writing against a version of the workspace it has not seen. The
 * upload is all-or-nothing (see repository.ts's transaction note) so a bulk
 * operation — organize, move 20 tabs, import — is never half-applied.
 */
export type SyncPushRequest = {
  workspaceId: string;
  baseCursor: SyncCursor;
  upserts: SyncUpsert[];
  deletes: SyncEntityRef[];
};

export type SyncUpsert =
  | { entityType: "workspace"; entity: WorkspaceSyncPayload }
  | { entityType: "tab"; entity: TabSyncPayload }
  | { entityType: "section"; entity: SectionSyncPayload }
  | { entityType: "group"; entity: GroupSyncPayload }
  | { entityType: "collection"; entity: CollectionSyncPayload }
  | { entityType: "dependency"; entity: DependencySyncPayload };

/**
 * ## Conflict policy — deliberately unresolved
 *
 * This phase defines detection, not resolution. The server compares the
 * client's `baseCursor` against the workspace's current cursor; if the
 * workspace moved on, the push conflicts. What happens next is Phase 4's
 * decision, and it must NOT default to last-writer-wins, because some fields
 * carry product meaning that a timestamp comparison would destroy:
 *
 *  - `sectionLocked` is an explicit statement that a human placed this tab,
 *    and the AI organizer already refuses to move such a tab locally. A
 *    server merge that let a later AI-driven write from another device
 *    overwrite a locked placement would break that guarantee across devices,
 *    even though the AI write is genuinely "newer".
 *  - `organizationStatus: "manual"` and a cleared `organizationReason` carry
 *    the same intent and travel with it.
 *  - `lastAccessedAt` is not a conflict at all: it is a high-water mark, and
 *    the correct merge is the greater of the two values rather than the one
 *    that arrived last.
 *
 * A client MUST therefore treat a conflict as "re-read and decide", never as
 * "retry the same push harder".
 */
export type SyncConflict = {
  workspaceId: string;
  /** What the client believed it was writing against. */
  baseCursor: SyncCursor;
  /** Where the workspace actually is. The client re-reads from its own cursor to catch up. */
  serverCursor: SyncCursor;
};

export type SyncPushResult =
  | { ok: true; workspaceId: string; cursor: SyncCursor }
  | { ok: false; reason: "conflict"; conflict: SyncConflict }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "invalid"; errors: readonly string[] };

/**
 * ## Initial sync policy — local state is authoritative until the user says otherwise
 *
 * The situation this exists to prevent: a user with two local workspaces
 * signs in, and the server (which has none) is treated as the truth, so the
 * first sync silently empties their app.
 *
 * The rule, which the schema is built to allow and which no code here
 * violates:
 *
 *  1. Signing in NEVER changes local data. Authentication and
 *     synchronization are separate decisions.
 *  2. An empty server is never evidence that local workspaces were deleted.
 *     "The server has no workspace W" and "W was deleted" are different
 *     statements, and only a tombstone says the second one.
 *  3. Local → server adoption is an explicit, per-workspace, user-initiated
 *     action. It uploads; it does not reconcile.
 *  4. Nothing deletes local data as a consequence of sync. A tombstone
 *     arriving for a workspace the user never uploaded is not actionable.
 *
 * This is why `SyncChange["operation"]: "delete"` is carried by an explicit
 * tombstone rather than inferred from absence: absence must never mean
 * deletion.
 */
export const SYNC_INITIAL_POLICY = "local-authoritative-until-user-initiates" as const;
