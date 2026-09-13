/**
 * The synchronization engine.
 *
 * Framework-independent: no React, no rendering, no reducer. It observes
 * state that has ALREADY been committed locally and talks to the API. The
 * local-first path is untouched —
 *
 *   reducer → commitStore → local persistence → [markDirty] → engine
 *
 * — and `markDirty` is a notification, not a step the commit depends on.
 * Nothing here can fail a local commit, and nothing here is called from
 * inside a reducer or a React state updater.
 *
 *
 * ## The order, and why the cursor moves last
 *
 *   push local changes → record what the server accepted
 *   → pull remote changes → apply them locally → persist workspace
 *   → only then persist the cursor
 *
 * The cursor is the client's promise that it has *incorporated* everything
 * up to that point. Advancing it before the local apply succeeded would make
 * the device skip those changes forever — the next pull starts after them.
 * So the cursor is written only after the workspace it describes has been
 * committed, and any failure in between leaves the old cursor in place and
 * the work simply repeats. Repeating is safe; skipping is not.
 *
 *
 * ## Loop prevention
 *
 * Remote changes are committed through the same local seam as everything
 * else, which would ordinarily mark them dirty and push them straight back.
 * The commit callback therefore carries an origin, and a remote-origin
 * commit marks nothing. That is a structural distinction rather than a flag
 * someone has to remember, and it is pinned by a test.
 */

import { discoverWorkspaces, initialSync, pullChanges, pushChanges } from "./client";
import type { DiscoveredWorkspace, SyncFailure } from "./client";
import { applyChanges } from "./apply";
import type { LocalSyncState } from "./apply";
import { buildPush, refKey } from "./diff";
import type { DirtyRef } from "./diff";
import type { PausedReason } from "./journal";
import { buildConflict, resolveKeepRemote } from "./conflicts";
import type { ConflictPayload, LocalSyncConflict } from "./conflicts";
import {
  addDirty,
  backoffDelayMs,
  clearDirty,
  forgetJournal,
  getJournal,
  loadJournalStore,
  saveJournalStore,
  setJournal,
} from "./journal";
import type { SyncJournalStore, SyncStatus, WorkspaceJournal } from "./journal";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Workspace } from "@/lib/workspace/types";
import type { SyncChange, SyncCursor } from "./types";
import { SYNC_CURSOR_START } from "./types";
import { publishRemoteEntities } from "./notify";
import type { SyncDirtyEvent } from "./notify";

/** What the engine needs from the application, so it never reaches into React or storage itself. */
export type SyncEngineHost = {
  /** The signed-in user, or null. Sync is paused entirely when null. */
  getUserId(): string | null;
  /** Current committed state for one workspace, or null if it no longer exists locally. */
  getWorkspace(workspaceId: string): Workspace | null;
  getCollections(workspaceId: string): Collection[];
  getDependencies(workspaceId: string): TabDependency[];
  /** Every workspace id this device holds locally. */
  getWorkspaceIds(): string[];
  /**
   * Commits a workspace that changed because of REMOTE data.
   *
   * Goes through the application's ordinary local persistence seam — the
   * engine never writes workspace data to localStorage itself — but is
   * flagged as remote-origin so it does not come back as a new local
   * mutation.
   */
  commitRemote(workspace: Workspace): void;
  /** Optional development logging. Never receives payloads, tokens or cookies. */
  log?(event: string, detail?: Record<string, string | number | boolean>): void;
};

export type SyncOutcome =
  | { ok: true; status: SyncStatus; cursor: SyncCursor; pushed: number; pulled: number; conflicts: number }
  | { ok: false; status: SyncStatus; reason: string };

export type SyncEngineOptions = {
  /** How long to wait after the last local edit before pushing. Coalesces rapid edits into one request. */
  debounceMs?: number;
  /** How many workspaces may sync at once. Bounded so twenty workspaces do not become twenty simultaneous requests. */
  concurrency?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

const DEFAULT_DEBOUNCE_MS = 800;
const DEFAULT_CONCURRENCY = 3;

/**
 * Failures worth trying again. A 400 or a 401 will fail identically forever,
 * so retrying them is only noise.
 *
 * 429 is retryable, deliberately. The sync gate shares the auth rate
 * limiter, so a device holding several workspaces can rate-limit itself on a
 * reconnect burst. A 429 means "later", never "never" — treating it as
 * permanent would strand a pending edit in `error` until some unrelated
 * trigger happened to fire. It arms the same bounded, jittered backoff a 5xx
 * gets, so a rate-limited client backs further off each time rather than
 * hammering the limit that just rejected it.
 */
function isRetryable(failure: SyncFailure): boolean {
  if (failure.kind === "offline") return true;
  if (failure.kind !== "server") return false;
  return failure.status === 429 || failure.status >= 500;
}

function statusFor(failure: SyncFailure): SyncStatus {
  switch (failure.kind) {
    case "offline":
      return "offline";
    case "unauthenticated":
      return "paused";
    case "not-configured":
      return "paused";
    case "conflict":
      return "conflict";
    // The server already holds this workspace. Nothing disagrees and
    // nothing failed — there is simply work to do, and it is adoption
    // rather than upload. `migrateWorkspace` normally intercepts this
    // before it reaches here; the case exists so that no path can ever
    // turn it into a conflict by falling through to the default.
    case "already-exists":
      return "queued";
    default:
      return "error";
  }
}

export class SyncEngine {
  private host: SyncEngineHost;
  private readonly debounceMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private store: SyncJournalStore;
  /** In-flight sync per workspace — the per-workspace lock. */
  private readonly inFlight = new Map<string, Promise<SyncOutcome>>();
  /** Workspaces that asked to sync while one was already running, so the work is not lost. */
  private readonly rerun = new Set<string>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(host: SyncEngineHost, options: SyncEngineOptions = {}) {
    this.host = host;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.store = loadJournalStore();
  }

  /**
   * Replaces the host.
   *
   * The engine outlives any single render, but the values it reads (the
   * committed store, the signed-in user) change. A caller refreshes them by
   * handing over a new host rather than the engine reaching into React —
   * which keeps the engine free of framework concerns and keeps the binding
   * free of mutating anything React handed it.
   */
  setHost(host: SyncEngineHost): void {
    this.host = host;
  }

  // ---- state access -------------------------------------------------------

  /**
   * One workspace's journal.
   *
   * The returned object must be REFERENTIALLY STABLE between changes: a UI
   * subscribing through useSyncExternalStore compares snapshots by identity,
   * and minting a fresh default on every call would loop forever. Stored
   * entries are already stable (update() only creates a new object when
   * something changed), so only the absent cases need caching.
   */
  getState(workspaceId: string): WorkspaceJournal {
    const userId = this.host.getUserId();
    if (!userId) return this.cachedPlaceholder(workspaceId, "paused");
    const stored = getJournal(this.store, userId, workspaceId);
    if (this.store.userId === userId && this.store.workspaces[workspaceId]) return stored;
    return this.cachedPlaceholder(workspaceId, "never-synced");
  }

  private readonly placeholders = new Map<string, WorkspaceJournal>();

  private cachedPlaceholder(workspaceId: string, status: SyncStatus): WorkspaceJournal {
    const key = `${workspaceId}:${status}`;
    const existing = this.placeholders.get(key);
    if (existing) return existing;
    const created = { ...defaultFor(workspaceId), status };
    this.placeholders.set(key, created);
    return created;
  }

  /** Subscription for a UI layer. Returns an unsubscribe, so a caller can clean up. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private update(workspaceId: string, change: (journal: WorkspaceJournal) => WorkspaceJournal): WorkspaceJournal {
    const userId = this.host.getUserId();
    if (!userId) return defaultFor(workspaceId);
    const next = change(getJournal(this.store, userId, workspaceId));
    this.store = setJournal(this.store, userId, next);
    saveJournalStore(this.store);
    this.emit();
    return next;
  }

  // ---- scheduling ---------------------------------------------------------

  /**
   * Records that a workspace changed locally, and schedules a sync.
   *
   * Called after a local commit has already succeeded. It never throws — a
   * caller wraps it in try/catch anyway, but the engine must not rely on
   * that to keep a local commit safe.
   *
   * A workspace that has never been synced is marked dirty but NOT uploaded.
   * Absence on the server is not permission to upload; that decision belongs
   * to the explicit initial migration.
   */
  markDirty(workspaceId: string, refs: readonly DirtyRef[]): void {
    if (refs.length === 0) return;
    const userId = this.host.getUserId();
    if (!userId) return;

    const journal = this.update(workspaceId, (current) => {
      const withDirty = addDirty(current, refs);
      if (withDirty.status === "never-synced" || withDirty.status === "conflict") return withDirty;
      return { ...withDirty, status: "queued" };
    });

    if (journal.status === "never-synced") return;
    this.scheduleDebounced(workspaceId);
  }

  /**
   * Records collection and dependency mutations published by their stores.
   *
   * Those two live outside `WorkspaceStore` and so never pass through
   * `commitStore`'s diff — see src/lib/sync/notify.ts for why hoisting their
   * hooks was not an option. The events carry identity and intent only; the
   * payload is read from the stores at push time like everything else, which
   * is what keeps repeated edits to one entity collapsing into one upsert.
   *
   * A dependency names no workspace (its store is flat and global), so the
   * owning workspace is resolved from its parent tab. An unresolvable one is
   * dropped rather than guessed: scheduling against the wrong workspace would
   * push a relationship into a workspace that does not own it.
   */
  markEntitiesDirty(events: readonly SyncDirtyEvent[]): void {
    if (events.length === 0) return;
    if (!this.host.getUserId()) return;

    const byWorkspace = new Map<string, DirtyRef[]>();
    const add = (workspaceId: string, ref: DirtyRef) => {
      const list = byWorkspace.get(workspaceId);
      if (list) list.push(ref);
      else byWorkspace.set(workspaceId, [ref]);
    };

    for (const event of events) {
      if (event.entityType === "collection") {
        add(event.workspaceId, {
          ref: { entityType: "collection", entityId: event.entityId },
          deleted: event.deleted,
        });
        continue;
      }
      const workspaceId = this.workspaceOfTab(event.parentTabId);
      if (!workspaceId) continue;
      add(workspaceId, {
        ref: { entityType: "dependency", parentTabId: event.parentTabId, childTabId: event.childTabId },
        deleted: event.deleted,
      });
    }

    for (const [workspaceId, refs] of byWorkspace) this.markDirty(workspaceId, refs);
  }

  /** Which workspace holds this tab, if any. Dependencies are workspace-scoped server-side but not locally. */
  private workspaceOfTab(tabId: string): string | null {
    for (const workspaceId of this.host.getWorkspaceIds()) {
      const workspace = this.host.getWorkspace(workspaceId);
      if (workspace?.tabs.some((tab) => tab.id === tabId)) return workspaceId;
    }
    return null;
  }

  private scheduleDebounced(workspaceId: string): void {
    const existing = this.debounceTimers.get(workspaceId);
    if (existing) this.clearTimeoutFn(existing);
    const timer = this.setTimeoutFn(() => {
      this.debounceTimers.delete(workspaceId);
      void this.syncWorkspace(workspaceId);
    }, this.debounceMs);
    this.debounceTimers.set(workspaceId, timer);
  }

  /**
   * Picks work back up after a sign-in.
   *
   * A 401 parks a workspace in `paused` with its pending edits intact, and
   * `syncAll` deliberately skips that status — retrying while the session is
   * still dead is pointless noise. But nothing else cleared it, so once the
   * user signed back in the pending work sat there until they happened to
   * edit that workspace again or pressed sync by hand. This is the "until
   * sign-in" half of that promise.
   *
   * Only the authentication pause is lifted. A workspace paused because the
   * deployment has no database configured is left alone: signing in changes
   * nothing about it, and retrying it here is the retry loop that `paused`
   * exists to prevent.
   *
   * Called on sign-in rather than on every trigger, so a session that is
   * still expired produces one attempt per sign-in, never a poll.
   */
  resumeAuthPaused(): void {
    const userId = this.host.getUserId();
    if (!userId || this.store.userId !== userId) return;

    let resumed = false;
    for (const [workspaceId, journal] of Object.entries(this.store.workspaces)) {
      if (journal.status !== "paused") continue;
      if (journal.pausedReason === "not-configured") continue;
      if (journal.dirty.length === 0) continue;
      this.update(workspaceId, (current) => ({ ...current, status: "queued", pausedReason: undefined }));
      resumed = true;
    }
    if (resumed) this.syncAll();
  }

  /**
   * Syncs every workspace that has work to do.
   *
   * What a reconnect, a focus or the timer calls. Deliberately not a burst:
   * the per-workspace lock coalesces repeats and runWithSlot bounds how many
   * run at once, so twenty workspaces do not become twenty simultaneous
   * requests. A conflicted workspace is skipped — it waits for the user, and
   * must not block the others.
   */
  syncAll(): void {
    for (const workspaceId of this.workspacesWithWork()) {
      const state = this.getState(workspaceId);
      if (state.status === "never-synced" || state.status === "conflict" || state.status === "paused") continue;
      if (state.status === "remote-deleted") continue;
      if (state.retryAfter !== undefined && this.now() < state.retryAfter) continue;
      void this.syncWorkspace(workspaceId);
    }
  }

  /**
   * Every workspace a pass should consider.
   *
   * The local ones, plus any the journal still holds a pending DELETION
   * for. A deleted workspace is no longer in the local list, so without
   * this a deletion interrupted by a reload would never be sent — the
   * workspace would stay on the server and come back through discovery.
   * Only deletions qualify: every other kind of pending work needs a local
   * workspace to read, and there is none.
   */
  private workspacesWithWork(): string[] {
    // Copied rather than appended to: the array came from the host, and
    // growing something it handed over is not this method's business.
    const ids = [...this.host.getWorkspaceIds()];
    const userId = this.host.getUserId();
    if (!userId || this.store.userId !== userId) return ids;

    const seen = new Set(ids);
    for (const [workspaceId, journal] of Object.entries(this.store.workspaces)) {
      if (seen.has(workspaceId)) continue;
      const pendingDeletion = journal.dirty.some(
        (entry) => entry.ref.entityType === "workspace" && entry.deleted
      );
      if (pendingDeletion) ids.push(workspaceId);
    }
    return ids;
  }

  /**
   * Syncs one workspace, coalescing concurrent requests.
   *
   * A second call while one is running does not start a second sync; it
   * marks the workspace for one more pass afterwards. That single rerun is
   * enough however many callers asked, because the work is defined by
   * current state rather than by a queue of requests.
   */
  syncWorkspace(workspaceId: string): Promise<SyncOutcome> {
    const active = this.inFlight.get(workspaceId);
    if (active) {
      this.rerun.add(workspaceId);
      return active;
    }

    const run = this.runWithSlot(workspaceId).finally(() => {
      this.inFlight.delete(workspaceId);
      if (this.rerun.delete(workspaceId)) {
        const journal = this.getState(workspaceId);
        if (journal.dirty.length > 0 && journal.status !== "conflict" && journal.status !== "paused" && journal.status !== "remote-deleted") {
          void this.syncWorkspace(workspaceId);
        }
      }
    });

    this.inFlight.set(workspaceId, run);
    return run;
  }

  /** Bounded concurrency across workspaces: one conflicted or slow workspace must not stall the others, and twenty must not fire at once. */
  private async runWithSlot(workspaceId: string): Promise<SyncOutcome> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await this.runSync(workspaceId);
    } finally {
      this.running--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  // ---- the sync itself ----------------------------------------------------

  private async runSync(workspaceId: string): Promise<SyncOutcome> {
    const userId = this.host.getUserId();
    if (!userId) return { ok: false, status: "paused", reason: "Not signed in." };

    let journal = this.getState(workspaceId);

    if (journal.status === "never-synced") {
      // Never uploaded. Waiting for the explicit migration is the whole
      // point — see migrateWorkspace below.
      return { ok: false, status: "never-synced", reason: "This workspace hasn't been synced yet." };
    }
    if (journal.retryAfter !== undefined && this.now() < journal.retryAfter) {
      return { ok: false, status: journal.status, reason: "Waiting before the next attempt." };
    }

    const workspace = this.host.getWorkspace(workspaceId);
    if (!workspace) {
      // Gone from this device. There is nothing left to push or apply for
      // it EXCEPT the deletion itself, if that is what removed it — and
      // refusing to run at all was how a deleted workspace stayed on the
      // server, to be rediscovered and reinstalled later.
      const deletion = journal.dirty.find(
        (entry) => entry.ref.entityType === "workspace" && entry.deleted
      );
      if (deletion) return await this.pushWorkspaceDeletion(workspaceId, journal);
      return { ok: false, status: journal.status, reason: "Workspace not found locally." };
    }

    this.update(workspaceId, (current) => ({ ...current, status: "syncing" }));
    this.host.log?.("sync:start", { workspaceId, dirty: journal.dirty.length });

    // ---- push ----
    let pushed = 0;
    /** Set when the push was refused as stale, so this pass becomes a catch-up read. */
    let staleBase = false;
    // An entity with an unresolved conflict is deliberately NOT pushed.
    // Its dirty ref is kept so keep-mine can re-send it later, but sending
    // it now would overwrite the server copy the user has not chosen yet —
    // last-writer-wins by the back door, and a direct contradiction of what
    // the conflict UI promises. Everything else in the workspace still goes
    // up, so one contested tab does not hold unrelated edits hostage.
    const held = new Set(
      journal.conflicts.map((conflict) =>
        refKey({ entityType: conflict.entityType, entityId: conflict.entityId })
      )
    );
    const sendable = held.size === 0 ? journal.dirty : journal.dirty.filter((entry) => !held.has(refKey(entry.ref)));

    if (sendable.length > 0) {
      const sent = sendable;
      // Collections and dependencies are read from their own stores at push
      // time, exactly like the workspace: the payload is always current
      // state, never a recorded delta, which is what keeps a retry idempotent.
      const { upserts, deletes } = buildPush(
        workspace,
        sent,
        this.host.getCollections(workspaceId),
        this.host.getDependencies(workspaceId)
      );
      this.host.log?.("sync:push", { workspaceId, upserts: upserts.length, deletes: deletes.length });

      const result = await pushChanges(workspaceId, journal.cursor, upserts, deletes);

      if (!result.ok) {
        // A stale base is the one failure that reading FIXES: this device
        // is simply behind. Ending the pass here would skip the very pull
        // that unblocks it, and the next pass would push the same stale
        // cursor again — so a device that fell behind while holding an
        // edit could never catch up. Record it, then fall through to the
        // pull. The pending work is untouched and goes up on the next
        // pass, against a base this device has actually seen.
        if (result.failure.kind !== "stale-base") {
          return this.handleFailure(workspaceId, result.failure, workspace, journal, sent);
        }
        this.handleFailure(workspaceId, result.failure, workspace, journal, sent);
        staleBase = true;
        journal = this.getState(workspaceId);
      } else {
        pushed = upserts.length + deletes.length;
        // Retire exactly what was sent. Anything the user changed while the
        // request was in flight is still dirty and syncs on the next pass.
        journal = this.update(workspaceId, (current) => ({
          ...clearDirty(current, sent),
          // NOT the cursor yet — see the note at the top of this file. The
          // push moved the server forward, but this device has not yet read
          // and applied whatever else changed.
          failureCount: 0,
          retryAfter: undefined,
          pausedReason: undefined,
          lastError: undefined,
        }));
      }
    }

    // ---- pull ----
    let pulled = 0;
    /** Set when the pull carried this workspace's own tombstone. */
    let remoteDeleted = false;
    let cursor = journal.cursor;
    const journalCursorBeforePull = journal.cursor;
    let hasMore = true;

    while (hasMore) {
      const page = await pullChanges(workspaceId, cursor);
      if (!page.ok) {
        return this.handleFailure(workspaceId, page.failure, workspace, journal, []);
      }

      const { changes, nextCursor } = page.value;
      hasMore = page.value.hasMore;

      if (changes.length > 0) {
        const applied = this.applyRemote(workspaceId, changes);
        if (!applied.ok) {
          // Local application failed. The cursor deliberately stays where it
          // was so the same changes are fetched again rather than skipped.
          return this.fail(workspaceId, "error", applied.reason);
        }
        pulled += applied.applied;
        if (applied.conflicts.length > 0) {
          this.update(workspaceId, (current) => ({
            ...current,
            conflicts: mergeConflicts(current.conflicts, applied.conflicts),
            status: "conflict",
          }));
        }
        if (applied.workspaceDeleted) {
          // A fact about the workspace, not a disagreement inside it. The
          // local copy is untouched and stays that way until the user says
          // otherwise; this pass stops here rather than continuing to sync
          // a workspace the account no longer has.
          remoteDeleted = true;
        }
      }

      // Only now, with the remote state incorporated and committed, does the
      // cursor move.
      cursor = nextCursor;
      journal = this.update(workspaceId, (current) => ({ ...current, cursor }));
      if (changes.length === 0) break;
    }

    const final = this.update(workspaceId, (current) => ({
      ...current,
      status: remoteDeleted
        ? "remote-deleted"
        : current.conflicts.length > 0
          ? "conflict"
          : current.dirty.length > 0
            ? "queued"
            : "idle",
      failureCount: 0,
      retryAfter: undefined,
      pausedReason: undefined,
      lastError: undefined,
      lastSyncedAt: this.now(),
    }));

    // A pass that caught up from a stale base still has the work that was
    // refused. Waiting for a focus or the slow timer to send it would
    // leave an edit sitting unsent for up to a minute, so schedule the
    // follow-up here.
    //
    // This terminates: it only re-arms when the catch-up actually moved
    // the cursor, so each repeat requires real progress, and a conflict
    // stops it outright rather than looping against a decision only the
    // user can make.
    if (staleBase && final.status === "queued" && cursor !== journalCursorBeforePull) {
      this.scheduleDebounced(workspaceId);
    }

    this.host.log?.("sync:success", { workspaceId, pushed, pulled, conflicts: final.conflicts.length });
    return {
      ok: true,
      status: final.status,
      cursor: final.cursor,
      pushed,
      pulled,
      conflicts: final.conflicts.length,
    };
  }

  /**
   * Applies pulled changes through the identity-based apply layer and
   * commits them as remote-origin.
   *
   * Entities with unsynced local edits are withheld by `applyChanges` and
   * come back as conflicts, so a remote change never overwrites work the
   * user has not seen.
   */
  private applyRemote(
    workspaceId: string,
    changes: readonly SyncChange[]
  ): { ok: true; applied: number; conflicts: LocalSyncConflict[]; workspaceDeleted: boolean } | { ok: false; reason: string } {
    const workspace = this.host.getWorkspace(workspaceId);
    if (!workspace) return { ok: false, reason: "Workspace not found locally." };

    const journal = this.getState(workspaceId);
    const dirtyIds = new Set(
      journal.dirty.map((entry) =>
        entry.ref.entityType === "dependency"
          ? `dep-${entry.ref.parentTabId}::${entry.ref.childTabId}`
          : entry.ref.entityId
      )
    );

    try {
      // Captured so the apply's output can be compared against what went in:
      // applyChanges returns the same array reference when it changed nothing,
      // which is how an untouched store is left alone.
      const collections = this.host.getCollections(workspaceId);
      const dependencies = this.host.getDependencies(workspaceId);
      const result = applyChanges({ workspace, collections, dependencies }, changes, dirtyIds);

      // Remote-origin: committed through the app's own seam, and explicitly
      // not marked dirty. This is what stops a pull from becoming a push.
      this.host.commitRemote(result.state.workspace);

      // Collections and dependencies live in their own stores, so they are
      // handed back to whichever hook owns them rather than written here —
      // see notify.ts. Published only when the apply actually changed them,
      // so an ordinary tab-only pull does not disturb those stores at all.
      const collectionsChanged = result.state.collections !== collections;
      const dependenciesChanged = result.state.dependencies !== dependencies;
      if (collectionsChanged || dependenciesChanged) {
        publishRemoteEntities({
          ...(collectionsChanged ? { collections: { workspaceId, items: result.state.collections } } : {}),
          ...(dependenciesChanged ? { dependencies: result.state.dependencies } : {}),
        });
      }

      const conflicts = result.conflicts.map((conflict) => {
        const remote = remotePayloadFor(changes, conflict.entityType, conflict.entityId);
        return buildConflict({
          workspaceId,
          entityType: conflict.entityType as LocalSyncConflict["entityType"],
          entityId: conflict.entityId,
          reason: remote === null ? "local-edit-remote-delete" : "changed-since-base",
          workspace,
          remote,
          baseCursor: journal.cursor,
          serverCursor: journal.cursor,
          now: this.now(),
        });
      });

      return { ok: true, applied: result.applied, conflicts, workspaceDeleted: result.workspaceDeleted };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Couldn't apply remote changes." };
    }
  }

  /**
   * Records a failure, deciding whether it is worth another attempt.
   *
   * A 409 becomes durable conflicts built from the server's report plus the
   * local state, so both versions survive and the user can choose. Nothing
   * about a failure discards a dirty ref: pending local work is preserved
   * across every failure path, which is what keeps an outage from costing an
   * edit.
   */
  private handleFailure(
    workspaceId: string,
    failure: SyncFailure,
    /** Null when the workspace is gone from this device — a pending deletion has no local side to conflict with. */
    workspace: Workspace | null,
    journal: WorkspaceJournal,
    sent: readonly DirtyRef[]
  ): SyncOutcome {
    const status = statusFor(failure);

    if (failure.kind === "conflict" && workspace !== null) {
      const conflicts = (failure.conflicts as ServerConflict[]).flatMap((entry) => {
        if (typeof entry?.entityId !== "string" || typeof entry?.entityType !== "string") return [];
        if (entry.entityType === "collection" || entry.entityType === "dependency") return [];
        return [
          buildConflict({
            workspaceId,
            entityType: entry.entityType as LocalSyncConflict["entityType"],
            entityId: entry.entityId,
            reason: entry.reason === "locked-section" ? "locked-section" : "changed-since-base",
            workspace,
            // The server reports identity and versions, not its payload; the
            // next pull fills the remote side in.
            remote: null,
            baseCursor: entry.baseCursor ?? journal.cursor,
            serverCursor: entry.serverCursor ?? failure.serverCursor,
            now: this.now(),
          }),
        ];
      });

      this.update(workspaceId, (current) => ({
        ...current,
        // Dirty refs are deliberately kept: the local version is still the
        // user's, and resolving keep-local must be able to re-send it.
        conflicts: mergeConflicts(current.conflicts, conflicts),
        status: "conflict",
        lastError: failure.message,
      }));
      this.host.log?.("sync:conflict", { workspaceId, count: conflicts.length });
      return { ok: false, status: "conflict", reason: failure.message };
    }

    if (failure.kind === "stale-base") {
      // Not an error and not a conflict: this device is simply behind. Keep
      // everything pending and let the next pass pull first.
      this.update(workspaceId, (current) => ({ ...current, status: "queued", lastError: undefined }));
      void sent;
      return { ok: false, status: "queued", reason: failure.message };
    }

    const retryable = isRetryable(failure);
    // Which of the two pauses this is. Kept so a later sign-in can pick up
    // the work behind an expired session without also re-attempting a
    // deployment that has no database to talk to.
    const pausedReason: PausedReason | undefined =
      status === "paused" ? (failure.kind === "not-configured" ? "not-configured" : "unauthenticated") : undefined;
    this.update(workspaceId, (current) => {
      const failureCount = retryable ? current.failureCount + 1 : current.failureCount;
      return {
        ...current,
        status,
        failureCount,
        ...(retryable ? { retryAfter: this.now() + backoffDelayMs(failureCount, Math.random) } : {}),
        pausedReason,
        lastError: failure.message,
      };
    });
    this.host.log?.("sync:error", { workspaceId, kind: failure.kind, retryable });
    return { ok: false, status, reason: failure.message };
  }

  /** Drops a workspace's journal entry, for one that no longer exists on either side. */
  private forget(workspaceId: string): void {
    const userId = this.host.getUserId();
    if (!userId) return;
    this.store = forgetJournal(this.store, userId, workspaceId);
    saveJournalStore(this.store);
    this.emit();
  }

  private fail(workspaceId: string, status: SyncStatus, reason: string): SyncOutcome {
    this.update(workspaceId, (current) => ({
      ...current,
      status,
      failureCount: current.failureCount + 1,
      retryAfter: this.now() + backoffDelayMs(current.failureCount + 1, Math.random),
      lastError: reason,
    }));
    this.host.log?.("sync:error", { workspaceId, reason });
    return { ok: false, status, reason };
  }

  // ---- explicit initial migration ----------------------------------------

  /**
   * Uploads a workspace for the first time. User-initiated, always.
   *
   * Separate from `syncWorkspace` on purpose: an empty server is not
   * permission to upload, and first sign-in must never turn into a silent
   * migration. Only this method can move a workspace out of `never-synced`.
   */
  async migrateWorkspace(workspaceId: string): Promise<SyncOutcome> {
    const userId = this.host.getUserId();
    if (!userId) return { ok: false, status: "paused", reason: "Not signed in." };

    const workspace = this.host.getWorkspace(workspaceId);
    if (!workspace) return { ok: false, status: "error", reason: "Workspace not found locally." };

    const journal = this.getState(workspaceId);
    this.update(workspaceId, (current) => ({ ...current, status: "syncing" }));

    const result = await initialSync(
      {
        workspace,
        collections: this.host.getCollections(workspaceId),
        dependencies: this.host.getDependencies(workspaceId),
      },
      // On a retry this proves the client already uploaded and saw a cursor,
      // so the server updates in place rather than refusing or duplicating.
      journal.status === "never-synced" && journal.cursor === "0" ? null : journal.cursor
    );

    if (!result.ok) {
      // The server already has this workspace under this account. That is
      // not a refusal to be reported — it is the second-device case, and
      // the right operation is the opposite one. Adopting here keeps the
      // single visible action ("sync this workspace") doing the right
      // thing whichever side happens to already hold the data.
      if (result.failure.kind === "already-exists") {
        this.host.log?.("sync:adopting", { workspaceId });
        return this.adoptWorkspace(workspaceId);
      }
      return this.handleFailure(workspaceId, result.failure, workspace, journal, []);
    }

    const final = this.update(workspaceId, (current) => ({
      ...current,
      status: "idle",
      cursor: result.value.cursor,
      dirty: [],
      failureCount: 0,
      retryAfter: undefined,
      pausedReason: undefined,
      lastError: undefined,
      lastSyncedAt: this.now(),
    }));

    this.host.log?.("sync:migrated", { workspaceId, created: result.value.created });
    return { ok: true, status: final.status, cursor: final.cursor, pushed: 1, pulled: 0, conflicts: 0 };
  }

  /**
   * Tells the server about a workspace the user deleted on this device.
   *
   * Separate from the ordinary pass because every other part of it needs a
   * local workspace to read, and this one deliberately has none. There is no
   * pull either: nothing here could apply a change to a workspace that no
   * longer exists locally.
   *
   * The deletion ref stays pending until the server confirms, so closing the
   * tab mid-delete leaves the work to be finished on the next start rather
   * than losing it.
   */
  private async pushWorkspaceDeletion(workspaceId: string, journal: WorkspaceJournal): Promise<SyncOutcome> {
    // Never uploaded, so there is nothing on the server to delete. Keeping
    // the ref would mean carrying a mutation that can never apply.
    if (journal.status === "never-synced") {
      this.forget(workspaceId);
      return { ok: true, status: "never-synced", cursor: journal.cursor, pushed: 0, pulled: 0, conflicts: 0 };
    }

    this.update(workspaceId, (current) => ({ ...current, status: "syncing" }));
    this.host.log?.("sync:delete-workspace", { workspaceId });

    const result = await pushChanges(workspaceId, journal.cursor, [], [
      { entityType: "workspace", entityId: workspaceId },
    ]);

    if (!result.ok) {
      // Already gone server-side: the outcome the user asked for is the
      // outcome that holds, so stop asking for it.
      if (result.failure.kind === "not-found") {
        this.update(workspaceId, (current) => ({ ...current, dirty: [], status: "idle", lastError: undefined }));
        return { ok: true, status: "idle", cursor: journal.cursor, pushed: 1, pulled: 0, conflicts: 0 };
      }
      // Someone else moved the workspace on. Take their cursor and let the
      // next pass re-send the deletion against it. Not a pull-and-apply:
      // there is no local workspace left to apply anything to, and the user
      // has already said this workspace should not exist.
      if (result.failure.kind === "stale-base") {
        const serverCursor = result.failure.serverCursor;
        this.update(workspaceId, (current) => ({
          ...current,
          cursor: serverCursor,
          status: "queued",
          lastError: undefined,
        }));
        return { ok: false, status: "queued", reason: result.failure.message };
      }
      // Everything else keeps the pending deletion and retries on the
      // ordinary schedule.
      return this.handleFailure(workspaceId, result.failure, null, journal, []);
    }

    // Gone from this device and gone from the server, so the bookkeeping
    // has nothing left to describe.
    this.forget(workspaceId);

    this.host.log?.("sync:deleted-workspace", { workspaceId });
    return { ok: true, status: "idle", cursor: result.value.cursor, pushed: 1, pulled: 0, conflicts: 0 };
  }

  // ---- discovery and adoption ---------------------------------------------

  /**
   * The workspaces this account owns on the server.
   *
   * Read-only and side-effect free: it records nothing, adopts nothing and
   * touches no journal. A device with no local data uses it to find out
   * there is something to adopt; everything else ignores it.
   */
  async listRemoteWorkspaces(): Promise<{ ok: true; workspaces: DiscoveredWorkspace[] } | { ok: false; reason: string }> {
    if (!this.host.getUserId()) return { ok: false, reason: "Not signed in." };
    const result = await discoverWorkspaces();
    if (!result.ok) return { ok: false, reason: result.failure.message };
    return { ok: true, workspaces: result.value };
  }

  /**
   * Installs a workspace that already exists on the server onto this device.
   *
   * The second-device path. Reads the whole change stream from the start,
   * applies it in memory, and only then touches anything durable:
   *
   *   pull every page -> apply in memory -> commit workspace
   *   -> publish collections/dependencies -> persist cursor
   *
   * ## Why nothing is committed until every page has arrived
   *
   * A half-installed workspace is worse than none: the user sees a workspace
   * that looks real, missing tabs they cannot tell are missing. So a failure
   * on page three leaves the device exactly as it was — no workspace, no
   * cursor, nothing to clean up — and the operation simply runs again. The
   * cursor moves last, for the same reason it does in `runSync`: it is a
   * promise that everything up to it has been incorporated.
   *
   * ## What it does NOT do
   *
   * It does not overwrite local data. Entities arrive by identity, absence is
   * never deletion, and anything with a pending local edit is withheld and
   * reported as a conflict rather than replaced — the same rules an ordinary
   * pull follows. Adopting onto a device that already has this workspace is
   * therefore a merge, not a replacement.
   *
   * It also does not mark anything dirty. Everything here came from the
   * server, and `commitRemote` plus the remote-entity channel are both
   * remote-origin, so adoption cannot become an upload of what was just
   * downloaded.
   */
  async adoptWorkspace(workspaceId: string): Promise<SyncOutcome> {
    const userId = this.host.getUserId();
    if (!userId) return { ok: false, status: "paused", reason: "Not signed in." };

    const journal = this.getState(workspaceId);
    const existing = this.host.getWorkspace(workspaceId);

    // Pending local work is never discarded by adoption. These ids are
    // withheld from the apply and come back as conflicts, exactly as they
    // would on an ordinary pull.
    const dirtyIds = new Set(
      journal.dirty.map((entry) =>
        entry.ref.entityType === "dependency"
          ? `dep-${entry.ref.parentTabId}::${entry.ref.childTabId}`
          : entry.ref.entityId
      )
    );

    // Dependencies are one flat store spanning every workspace, so the whole
    // list goes in and the whole list comes out. Collections are read per
    // workspace and republished per workspace — see notify.ts.
    let state: LocalSyncState = {
      workspace:
        existing ?? {
          id: workspaceId,
          name: "",
          tabs: [],
          sections: [],
          groups: [],
          createdAt: this.now(),
          updatedAt: this.now(),
        },
      collections: [...this.host.getCollections(workspaceId)],
      dependencies: [...this.host.getDependencies(workspaceId)],
    };

    this.update(workspaceId, (current) => ({ ...current, status: "syncing" }));
    this.host.log?.("sync:adopt-start", { workspaceId, hadLocalCopy: existing !== null });

    let cursor: SyncCursor = SYNC_CURSOR_START;
    let hasMore = true;
    let applied = 0;
    let pages = 0;
    /** The server has to describe the workspace itself, or there is nothing to adopt. */
    let described = existing !== null;
    /**
     * Every entity the server mentioned, so that what it did NOT mention can
     * be told apart afterwards. Anything left over is local-only.
     */
    const seen = {
      tabs: new Set<string>(),
      sections: new Set<string>(),
      groups: new Set<string>(),
      collections: new Set<string>(),
      dependencies: new Set<string>(),
    };
    const conflicts: LocalSyncConflict[] = [];

    while (hasMore) {
      const page = await pullChanges(workspaceId, cursor);
      if (!page.ok) {
        // Nothing durable has happened: no workspace installed, no cursor
        // moved, no store published. The device is untouched.
        return this.handleFailure(workspaceId, page.failure, state.workspace, journal, []);
      }

      const { changes, nextCursor } = page.value;
      hasMore = page.value.hasMore;
      pages++;

      if (changes.some((change) => change.entityType === "workspace" && change.operation === "upsert")) {
        described = true;
      }
      for (const change of changes) {
        switch (change.entityType) {
          case "tab":
            seen.tabs.add(change.entityId);
            break;
          case "section":
            seen.sections.add(change.entityId);
            break;
          case "group":
            seen.groups.add(change.entityId);
            break;
          case "collection":
            seen.collections.add(change.entityId);
            break;
          case "dependency":
            seen.dependencies.add(`${change.parentTabId}::${change.childTabId}`);
            break;
        }
      }

      let result;
      try {
        result = applyChanges(state, changes, dirtyIds);
      } catch (error) {
        return this.fail(
          workspaceId,
          "error",
          error instanceof Error ? error.message : "Couldn't apply that workspace."
        );
      }

      state = result.state;
      applied += result.applied;
      // The server describing this workspace's own tombstone means there
      // is nothing here to adopt.
      if (result.workspaceDeleted) described = false;
      for (const conflict of result.conflicts) {
        if (conflict.entityType === "collection" || conflict.entityType === "dependency") continue;
        conflicts.push(
          buildConflict({
            workspaceId,
            entityType: conflict.entityType as LocalSyncConflict["entityType"],
            entityId: conflict.entityId,
            reason: "changed-since-base",
            workspace: state.workspace,
            remote: null,
            baseCursor: cursor,
            serverCursor: nextCursor,
            now: this.now(),
          })
        );
      }

      cursor = nextCursor;
      if (changes.length === 0) break;
    }

    if (!described) {
      // The account owns no such workspace, or it has been tombstoned. Not an
      // error worth retrying, and emphatically not a reason to install an
      // empty workspace named after an id.
      this.update(workspaceId, (current) => ({
        ...current,
        status: current.dirty.length > 0 ? "queued" : "never-synced",
        lastError: "That workspace isn't on the server.",
      }));
      return { ok: false, status: "never-synced", reason: "That workspace isn't on the server." };
    }

    // Everything arrived. Commit once, in the order runSync uses: local state
    // first, then the cursor that describes it.
    this.host.commitRemote(state.workspace);
    publishRemoteEntities({
      collections: { workspaceId, items: state.collections },
      dependencies: state.dependencies,
    });

    // Anything the server never mentioned exists only on this device. It is
    // not a conflict and it is not remote data — it is local work that has
    // never been uploaded, so it becomes pending and goes up on the next
    // ordinary pass. Without this it would sit in an adopted workspace
    // forever, present locally and invisible everywhere else.
    //
    // Empty for a device adopting onto nothing, which is what keeps a fresh
    // adoption from pushing back everything it just downloaded.
    const localOnly = this.localOnlyRefs(workspaceId, state, seen);

    const final = this.update(workspaceId, (current) => {
      const withPending = localOnly.length > 0 ? addDirty(current, localOnly) : current;
      return {
        ...withPending,
        cursor,
        conflicts: mergeConflicts(withPending.conflicts, conflicts),
        status: conflicts.length > 0 ? "conflict" : withPending.dirty.length > 0 ? "queued" : "idle",
        failureCount: 0,
        retryAfter: undefined,
        pausedReason: undefined,
        lastError: undefined,
        lastSyncedAt: this.now(),
      };
    });

    this.host.log?.("sync:adopted", { workspaceId, applied, pages, conflicts: final.conflicts.length });
    return { ok: true, status: final.status, cursor: final.cursor, pushed: 0, pulled: applied, conflicts: final.conflicts.length };
  }

  /**
   * The entities present locally that the server never described.
   *
   * Deliberately identity-based: "the server did not mention this id" is the
   * only question asked. Nothing is matched by name, URL or content, and
   * nothing is invented — a relationship that was already dangling locally
   * stays exactly as dangling as it was.
   *
   * Dependencies are filtered to this workspace by their parent tab, because
   * their store is flat and global while everything else here is scoped.
   */
  private localOnlyRefs(
    workspaceId: string,
    state: LocalSyncState,
    seen: {
      tabs: Set<string>;
      sections: Set<string>;
      groups: Set<string>;
      collections: Set<string>;
      dependencies: Set<string>;
    }
  ): DirtyRef[] {
    const refs: DirtyRef[] = [];
    const add = (ref: DirtyRef["ref"]) => refs.push({ ref, deleted: false });

    for (const section of state.workspace.sections ?? []) {
      if (!seen.sections.has(section.id)) add({ entityType: "section", entityId: section.id });
    }
    for (const group of state.workspace.groups ?? []) {
      if (!seen.groups.has(group.id)) add({ entityType: "group", entityId: group.id });
    }
    for (const tab of state.workspace.tabs) {
      if (!seen.tabs.has(tab.id)) add({ entityType: "tab", entityId: tab.id });
    }
    for (const collection of state.collections) {
      if (collection.workspaceId !== workspaceId) continue;
      if (!seen.collections.has(collection.id)) add({ entityType: "collection", entityId: collection.id });
    }

    const tabIds = new Set(state.workspace.tabs.map((tab) => tab.id));
    for (const dependency of state.dependencies) {
      // A dependency whose parent is not in this workspace belongs to another
      // one; pushing it here would put a relationship in a workspace that
      // does not own it.
      if (!tabIds.has(dependency.parentTabId)) continue;
      const key = `${dependency.parentTabId}::${dependency.childTabId}`;
      if (seen.dependencies.has(key)) continue;
      add({
        entityType: "dependency",
        parentTabId: dependency.parentTabId,
        childTabId: dependency.childTabId,
      });
    }

    return refs;
  }

  // ---- conflict resolution ------------------------------------------------

  /**
   * Records a resolution.
   *
   * Keep-local marks the entity dirty so it is re-pushed against the
   * server's current cursor — the resolution becomes a real mutation rather
   * than a record quietly deleted. Keep-remote marks nothing, because the
   * value came from the server.
   */
  resolveConflict(workspaceId: string, conflictId: string, choice: "local" | "remote"): void {
    const journal = this.getState(workspaceId);
    const conflict = journal.conflicts.find((c) => c.id === conflictId);
    if (!conflict) return;

    const workspace = this.host.getWorkspace(workspaceId);
    if (!workspace) return;

    if (choice === "remote") {
      if (conflict.remote !== null || conflict.reason === "local-edit-remote-delete") {
        const resolution = resolveKeepRemote(conflict, workspace);
        this.host.commitRemote(resolution.workspace);
      }
      this.update(workspaceId, (current) => {
        const conflicts = current.conflicts.filter((c) => c.id !== conflictId);
        return {
          ...current,
          conflicts,
          // The local edit is abandoned in favour of the server's, so its
          // dirty ref goes too — otherwise it would be re-pushed.
          dirty: current.dirty.filter(
            (entry) => refKey(entry.ref) !== refKey({ entityType: conflict.entityType, entityId: conflict.entityId })
          ),
          status: conflicts.length > 0 ? "conflict" : "queued",
        };
      });
    } else {
      this.update(workspaceId, (current) => {
        const conflicts = current.conflicts.filter((c) => c.id !== conflictId);
        const withDirty = addDirty(current, [
          { ref: { entityType: conflict.entityType, entityId: conflict.entityId }, deleted: conflict.local === null },
        ]);
        return { ...withDirty, conflicts, status: conflicts.length > 0 ? "conflict" : "queued" };
      });
    }

    void this.syncWorkspace(workspaceId);
  }

  /** Drops every timer and listener. Called when the host unmounts, so nothing keeps firing. */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) this.clearTimeoutFn(timer);
    this.debounceTimers.clear();
    this.listeners.clear();
    this.rerun.clear();
  }

  /** Forgets all bookkeeping — used on sign-out so the next account starts clean. */
  reset(): void {
    this.store = loadJournalStore();
    this.emit();
  }
}

type ServerConflict = {
  entityType?: string;
  entityId?: string;
  reason?: string;
  baseCursor?: string;
  serverCursor?: string;
};

function defaultFor(workspaceId: string): WorkspaceJournal {
  return {
    workspaceId,
    status: "never-synced",
    cursor: "0",
    dirty: [],
    conflicts: [],
    failureCount: 0,
  };
}

function mergeConflicts(
  existing: readonly LocalSyncConflict[],
  incoming: readonly LocalSyncConflict[]
): LocalSyncConflict[] {
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const conflict of incoming) {
    const previous = byId.get(conflict.id);
    // A re-detected conflict keeps whichever side is already known rather
    // than replacing a captured payload with null.
    byId.set(
      conflict.id,
      previous
        ? { ...conflict, local: conflict.local ?? previous.local, remote: conflict.remote ?? previous.remote }
        : conflict
    );
  }
  return [...byId.values()];
}

/** The remote payload for an entity, lifted out of the page that was just pulled. */
function remotePayloadFor(
  changes: readonly SyncChange[],
  entityType: string,
  entityId: string
): ConflictPayload | null {
  for (const change of changes) {
    if (change.entityType !== entityType) continue;
    if (change.entityType === "dependency") continue;
    if (change.entityId !== entityId) continue;
    if (change.operation === "delete") return null;
    if (change.entityType === "collection") return null;
    return { entityType: change.entityType, entity: change.entity } as ConflictPayload;
  }
  return null;
}
