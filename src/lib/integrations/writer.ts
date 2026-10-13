import { toCollectionPayload } from "@/lib/sync/serialize";
import { validateCollectionPayload } from "@/lib/sync/validation";
import type { Collection } from "@/lib/collections/types";
import type { HubbleMcpData, McpLoadedWorkspace } from "@/lib/mcp/data";
import type { PushOutcome } from "@/lib/sync/service";
import type { SyncCursor, SyncEntityRef, SyncUpsert } from "@/lib/sync/types";

/**
 * How an AI client's change reaches a workspace: as one more device.
 *
 * ## The established storage model, not a second one
 *
 * Hubble is local-first and the server holds the account-synced copy of each
 * workspace. A connected AI client changes that copy exactly the way a
 * second device does — a `SyncService.push` of whole entity payloads against
 * the cursor it read, in the repository's one transaction under the
 * workspace's row lock — and the person's devices receive it the way they
 * receive any other device's edit: through their ordinary pull, applied by
 * the client's own `applyChanges`. If a device holds an unpushed edit to the
 * same collection, that becomes the existing, visible conflict with both
 * versions kept. Nothing here writes a browser's storage, and nothing could.
 *
 * ## The change itself is the app's
 *
 * The collection change is computed by the same pure reducers the workspace
 * view uses (`applyCollectionBatch`, `createCollection` in
 * src/lib/collections), handed the hydrated collections; this module only
 * decides *against which state* and pushes the result. Every payload is put
 * through the sync layer's own validator first.
 *
 * ## Read, then write only against what was read
 *
 * The cursor is read *before* hydrating, and the push is gated on it. Any
 * commit between the read and the write — another device, another client —
 * makes the push `stale-base`, and the whole decision is taken again on the
 * new state, at most `MAX_ATTEMPTS` times. A change is never applied to a
 * workspace state its decision did not see.
 */

export type SyncWriterBackend = {
  cursorOf(workspaceId: string, userId: string): Promise<SyncCursor | null>;
  push(
    workspaceId: string,
    userId: string,
    baseCursor: SyncCursor,
    upserts: SyncUpsert[],
    deletes: SyncEntityRef[],
    deletedAt: number
  ): Promise<PushOutcome>;
};

export const MAX_ATTEMPTS = 3;

/** The workspace state a decision is taken against, with its version. */
export type WriteBasis = { loaded: McpLoadedWorkspace; version: number; cursor: SyncCursor };

/** What a decision returns: the new collection list, which collections changed, and what to report. */
export type CollectionMutation<T> =
  | { ok: true; collections: Collection[]; touched: readonly string[]; report: (after: WriteBasis | undefined) => T }
  /** Nothing to write (already done, say) — the answer stands without a push. */
  | { ok: true; unchanged: true; report: T }
  | { ok: false; refusal: string; detail?: unknown };

export type WriteOutcome<T> =
  | { ok: true; value: T; cursor?: SyncCursor }
  | { ok: false; reason: "not_found" | "too_large" | "busy" | "conflict" | "invalid_payload" }
  | { ok: false; reason: "refused"; refusal: string; detail?: unknown };

export function versionOf(cursor: SyncCursor): number {
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function loadBasis(
  deps: { data: HubbleMcpData; sync: SyncWriterBackend },
  userId: string,
  workspaceId: string
): Promise<WriteBasis | "not_found" | "too_large"> {
  const cursor = await deps.sync.cursorOf(workspaceId, userId);
  if (cursor === null) return "not_found";
  const loaded = await deps.data.loadWorkspace(userId, workspaceId);
  if (!loaded) return "not_found";
  if (loaded.truncated) return "too_large";
  return { loaded, version: versionOf(cursor), cursor };
}

export async function writeCollections<T>(
  deps: { data: HubbleMcpData; sync: SyncWriterBackend; now: () => number },
  userId: string,
  workspaceId: string,
  decide: (basis: WriteBasis) => CollectionMutation<T>,
  options: { reloadAfter?: boolean } = {}
): Promise<WriteOutcome<T>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const basis = await loadBasis(deps, userId, workspaceId);
    if (basis === "not_found" || basis === "too_large") return { ok: false, reason: basis };

    const mutation = decide(basis);
    if (!mutation.ok) return { ok: false, reason: "refused", refusal: mutation.refusal, detail: mutation.detail };
    if ("unchanged" in mutation) return { ok: true, value: mutation.report };

    const byId = new Map(mutation.collections.map((collection) => [collection.id, collection]));
    const upserts: SyncUpsert[] = [];
    for (const id of new Set(mutation.touched)) {
      const collection = byId.get(id);
      // A collection that vanished from the result would be a deletion, and
      // nothing an AI client can do deletes.
      if (!collection || collection.workspaceId !== workspaceId) return { ok: false, reason: "invalid_payload" };
      const payload = toCollectionPayload(collection);
      if (!validateCollectionPayload(payload).ok) return { ok: false, reason: "invalid_payload" };
      upserts.push({ entityType: "collection", entity: payload });
    }
    if (upserts.length === 0) return { ok: true, value: mutation.report(undefined) };

    const outcome = await deps.sync.push(workspaceId, userId, basis.cursor, upserts, [], deps.now());
    if (outcome.ok) {
      let after: WriteBasis | undefined;
      if (options.reloadAfter) {
        const reloaded = await loadBasis(deps, userId, workspaceId).catch(() => "not_found" as const);
        after = typeof reloaded === "string" ? undefined : reloaded;
      }
      return { ok: true, value: mutation.report(after), cursor: outcome.cursor };
    }
    if (outcome.reason === "not-found") return { ok: false, reason: "not_found" };
    if (outcome.reason === "conflict") return { ok: false, reason: "conflict" };
    // stale-base: something committed since the read. Decide again on what is there now.
  }
  return { ok: false, reason: "busy" };
}
