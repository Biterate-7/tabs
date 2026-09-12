/**
 * Turning an untrusted request body into the validated payloads the service
 * accepts.
 *
 * Every field check delegates to ./validation.ts. There is deliberately no
 * second URL check, no second UUID regex and no second timestamp rule here —
 * one authoritative validation path is the whole point, and a duplicate
 * would be the copy that drifts.
 */

import { SYNC_LIMITS, isUuid } from "./validation";
import {
  validateCollectionPayload,
  validateDependencyPayload,
  validateGroupPayload,
  validateSectionPayload,
  validateTabPayload,
  validateWorkspacePayload,
} from "./validation";
import type { SyncCursor, SyncEntityRef, SyncUpsert, WorkspaceSyncPayload } from "./types";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A cursor is an opaque decimal string the server issued. Anything else is a client inventing one. */
export function isCursor(value: unknown): value is SyncCursor {
  return typeof value === "string" && /^\d{1,19}$/.test(value);
}

const ENTITY_TYPES = ["workspace", "tab", "section", "group", "collection", "dependency"] as const;

/** One upsert, dispatched to the validator for its declared type. */
function parseUpsert(input: unknown, index: number): ParseResult<SyncUpsert> {
  if (!isRecord(input)) return { ok: false, errors: [`upserts[${index}]: must be an object`] };

  const entityType = input.entityType;
  if (typeof entityType !== "string" || !(ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return { ok: false, errors: [`upserts[${index}].entityType: must be one of ${ENTITY_TYPES.join(", ")}`] };
  }

  const entity = input.entity;
  const prefix = `upserts[${index}].entity`;
  const wrap = <T>(result: { ok: true; value: T } | { ok: false; errors: string[] }) =>
    result.ok ? result : { ok: false as const, errors: result.errors.map((e) => `${prefix}.${e}`) };

  switch (entityType) {
    case "workspace": {
      const r = wrap(validateWorkspacePayload(entity));
      return r.ok ? { ok: true, value: { entityType, entity: r.value } } : r;
    }
    case "tab": {
      const r = wrap(validateTabPayload(entity));
      return r.ok ? { ok: true, value: { entityType, entity: r.value } } : r;
    }
    case "section": {
      const r = wrap(validateSectionPayload(entity));
      return r.ok ? { ok: true, value: { entityType, entity: r.value } } : r;
    }
    case "group": {
      const r = wrap(validateGroupPayload(entity));
      return r.ok ? { ok: true, value: { entityType, entity: r.value } } : r;
    }
    case "collection": {
      const r = wrap(validateCollectionPayload(entity));
      return r.ok ? { ok: true, value: { entityType, entity: r.value } } : r;
    }
    default: {
      const r = wrap(validateDependencyPayload(entity));
      return r.ok ? { ok: true, value: { entityType: "dependency", entity: r.value } } : r;
    }
  }
}

function parseRef(input: unknown, index: number): ParseResult<SyncEntityRef> {
  if (!isRecord(input)) return { ok: false, errors: [`deletes[${index}]: must be an object`] };
  const entityType = input.entityType;
  if (typeof entityType !== "string" || !(ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return { ok: false, errors: [`deletes[${index}].entityType: must be one of ${ENTITY_TYPES.join(", ")}`] };
  }
  if (entityType === "dependency") {
    if (!isUuid(input.parentTabId) || !isUuid(input.childTabId)) {
      return { ok: false, errors: [`deletes[${index}]: parentTabId and childTabId must be UUIDs`] };
    }
    return { ok: true, value: { entityType, parentTabId: input.parentTabId, childTabId: input.childTabId } };
  }
  if (!isUuid(input.entityId)) {
    return { ok: false, errors: [`deletes[${index}].entityId: must be a UUID`] };
  }
  return {
    ok: true,
    value: { entityType: entityType as Exclude<SyncEntityRef["entityType"], "dependency">, entityId: input.entityId },
  };
}

/**
 * Parses an array of upserts/deletes with a hard count ceiling.
 *
 * The ceiling is checked BEFORE anything is validated: validating a
 * million-element array to then reject it is the denial of service the limit
 * exists to prevent.
 */
function parseList<T>(
  raw: unknown,
  field: string,
  max: number,
  parse: (input: unknown, index: number) => ParseResult<T>
): ParseResult<T[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, errors: [`${field}: must be an array`] };
  if (raw.length > max) return { ok: false, errors: [`${field}: must hold at most ${max} entries`] };

  const value: T[] = [];
  const errors: string[] = [];
  for (const [index, entry] of raw.entries()) {
    const result = parse(entry, index);
    if (result.ok) value.push(result.value);
    else errors.push(...result.errors);
    // Enough detail to fix the request without returning thousands of lines.
    if (errors.length >= 20) break;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export type ParsedInitialRequest = {
  workspace: WorkspaceSyncPayload;
  upserts: SyncUpsert[];
  knownCursor: SyncCursor | null;
};

export function parseInitialRequest(body: unknown, maxEntities: number): ParseResult<ParsedInitialRequest> {
  if (!isRecord(body)) return { ok: false, errors: ["body: must be an object"] };

  const workspace = validateWorkspacePayload(body.workspace);
  if (!workspace.ok) return { ok: false, errors: workspace.errors.map((e) => `workspace.${e}`) };

  const upserts = parseList(body.upserts, "upserts", maxEntities, parseUpsert);
  if (!upserts.ok) return upserts;

  // Present only on a retry, where it says "I already uploaded this and saw
  // cursor X". Absent means a genuine first attempt, which is refused if the
  // workspace already exists rather than overwriting it.
  let knownCursor: SyncCursor | null = null;
  if (body.knownCursor !== undefined && body.knownCursor !== null) {
    if (!isCursor(body.knownCursor)) return { ok: false, errors: ["knownCursor: must be a cursor string"] };
    knownCursor = body.knownCursor;
  }

  return { ok: true, value: { workspace: workspace.value, upserts: upserts.value, knownCursor } };
}

export type ParsedPushRequest = {
  workspaceId: string;
  baseCursor: SyncCursor;
  upserts: SyncUpsert[];
  deletes: SyncEntityRef[];
};

export function parsePushRequest(body: unknown, maxChanges: number): ParseResult<ParsedPushRequest> {
  if (!isRecord(body)) return { ok: false, errors: ["body: must be an object"] };
  if (!isUuid(body.workspaceId)) return { ok: false, errors: ["workspaceId: must be a UUID"] };
  if (!isCursor(body.baseCursor)) return { ok: false, errors: ["baseCursor: must be a cursor string"] };

  const upserts = parseList(body.upserts, "upserts", maxChanges, parseUpsert);
  if (!upserts.ok) return upserts;
  const deletes = parseList(body.deletes, "deletes", maxChanges, parseRef);
  if (!deletes.ok) return deletes;

  if (upserts.value.length + deletes.value.length > maxChanges) {
    return { ok: false, errors: [`changes: must hold at most ${maxChanges} entries`] };
  }

  return {
    ok: true,
    value: {
      workspaceId: body.workspaceId,
      baseCursor: body.baseCursor,
      upserts: upserts.value,
      deletes: deletes.value,
    },
  };
}

export { SYNC_LIMITS };
