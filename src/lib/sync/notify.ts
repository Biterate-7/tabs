/**
 * How collection and dependency mutations reach the sync engine.
 *
 * Tabs, sections and groups live inside `WorkspaceStore` and therefore pass
 * through `commitStore`, where Phase 5 diffs them. Collections and
 * dependencies do not: they have their own localStorage blobs behind
 * `useCollectionStore` / `useDependencyStore`, which are mounted deep in the
 * tree (WorkspaceView or GraphView) and are documented to have exactly one
 * live instance at a time — a second reactive instance would race on the same
 * key through its own debounced writer.
 *
 * So rather than hoisting those stores (which would create that race) or
 * threading a callback through two large components, a mutation publishes a
 * small event here and the engine subscribes. A framework-free emitter, in
 * keeping with the rest of the sync layer.
 *
 *
 * ## What is published
 *
 * Identity and intent only — never payloads. The engine reads current state
 * from the stores at sync time, exactly as it already does, so an event says
 * "this entity changed" and nothing more. That is what keeps the queue
 * coalescing: twenty events for one collection are one dirty entry and
 * therefore one upsert.
 *
 * Publishing happens in an action handler, never inside a React state
 * updater. Phase 2.5 exists to keep side effects out of updaters, and an
 * updater React evaluates twice would publish twice.
 *
 *
 * ## Remote application does not publish
 *
 * Only local mutations call this. Applying a pulled change writes through a
 * different path (the engine's own apply step), so a remote change cannot
 * enqueue itself for upload — the same no-loop guarantee `CommitOrigin`
 * provides for workspace data, achieved here by simply never publishing from
 * the remote path.
 */

/** A local mutation worth synchronizing. `deleted` distinguishes a tombstone from an upsert. */
export type SyncDirtyEvent =
  | { entityType: "collection"; entityId: string; workspaceId: string; deleted: boolean }
  | { entityType: "dependency"; parentTabId: string; childTabId: string; deleted: boolean };

type Listener = (events: readonly SyncDirtyEvent[]) => void;

const listeners = new Set<Listener>();

/**
 * Announces local mutations.
 *
 * Never throws into the caller: a mutation has already been applied to local
 * state by the time this runs, and a failure in sync bookkeeping must not
 * surface as a failed edit. Same reasoning as the try/catch around
 * `notifyLocalCommit` in app-shell.
 */
export function publishSyncDirty(events: readonly SyncDirtyEvent[]): void {
  if (events.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(events);
    } catch {
      // One bad subscriber must not stop the others, and must not reach the
      // user's edit.
    }
  }
}

/** Returns an unsubscribe, so a caller can clean up on unmount. */
export function subscribeSyncDirty(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The reverse direction: state the engine pulled from the server, handed
 * back to whichever store owns it.
 *
 * The engine cannot write these blobs itself. Each store's hook loads once on
 * mount, keeps the value in React state, and persists it through its own
 * debounced effect — so a write straight to localStorage would be silently
 * clobbered by that effect the next time anything changed. Publishing instead
 * keeps the hook the single writer, which is the invariant its doc comment
 * already depends on.
 *
 * A store applying one of these must NOT publish a dirty event in response.
 * The value came from the server; re-marking it would push it straight back.
 * That is the same no-loop rule `CommitOrigin` enforces for workspace data,
 * expressed here as "the remote channel never feeds the local channel".
 */
export type RemoteEntitiesEvent = {
  collections?: readonly CollectionLike[];
  dependencies?: readonly DependencyLike[];
};

/** Structural, so this module stays free of domain imports and cycles. */
type CollectionLike = { id: string; workspaceId: string };
type DependencyLike = { id: string; parentTabId: string; childTabId: string };

type RemoteListener = (event: RemoteEntitiesEvent) => void;

const remoteListeners = new Set<RemoteListener>();

export function publishRemoteEntities(event: RemoteEntitiesEvent): void {
  if (!event.collections && !event.dependencies) return;
  for (const listener of remoteListeners) {
    try {
      listener(event);
    } catch {
      // A failing subscriber must not abort the sync pass that produced this.
    }
  }
}

export function subscribeRemoteEntities(listener: RemoteListener): () => void {
  remoteListeners.add(listener);
  return () => {
    remoteListeners.delete(listener);
  };
}

/** Test seam: drops every subscriber, so one test cannot leak into the next. */
export function __resetSyncDirtyListenersForTests(): void {
  listeners.clear();
  remoteListeners.clear();
}
