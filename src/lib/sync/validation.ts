/**
 * Runtime validation for everything that arrives at the sync boundary.
 *
 * TypeScript types are erased at runtime and prove nothing about a request
 * body. This module is the actual trust boundary: it assumes every field is
 * hostile, checks each one, and returns plain data rather than throwing.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It never reads or trusts a `userId`/owner field. There isn't one in any
 *    payload type, by design. Ownership comes from the session
 *    (src/lib/auth/guard.ts) and is applied by the repository's WHERE
 *    clauses — never from the body. A client that invents an owner field
 *    finds it ignored, not honoured.
 *  - It never repairs. The persisted-data layer (src/lib/tabs/sanitize.ts)
 *    repairs rather than rejects because that data is the user's own content
 *    already on their disk and dropping it would be data loss. A sync
 *    payload is the opposite case: it is untrusted input that has not been
 *    accepted yet, so the safe answer is to refuse it and say why.
 */

import { isSafeOpenUrl } from "@/lib/browser/protocol";
import { isValidTimestamp } from "@/lib/timestamps";
import type {
  CollectionSyncPayload,
  DependencySyncPayload,
  GroupSyncPayload,
  SectionSyncPayload,
  TabSyncPayload,
  WorkspaceSyncPayload,
} from "./types";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Length ceilings, matched to what the schema's CHECK constraints allow so a
 * payload that passes here cannot then fail on insert.
 *
 * These are not style preferences: without them a single request can carry a
 * multi-megabyte string into a BIGINT-indexed table and turn one upload into
 * a denial of service.
 */
export const SYNC_LIMITS = {
  /** Matches MAX_OPEN_URL_LENGTH in src/lib/browser/protocol.ts. */
  url: 4000,
  name: 200,
  title: 2000,
  notes: 20_000,
  category: 100,
  organizationReason: 2000,
  /** Matches LOGO_MAX_DATA_URL_LENGTH in src/lib/workspace/logo.ts. */
  logo: 700_000,
  /** Per entity kind, per push. A bulk organize touches every tab in a workspace, so this is generous — but finite. */
  entitiesPerPush: 10_000,
  /** Tabs in one collection. */
  collectionTabs: 10_000,
} as const;

/**
 * RFC 4122 shape, any version, case-insensitive.
 *
 * Entity ids minted since Phase 1 (63992f8) are v4 UUIDs. Ids saved BEFORE
 * that phase kept their old `<prefix>-<epoch_ms>-<counter>` form and are
 * rejected here — deliberately, and with its own error string so the caller
 * can tell "malformed" from "legacy" without parsing prose. What should
 * happen to a legacy-id workspace on first upload is part of the initial
 * sync policy, which is deferred; see SYNC_INITIAL_POLICY in ./types.ts.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Old-format ids from before the UUID migration, recognised only to report them precisely. */
const LEGACY_ID_RE = /^[a-z]+-\d+-\d+$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isLegacyEntityId(value: unknown): boolean {
  return typeof value === "string" && !UUID_RE.test(value) && LEGACY_ID_RE.test(value);
}

class Checker {
  readonly errors: string[] = [];

  constructor(private readonly record: Record<string, unknown>) {}

  private fail(field: string, why: string): void {
    this.errors.push(`${field}: ${why}`);
  }

  id(field: string): string | undefined {
    const value = this.record[field];
    if (isUuid(value)) return value;
    if (isLegacyEntityId(value)) this.fail(field, "legacy non-UUID id — predates the UUID migration");
    else this.fail(field, "must be a UUID");
    return undefined;
  }

  /** A nullable id: `null` is a real value (a root section's parentId), `undefined` is absence. */
  optionalId(field: string): string | undefined {
    const value = this.record[field];
    if (value === undefined || value === null) return undefined;
    return this.id(field);
  }

  requiredTimestamp(field: string): number | undefined {
    const value = this.record[field];
    if (!isValidTimestamp(value)) {
      this.fail(field, "must be a finite epoch-ms number");
      return undefined;
    }
    if (!Number.isInteger(value)) {
      this.fail(field, "must be an integer");
      return undefined;
    }
    if (value < 0) {
      this.fail(field, "must not be negative");
      return undefined;
    }
    return value;
  }

  optionalTimestamp(field: string): number | undefined {
    if (this.record[field] === undefined) return undefined;
    return this.requiredTimestamp(field);
  }

  requiredString(field: string, max: number): string | undefined {
    const value = this.record[field];
    if (typeof value !== "string") {
      this.fail(field, "must be a string");
      return undefined;
    }
    if (value.length > max) {
      this.fail(field, `must be at most ${max} characters`);
      return undefined;
    }
    return value;
  }

  optionalString(field: string, max: number): string | undefined {
    if (this.record[field] === undefined) return undefined;
    return this.requiredString(field, max);
  }

  optionalBoolean(field: string): boolean | undefined {
    const value = this.record[field];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      this.fail(field, "must be a boolean");
      return undefined;
    }
    return value;
  }

  optionalEnum<T extends string>(field: string, allowed: readonly T[]): T | undefined {
    const value = this.record[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.fail(field, `must be one of ${allowed.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  requiredEnum<T extends string>(field: string, allowed: readonly T[]): T | undefined {
    const value = this.record[field];
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.fail(field, `must be one of ${allowed.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  /**
   * The URL rule, delegated to the same helper the client and the desktop
   * safelist use rather than re-derived here. Phase 9af6c71 restricted saved
   * URLs to http(s); the server must never be the place that lets a
   * `javascript:` or `file:` URL back in.
   *
   * The accepted string is returned byte-for-byte: the server does not
   * re-normalize, because the client's stored representation is the user's
   * and rewriting it would make a round trip lossy.
   */
  url(field: string): string | undefined {
    const value = this.record[field];
    if (typeof value !== "string") {
      this.fail(field, "must be a string");
      return undefined;
    }
    if (value.length > SYNC_LIMITS.url) {
      this.fail(field, `must be at most ${SYNC_LIMITS.url} characters`);
      return undefined;
    }
    if (!isSafeOpenUrl(value)) {
      this.fail(field, "must be an http(s) URL");
      return undefined;
    }
    return value;
  }

  /** `updatedAt` may not precede `createdAt` when both are present. */
  ordering(createdAt: number | undefined, updatedAt: number | undefined): void {
    if (createdAt === undefined || updatedAt === undefined) return;
    if (updatedAt < createdAt) this.fail("updatedAt", "must not precede createdAt");
  }
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function fail<T>(message: string): ValidationResult<T> {
  return { ok: false, errors: [message] };
}

function finish<T>(checker: Checker, build: () => T): ValidationResult<T> {
  if (checker.errors.length > 0) return { ok: false, errors: checker.errors };
  return { ok: true, value: build() };
}

/** Drops keys whose value is undefined, so an absent optional stays absent rather than becoming an explicit undefined. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function validateWorkspacePayload(input: unknown): ValidationResult<WorkspaceSyncPayload> {
  const record = asRecord(input);
  if (!record) return fail("workspace: must be an object");

  const c = new Checker(record);
  const id = c.id("id");
  const name = c.requiredString("name", SYNC_LIMITS.name);
  const logo = c.optionalString("logo", SYNC_LIMITS.logo);
  const createdAt = c.requiredTimestamp("createdAt");
  const updatedAt = c.requiredTimestamp("updatedAt");
  c.ordering(createdAt, updatedAt);

  return finish(c, () =>
    compact({ id: id!, name: name!, logo, createdAt: createdAt!, updatedAt: updatedAt! })
  );
}

export function validateTabPayload(input: unknown): ValidationResult<TabSyncPayload> {
  const record = asRecord(input);
  if (!record) return fail("tab: must be an object");

  const c = new Checker(record);
  const id = c.id("id");
  const url = c.url("url");
  const title = c.optionalString("title", SYNC_LIMITS.title);
  const notes = c.optionalString("notes", SYNC_LIMITS.notes);
  const category = c.optionalString("category", SYNC_LIMITS.category);
  const organizationReason = c.optionalString("organizationReason", SYNC_LIMITS.organizationReason);
  const isFavorite = c.optionalBoolean("isFavorite");
  const pinned = c.optionalBoolean("pinned");
  const sectionLocked = c.optionalBoolean("sectionLocked");
  const sectionId = c.optionalId("sectionId");
  const groupId = c.optionalId("groupId");
  const organizationStatus = c.optionalEnum("organizationStatus", [
    "classified",
    "uncertain",
    "fallback",
    "manual",
  ] as const);
  const source = c.optionalEnum("source", ["tabs", "history"] as const);
  const lastAccessedAt = c.optionalTimestamp("lastAccessedAt");
  const historyLastVisitedAt = c.optionalTimestamp("historyLastVisitedAt");
  const createdAt = c.optionalTimestamp("createdAt");
  const updatedAt = c.optionalTimestamp("updatedAt");
  c.ordering(createdAt, updatedAt);

  let confidence: number | undefined;
  if (record.confidence !== undefined) {
    const value = record.confidence;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      c.errors.push("confidence: must be a number between 0 and 1");
    } else {
      confidence = value;
    }
  }

  let historyVisitCount: number | undefined;
  if (record.historyVisitCount !== undefined) {
    const value = record.historyVisitCount;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      c.errors.push("historyVisitCount: must be a non-negative integer");
    } else {
      historyVisitCount = value;
    }
  }

  return finish(c, () =>
    compact({
      id: id!,
      url: url!,
      title,
      notes,
      category,
      confidence,
      isFavorite,
      pinned,
      sectionId,
      sectionLocked,
      organizationStatus,
      organizationReason,
      groupId,
      lastAccessedAt,
      source,
      historyVisitCount,
      historyLastVisitedAt,
      createdAt,
      updatedAt,
    })
  );
}

export function validateSectionPayload(input: unknown): ValidationResult<SectionSyncPayload> {
  const record = asRecord(input);
  if (!record) return fail("section: must be an object");

  const c = new Checker(record);
  const id = c.id("id");
  const name = c.requiredString("name", SYNC_LIMITS.name);
  const source = c.requiredEnum("source", ["ai", "user"] as const);
  const createdAt = c.requiredTimestamp("createdAt");
  const updatedAt = c.requiredTimestamp("updatedAt");
  c.ordering(createdAt, updatedAt);

  // `parentId` is genuinely three-valued: a UUID, null for a root section,
  // or absent. Only the first two are acceptable, because a section with no
  // stated parent is not the same as one explicitly at the root.
  let parentId: string | null | undefined;
  if (record.parentId === null) parentId = null;
  else if (record.parentId === undefined) c.errors.push("parentId: must be a UUID or null");
  else parentId = c.optionalId("parentId") ?? undefined;

  if (id !== undefined && parentId === id) c.errors.push("parentId: must not be the section itself");

  return finish(c, () => ({
    id: id!,
    parentId: parentId ?? null,
    name: name!,
    source: source!,
    createdAt: createdAt!,
    updatedAt: updatedAt!,
  }));
}

export function validateGroupPayload(input: unknown): ValidationResult<GroupSyncPayload> {
  const record = asRecord(input);
  if (!record) return fail("group: must be an object");

  const c = new Checker(record);
  const id = c.id("id");
  const name = c.requiredString("name", SYNC_LIMITS.name);
  const createdAt = c.requiredTimestamp("createdAt");
  const updatedAt = c.requiredTimestamp("updatedAt");
  c.ordering(createdAt, updatedAt);

  return finish(c, () => ({ id: id!, name: name!, createdAt: createdAt!, updatedAt: updatedAt! }));
}

export function validateCollectionPayload(input: unknown): ValidationResult<CollectionSyncPayload> {
  const record = asRecord(input);
  if (!record) return fail("collection: must be an object");

  const c = new Checker(record);
  const id = c.id("id");
  const name = c.requiredString("name", SYNC_LIMITS.name);
  const createdAt = c.requiredTimestamp("createdAt");
  const updatedAt = c.requiredTimestamp("updatedAt");
  c.ordering(createdAt, updatedAt);

  const tabIds: string[] = [];
  const raw = record.tabIds;
  if (!Array.isArray(raw)) {
    c.errors.push("tabIds: must be an array");
  } else if (raw.length > SYNC_LIMITS.collectionTabs) {
    c.errors.push(`tabIds: must hold at most ${SYNC_LIMITS.collectionTabs} tabs`);
  } else {
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!isUuid(entry)) {
        c.errors.push("tabIds: every entry must be a UUID");
        break;
      }
      // The membership table's primary key is (collection_id, tab_id), so a
      // repeated id would be a constraint violation on insert rather than a
      // harmless duplicate. Rejecting it here keeps the failure legible.
      if (seen.has(entry)) {
        c.errors.push("tabIds: must not repeat a tab");
        break;
      }
      seen.add(entry);
      tabIds.push(entry);
    }
  }

  return finish(c, () => ({ id: id!, name: name!, tabIds, createdAt: createdAt!, updatedAt: updatedAt! }));
}

export function validateDependencyPayload(input: unknown): ValidationResult<DependencySyncPayload> {
  const record = asRecord(input);
  if (!record) return fail("dependency: must be an object");

  const c = new Checker(record);
  const parentTabId = c.id("parentTabId");
  const childTabId = c.id("childTabId");
  const type = c.optionalEnum("type", [
    "main-document",
    "research",
    "data-source",
    "reference",
    "tool",
    "other",
  ] as const);
  const createdAt = c.requiredTimestamp("createdAt");
  const updatedAt = c.optionalTimestamp("updatedAt");
  c.ordering(createdAt, updatedAt);

  // Mirrors isSelfDependency() on the client and the CHECK in schema.sql.
  if (parentTabId !== undefined && parentTabId === childTabId) {
    c.errors.push("childTabId: a tab cannot depend on itself");
  }

  return finish(c, () =>
    compact({ parentTabId: parentTabId!, childTabId: childTabId!, type, createdAt: createdAt!, updatedAt })
  );
}
