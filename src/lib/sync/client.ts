/**
 * The browser-side synchronization service.
 *
 * Plain functions over `fetch`. No React, no store access, no imports from
 * app-shell — the caller passes data in and gets a result out, which is what
 * keeps networking outside the architecture Phase 2.5 established:
 *
 *   reducer (pure) → commitStore (local persistence) → [sync service]
 *
 * Nothing here is called by a reducer or by commitStore, and nothing here
 * writes to localStorage. A caller decides when to sync and what to do with
 * the answer.
 *
 *
 * ## Failure is never data loss
 *
 * Every function returns a discriminated result rather than throwing, and
 * every failure — offline, 500, conflict, sync not configured — leaves the
 * caller's local state exactly as it was. That is the phase's central
 * invariant: a server response can refuse, but it can never delete.
 *
 * In particular an empty or 404 response is NOT evidence that a workspace
 * was deleted. Only an explicit tombstone in a pull says that, and acting on
 * absence is the mistake this whole design exists to prevent.
 */

import { buildWorkspaceUpserts, toWorkspacePayload } from "./serialize";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Workspace } from "@/lib/workspace/types";
import type { SyncChange, SyncChangesPage, SyncCursor, SyncEntityRef, SyncUpsert } from "./types";

/** Why a sync attempt did not succeed. Each one is recoverable and none implies local data is wrong. */
export type SyncFailure =
  | { kind: "offline"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-configured"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string; errors: string[] }
  /**
   * The account already owns this workspace on the server.
   *
   * Separate from `conflict` because it is not a disagreement and the
   * caller's next move is different: adopt what is there, rather than ask
   * the user to choose between two versions of something.
   */
  | { kind: "already-exists"; message: string; serverCursor: SyncCursor }
  | { kind: "conflict"; message: string; serverCursor: SyncCursor; conflicts: unknown[] }
  | { kind: "stale-base"; message: string; serverCursor: SyncCursor }
  | { kind: "server"; message: string; status: number };

export type SyncResult<T> = { ok: true; value: T } | { ok: false; failure: SyncFailure };

export type InitialSyncValue = { cursor: SyncCursor; created: boolean };
export type PushValue = { cursor: SyncCursor; accepted: SyncChange[] };

type Json = Record<string, unknown>;

/**
 * One place that turns a Response into a result.
 *
 * The status codes map onto the route contract: 401 unauthenticated, 403
 * rejected, 404 not yours, 409 conflict, 413 too large, 503 not configured.
 * A network rejection (no server, DNS failure, offline) surfaces as
 * `offline` rather than as an exception, because to the caller it means the
 * same thing: try later, change nothing.
 */
async function request(path: string, init: RequestInit): Promise<SyncResult<Json>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      // The session cookie is HttpOnly and same-origin; nothing here reads
      // or sends a token by hand.
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch {
    return {
      ok: false,
      failure: { kind: "offline", message: "Couldn't reach the server. Your workspace is safe on this device." },
    };
  }

  let body: Json = {};
  try {
    body = (await response.json()) as Json;
  } catch {
    // A body that isn't JSON (a proxy error page, an empty 502) is still a
    // failure the caller can act on.
    body = {};
  }

  if (response.ok) return { ok: true, value: body };

  const message = typeof body.error === "string" ? body.error : "Sync failed.";

  switch (response.status) {
    case 401:
      return { ok: false, failure: { kind: "unauthenticated", message } };
    case 503:
      // Only OUR 503 says the deployment has no database, and it says so
      // explicitly. A 503 from a proxy or load balancer is transient and must
      // stay retryable — treating every 503 as "not configured" would pause
      // sync permanently over a momentary upstream hiccup.
      if (body.reason === "not-configured") {
        return { ok: false, failure: { kind: "not-configured", message } };
      }
      return { ok: false, failure: { kind: "server", message, status: 503 } };
    case 404:
      return { ok: false, failure: { kind: "not-found", message } };
    case 400:
      return {
        ok: false,
        failure: {
          kind: "invalid",
          message,
          errors: Array.isArray(body.errors) ? (body.errors as string[]) : [],
        },
      };
    case 409:
      if (body.reason === "stale-base") {
        return {
          ok: false,
          failure: { kind: "stale-base", message, serverCursor: String(body.serverCursor ?? "0") },
        };
      }
      if (body.reason === "already-exists") {
        return {
          ok: false,
          failure: { kind: "already-exists", message, serverCursor: String(body.serverCursor ?? "0") },
        };
      }
      return {
        ok: false,
        failure: {
          kind: "conflict",
          message,
          serverCursor: String(body.serverCursor ?? "0"),
          conflicts: Array.isArray(body.conflicts) ? body.conflicts : [],
        },
      };
    default:
      return { ok: false, failure: { kind: "server", message, status: response.status } };
  }
}

/**
 * Uploads a whole workspace.
 *
 * `knownCursor` is what makes a retry safe. On a first attempt it is null.
 * If the response is lost and the caller retries, it passes the cursor it
 * recorded — the server recognises the retry and updates in place rather
 * than refusing or duplicating. Ids are the client's own throughout, so
 * "update in place" means exactly the same rows.
 *
 * The caller must have already run legacy migration if the workspace needs
 * it; this sends what it is given, and the server rejects non-UUID ids.
 */
export async function initialSync(
  input: { workspace: Workspace; collections: readonly Collection[]; dependencies: readonly TabDependency[] },
  knownCursor: SyncCursor | null
): Promise<SyncResult<InitialSyncValue>> {
  const result = await request("/api/sync/initial", {
    method: "POST",
    body: JSON.stringify({
      workspace: toWorkspacePayload(input.workspace),
      upserts: buildWorkspaceUpserts(input),
      knownCursor,
    }),
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: { cursor: String(result.value.cursor ?? "0"), created: result.value.created === true },
  };
}

/** One workspace as discovery reports it: enough to name it and adopt it, and nothing else. */
export type DiscoveredWorkspace = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * The workspaces this account owns on the server.
 *
 * Metadata only — the contents arrive through the ordinary paged pull
 * during adoption. A malformed row is dropped rather than failing the
 * whole list: one bad record must not stop a user seeing the rest.
 */
export async function discoverWorkspaces(): Promise<SyncResult<DiscoveredWorkspace[]>> {
  const result = await request("/api/sync/workspaces", { method: "GET" });
  if (!result.ok) return result;

  const rows = Array.isArray(result.value.workspaces) ? result.value.workspaces : [];
  const workspaces: DiscoveredWorkspace[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as Record<string, unknown>;
    if (typeof entry.id !== "string") continue;
    workspaces.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : "",
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
    });
  }
  return { ok: true, value: workspaces };
}

export async function pushChanges(
  workspaceId: string,
  baseCursor: SyncCursor,
  upserts: SyncUpsert[],
  deletes: SyncEntityRef[]
): Promise<SyncResult<PushValue>> {
  const result = await request("/api/sync/push", {
    method: "POST",
    body: JSON.stringify({ workspaceId, baseCursor, upserts, deletes }),
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      cursor: String(result.value.cursor ?? baseCursor),
      accepted: Array.isArray(result.value.accepted) ? (result.value.accepted as SyncChange[]) : [],
    },
  };
}

export async function pullChanges(
  workspaceId: string,
  cursor: SyncCursor
): Promise<SyncResult<SyncChangesPage>> {
  const query = new URLSearchParams({ workspaceId, cursor });
  const result = await request(`/api/sync/pull?${query.toString()}`, { method: "GET" });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      workspaceId: String(result.value.workspaceId ?? workspaceId),
      changes: Array.isArray(result.value.changes) ? (result.value.changes as SyncChange[]) : [],
      nextCursor: String(result.value.nextCursor ?? cursor),
      hasMore: result.value.hasMore === true,
    },
  };
}
