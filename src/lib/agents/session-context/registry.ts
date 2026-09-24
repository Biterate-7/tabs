import { capabilitiesFor } from "./capabilities";
import { CHANGE_LIMITS, cleanCollectionName } from "./changes";
import { mintContextServerName } from "./identity";
import { canonicalPlan, freezeOperations, planEffect, planStepLine, previewOf, validateWorkspacePlan, verifyWorkspacePlan } from "./plan";
import { readSessionContextSnapshot, snapshotFingerprint } from "./snapshot";
import type { ContextAuthority } from "./authorization";
import type { PlanProblem, PlanVerification, WorkspaceOperation, WorkspacePlanInput, WorkspacePlanPreview } from "./plan";
import type { SessionContextAccess, SessionContextCapability } from "./capabilities";
import type { WorkspaceChange, WorkspaceChangeKind, WorkspaceChangeSummary } from "./changes";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * Which session may see which workspace, through which credential (Phase J.3,
 * extended in J.4).
 *
 * ## One binding per session, fixed at birth
 *
 * A binding ties exactly one agent session to exactly one TabDump workspace,
 * with a capability set chosen when the session starts and a context server
 * *name* minted for it (./identity.ts). None of these can change afterwards:
 * `update` accepts a fresher snapshot of the *same* workspace and refuses any
 * other, and there is no call that widens capabilities. Switching workspaces
 * in the UI therefore never moves an agent — a new session is the only way to
 * point one somewhere else.
 *
 * ## The credential
 *
 * `bind` mints a 256-bit random token and returns it exactly once, to the
 * runtime code that hands it to the agent. Only its SHA-256 hash is kept, in
 * this process's memory. It is never persisted, never sent to the webview,
 * never written to an event. It stops working the moment the binding is
 * released — on dispose, disconnect, a session ending, or runtime shutdown —
 * and a restarted runtime starts with an empty registry, so no credential
 * minted before the restart can ever authenticate again. Even a session that
 * never ends cannot keep one forever: after `CREDENTIAL_MAX_AGE_MS` it is
 * refused and forgotten, and the agent simply loses its workspace context.
 *
 * ## Versions (J.4)
 *
 * Each binding carries a context `version`: 1 at bind, +1 for every accepted
 * snapshot whose content differs. It never goes down and never resets while
 * the session lives. Per tab and per collection, the registry remembers the
 * version at which it last changed (and, bounded, which ones went away), so
 * an agent can ask "what changed since version 7" and get ids, not a dump.
 *
 * ## Plans (J.5)
 *
 * An agent may also propose several changes as one plan (./plan.ts). A plan
 * is validated against the snapshot the session holds, at the version it
 * names — an older version is stale and refused before anyone is asked. The
 * validated operations are frozen, hashed together with the session, the
 * workspace and the version, and put to the user as one approval showing
 * every step. If the workspace changed while the user was deciding, the plan
 * is re-validated and applied only if it would still do exactly what was
 * shown; otherwise it is stale and nothing happens. The Command Centre
 * applies an approved plan all at once, reports the ids it created and the
 * plan's hash (a different hash is refused), and syncs the result — which the
 * registry then checks, operation by operation, against the workspace it now
 * holds. The agent is told what was applied *and* what could be verified.
 *
 * ## Changes
 *
 * A proposed change never touches data here. It becomes an action that waits
 * for a TabDump approval (`approve`, supplied by the host, backed by the
 * control service's broker). An approved action waits again, for the Command
 * Centre — which owns the workspace — to apply it and report back. Only then
 * does the agent's tool call return. A denied, expired or abandoned action
 * changes nothing, and an action completes at most once.
 */

export const CONTEXT_TOKEN_PREFIX = "tdctx_";

/**
 * The longest a context credential works, whatever the session does. Long
 * enough for a working day, short enough that one left behind by a session
 * that never ended cleanly does not outlive it by much.
 */
export const CREDENTIAL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** How long an approved action may wait for the Command Centre to apply it. */
export const APPLY_TIMEOUT_MS = 60_000;

/** Removed tabs and collections remembered per session, for `changesSince`. Older removals are summarized as "incomplete". */
export const MAX_REMEMBERED_REMOVALS = 2000;

/** Most ids `changesSince` returns per list. */
export const MAX_CHANGE_IDS = 100;

/** Plan outcomes remembered per session, newest last, for the Command Centre. */
export const MAX_PLAN_OUTCOMES = 10;

export type ApprovalOutcome = "granted" | "denied" | "expired" | "cancelled";

export type ContextApprovalRequest = {
  sessionId: string;
  workspaceId: string;
  actionId: string;
  /** A single change (J.3–J.4). Absent for a plan, which carries every step in `plan`. */
  change?: WorkspaceChangeSummary;
  /** A plan (J.5): every step, as the user will read it. */
  plan?: WorkspacePlanPreview;
  /** The same change as plain lines, for surfaces that show a list. */
  targets: readonly string[];
  reason: string;
};

export type ContextApprover = (request: ContextApprovalRequest) => Promise<ApprovalOutcome>;

export type ContextActionStatus =
  | "awaiting_approval"
  | "approved"
  | "applied"
  | "denied"
  | "expired"
  | "failed"
  | "cancelled";

/** An approved plan, exactly as it will be applied: frozen, and bound by hash to its session, workspace and version. */
export type PendingPlan = {
  planId: string;
  hash: string;
  basedOnVersion: number;
  operations: readonly WorkspaceOperation[];
  preview: WorkspacePlanPreview;
};

export type ContextAction = {
  id: string;
  sessionId: string;
  workspaceId: string;
  /** A single change (J.3–J.4). Exactly one of `change` and `plan` is set. */
  change?: WorkspaceChange;
  /** A plan of several changes (J.5). */
  plan?: PendingPlan;
  status: ContextActionStatus;
  requestedAt: number;
  collectionId?: string;
};

export type ContextChangeFailure = "denied" | "expired" | "invalid" | "ended" | "not_applied" | "not_permitted";

export type ContextChangeResult =
  | { ok: true; kind: WorkspaceChangeKind; collectionId: string; name: string; tabCount: number }
  | { ok: false; reason: ContextChangeFailure };

export type PlanResultEntry = PlanVerification["results"][number] & { line: string };

/** How a plan ended, as the agent is told. */
export type ContextPlanResult =
  | {
      ok: true;
      planId: string;
      basedOnVersion: number;
      /** The version the session holds after the Command Centre synced the result. */
      contextVersion: number;
      /** Every operation's result was found in the synced workspace. */
      verified: boolean;
      results: readonly PlanResultEntry[];
    }
  | { ok: false; reason: "invalid"; problems: readonly PlanProblem[]; currentVersion: number }
  | { ok: false; reason: "stale"; currentVersion: number }
  | { ok: false; reason: "not_applied"; failedAt?: number }
  | { ok: false; reason: "denied" | "expired" | "ended" | "not_permitted" };

export type PlanPreviewResult =
  | { ok: true; preview: WorkspacePlanPreview; lines: readonly string[]; canApply: boolean }
  | { ok: false; reason: "invalid"; problems: readonly PlanProblem[]; currentVersion: number }
  | { ok: false; reason: "stale"; currentVersion: number }
  | { ok: false; reason: "ended" };

export type PlanOutcomeStatus = "applied" | "unverified" | "not_applied" | "stale" | "denied" | "expired" | "cancelled";

/** What became of a plan, for the Command Centre's result line. Counts and a version — no ids but the plan's own. */
export type PlanOutcome = {
  planId: string;
  status: PlanOutcomeStatus;
  operationCount: number;
  /** Operations whose result was found in the synced workspace. */
  verifiedCount: number;
  contextVersion: number;
  at: number;
};

/** How the Command Centre reports an action it applied (or could not). */
export type ContextActionCompletion =
  | { ok: true; collectionId: string }
  | { ok: true; planHash: string; created: readonly string[] }
  | { ok: false; failedAt?: number };

export type SessionContextBinding = {
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  /** The per-session context server name (./identity.ts). */
  serverName: string;
  access: SessionContextAccess;
  capabilities: readonly SessionContextCapability[];
  snapshot: SessionContextSnapshot;
  boundAt: number;
  /** Monotonic: 1 at bind, +1 per accepted snapshot that changed anything. */
  version: number;
  /** When the runtime last accepted a snapshot (changed or not). */
  syncedAt: number;
  /** `snapshotFingerprint` of the snapshot held. */
  fingerprint: string;
};

export type ContextChanges = {
  version: number;
  since: number;
  /** False when `since` predates removals the registry no longer remembers: re-read instead. */
  complete: boolean;
  tabs: { changed: string[]; removed: string[] };
  collections: { changed: string[]; removed: string[] };
  relationshipsChanged: boolean;
  workspaceRenamed: boolean;
  /** Some ids were left out to stay within bounds. */
  truncated: boolean;
};

export type SessionContextUpdate = { version: number; changed: boolean };

export type SessionContextRegistry = {
  /**
   * Binds a session to a workspace and mints its credential and server name.
   * The token is returned here and nowhere else. `undefined` when the
   * snapshot is not of `workspaceId`, or the session is already bound.
   */
  bind(input: {
    sessionId: string;
    ownerId: string;
    workspaceId: string;
    access: SessionContextAccess;
    snapshot: unknown;
  }): Promise<{ token: string; serverName: string } | undefined>;
  /** The binding a credential belongs to, or `undefined` for any token that does not work. */
  authenticate(token: string | undefined): Promise<SessionContextBinding | undefined>;
  binding(sessionId: string): SessionContextBinding | undefined;
  /** What the runtime established for a session, for `authorizeContextRequest`. */
  authority(sessionId: string): ContextAuthority | undefined;
  /** A fresher snapshot of the same workspace. `undefined` for any other workspace or an unbound session. */
  update(sessionId: string, snapshot: unknown): SessionContextUpdate | undefined;
  /** What changed since a version, as bounded id lists. */
  changesSince(sessionId: string, since: number): ContextChanges | undefined;
  /** Proposes a change. Resolves when the user has answered and, if approved, the Command Centre has applied it. */
  requestChange(sessionId: string, change: WorkspaceChange): Promise<ContextChangeResult>;
  /** Validates a plan and describes it, without asking anyone (J.5). */
  previewPlan(sessionId: string, input: WorkspacePlanInput): PlanPreviewResult;
  /** Proposes a plan. Resolves when it was refused, answered, or applied and verified (J.5). */
  requestPlan(sessionId: string, input: WorkspacePlanInput): Promise<ContextPlanResult>;
  /** How this session's recent plans ended, oldest first. */
  planOutcomes(sessionId: string): readonly PlanOutcome[];
  /** Approved actions the Command Centre has yet to apply, oldest first. */
  pendingApplications(sessionId: string): ContextAction[];
  /** The Command Centre applied (or failed to apply) an approved action. */
  complete(sessionId: string, actionId: string, outcome: ContextActionCompletion): boolean;
  /** Revokes the credential and abandons the session's actions. Idempotent. */
  release(sessionId: string): void;
  releaseAll(): void;
  /** How many credentials currently work. */
  activeCount(): number;
  /** Connects the registry to the control service that owns approvals. */
  setApprover(approve: ContextApprover): void;
};

export type SessionContextRegistryOptions = {
  /** Who puts a change to the user. Set later with `setApprover` when the host is built after the registry. */
  approve?: ContextApprover;
  now?: () => number;
  /** Seams for tests. Production uses Web Crypto. */
  randomBytes?: (length: number) => Uint8Array;
  createId?: () => string;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}

/** Per-entity bookkeeping behind `changesSince`. Ids only; never content. */
type ChangeLog = {
  tabPrints: Map<string, string>;
  collectionPrints: Map<string, string>;
  tabChangedAt: Map<string, number>;
  collectionChangedAt: Map<string, number>;
  /** Insertion-ordered, capped: removed id → version it went away at. */
  tabRemovedAt: Map<string, number>;
  collectionRemovedAt: Map<string, number>;
  /** Removals at or before this version may have been forgotten. */
  forgottenThrough: number;
  relationshipsPrint: string;
  relationshipsChangedAt: number;
  workspaceName: string;
  workspaceRenamedAt: number;
};

function entityPrints<T extends { id: string }>(entries: readonly T[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.id, JSON.stringify(entry)]));
}

function newChangeLog(snapshot: SessionContextSnapshot): ChangeLog {
  return {
    tabPrints: entityPrints(snapshot.workspace.tabs),
    collectionPrints: entityPrints(snapshot.collections),
    tabChangedAt: new Map(snapshot.workspace.tabs.map((tab) => [tab.id, 1])),
    collectionChangedAt: new Map(snapshot.collections.map((collection) => [collection.id, 1])),
    tabRemovedAt: new Map(),
    collectionRemovedAt: new Map(),
    forgottenThrough: 0,
    relationshipsPrint: JSON.stringify(snapshot.dependencies),
    relationshipsChangedAt: 1,
    workspaceName: snapshot.workspace.name,
    workspaceRenamedAt: 1,
  };
}

function remember(removed: Map<string, number>, id: string, version: number, log: ChangeLog): void {
  removed.delete(id);
  removed.set(id, version);
  while (removed.size > MAX_REMEMBERED_REMOVALS) {
    const oldest = removed.entries().next().value as [string, number];
    removed.delete(oldest[0]);
    log.forgottenThrough = Math.max(log.forgottenThrough, oldest[1]);
  }
}

function diffEntities(
  previous: Map<string, string>,
  next: Map<string, string>,
  changedAt: Map<string, number>,
  removedAt: Map<string, number>,
  version: number,
  log: ChangeLog
): boolean {
  let changed = false;
  for (const [id, print] of next) {
    if (previous.get(id) !== print) {
      changedAt.set(id, version);
      removedAt.delete(id);
      changed = true;
    }
  }
  for (const id of previous.keys()) {
    if (next.has(id)) continue;
    changedAt.delete(id);
    remember(removedAt, id, version, log);
    changed = true;
  }
  return changed;
}

function idsSince(map: Map<string, number>, since: number): { ids: string[]; truncated: boolean } {
  const ids: string[] = [];
  for (const [id, version] of map) if (version > since) ids.push(id);
  return { ids: ids.slice(0, MAX_CHANGE_IDS), truncated: ids.length > MAX_CHANGE_IDS };
}

/** How a waiting action ends, before it is described back to the agent. */
type Settlement =
  | { ok: true; collectionId: string }
  | { ok: true; plan: Extract<ContextPlanResult, { ok: true }> }
  | { ok: false; reason: ContextChangeFailure | "stale"; failedAt?: number };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function createSessionContextRegistry(options: SessionContextRegistryOptions): SessionContextRegistry {
  const now = options.now ?? (() => Date.now());
  // No approver means no one can say yes: every change is cancelled.
  let approve: ContextApprover = options.approve ?? (async () => "cancelled");
  const randomBytes =
    options.randomBytes ??
    ((length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
  let counter = 0;
  const createId = options.createId ?? (() => `ctxa-${now().toString(36)}-${(counter++).toString(36)}`);
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const bindings = new Map<string, SessionContextBinding>();
  const logs = new Map<string, ChangeLog>();
  /** credential hash → session id. The raw token is never kept. */
  const credentials = new Map<string, string>();
  const credentialOf = new Map<string, string>();
  const actions = new Map<string, ContextAction>();
  /** Actions whose tool call is still waiting, with how to answer it. */
  const waiting = new Map<string, { resolve: (result: Settlement) => void; timer?: unknown }>();
  const outcomes = new Map<string, PlanOutcome[]>();

  function recordOutcome(sessionId: string, outcome: Omit<PlanOutcome, "at">): void {
    const list = outcomes.get(sessionId) ?? [];
    list.push({ ...outcome, at: now() });
    outcomes.set(sessionId, list.slice(-MAX_PLAN_OUTCOMES));
  }

  function settle(actionId: string, result: Settlement, status: ContextActionStatus): void {
    const action = actions.get(actionId);
    if (action) actions.set(actionId, { ...action, status });
    const waiter = waiting.get(actionId);
    if (!waiter) return;
    waiting.delete(actionId);
    if (waiter.timer !== undefined) clearTimer(waiter.timer);
    waiter.resolve(result);
  }

  /**
   * Checks a proposed change against the bound snapshot and describes it for
   * the approval card. `undefined`: refused without asking anyone — a name
   * that cleans to nothing, a collection or tab that is not this workspace's,
   * or a change that would change nothing.
   */
  function validate(
    binding: SessionContextBinding,
    change: WorkspaceChange
  ): { change: WorkspaceChange; summary: WorkspaceChangeSummary; name: string; tabCount: number } | undefined {
    const { workspace, collections } = binding.snapshot;
    const known = new Set(workspace.tabs.map((tab) => tab.id));
    const titles = new Map(workspace.tabs.map((tab) => [tab.id, tab.title ?? tab.domain]));

    /** Every id must be a tab of this workspace: a request naming anything else is refused, not trimmed. */
    function tabsOf(requested: readonly string[]): string[] | undefined {
      const unique = [...new Set(requested)];
      if (unique.length === 0 || unique.length > CHANGE_LIMITS.tabs) return undefined;
      return unique.every((tabId) => known.has(tabId)) ? unique : undefined;
    }

    function tabLines(tabIds: readonly string[]): string[] {
      return tabIds.slice(0, 3).map((tabId) => `Tab: ${(titles.get(tabId) ?? "tab").slice(0, 120)}`);
    }

    /** A tab belongs to at most one collection, so placing it moves it. Said up front. */
    function movedLine(tabIds: readonly string[], except?: string): string[] {
      const chosen = new Set(tabIds);
      const moved = collections.filter(
        (collection) => collection.id !== except && collection.tabIds.some((tabId) => chosen.has(tabId))
      );
      if (moved.length === 0) return [];
      const names = moved.slice(0, 3).map((collection) => collection.name.slice(0, 60)).join(", ");
      return [`Moves tabs out of: ${names}${moved.length > 3 ? ", …" : ""}`];
    }

    switch (change.kind) {
      case "create_collection": {
        const name = cleanCollectionName(change.name);
        const tabIds = tabsOf(change.tabIds);
        if (!name || !tabIds) return undefined;
        return {
          change: { kind: "create_collection", name, tabIds },
          name,
          tabCount: tabIds.length,
          summary: {
            kind: "create_collection",
            subject: name,
            tabCount: tabIds.length,
            details: [plural(tabIds.length, "tab", "tabs"), ...movedLine(tabIds), ...tabLines(tabIds)],
          },
        };
      }
      case "rename_collection": {
        const collection = collections.find((entry) => entry.id === change.collectionId);
        const name = cleanCollectionName(change.name);
        if (!collection || !name || name === collection.name) return undefined;
        return {
          change: { kind: "rename_collection", collectionId: collection.id, name },
          name,
          tabCount: collection.tabIds.length,
          summary: {
            kind: "rename_collection",
            subject: collection.name,
            to: name,
            details: [plural(collection.tabIds.length, "tab", "tabs") + " in it, unchanged"],
          },
        };
      }
      case "add_tabs_to_collection": {
        const collection = collections.find((entry) => entry.id === change.collectionId);
        const requested = tabsOf(change.tabIds);
        if (!collection || !requested) return undefined;
        const already = new Set(collection.tabIds);
        const tabIds = requested.filter((tabId) => !already.has(tabId));
        if (tabIds.length === 0) return undefined;
        return {
          change: { kind: "add_tabs_to_collection", collectionId: collection.id, tabIds },
          name: collection.name,
          tabCount: tabIds.length,
          summary: {
            kind: "add_tabs_to_collection",
            subject: collection.name,
            tabCount: tabIds.length,
            details: [`Adds ${plural(tabIds.length, "tab", "tabs")}`, ...movedLine(tabIds, collection.id), ...tabLines(tabIds)],
          },
        };
      }
    }
  }

  function targetsFor(summary: WorkspaceChangeSummary): string[] {
    switch (summary.kind) {
      case "create_collection":
        return [`New collection "${summary.subject}"`, ...summary.details];
      case "rename_collection":
        return [`Rename "${summary.subject}" to "${summary.to}"`, ...summary.details];
      case "add_tabs_to_collection":
        return [`Collection "${summary.subject}"`, ...summary.details];
    }
  }

  const REASONS: Record<WorkspaceChangeKind, string> = {
    create_collection: "Create a collection in this workspace.",
    rename_collection: "Rename a collection in this workspace.",
    add_tabs_to_collection: "Add tabs to a collection in this workspace.",
  };

  /** A plan refused before anyone was asked: stale on its own, otherwise every problem found. */
  function refusalOf(checked: Extract<ReturnType<typeof validateWorkspacePlan>, { ok: false }>) {
    const stale = checked.problems.length === 1 && checked.problems[0].code === "stale";
    return stale
      ? ({ ok: false, reason: "stale", currentVersion: checked.currentVersion } as const)
      : ({ ok: false, reason: "invalid", problems: checked.problems, currentVersion: checked.currentVersion } as const);
  }

  /**
   * The Command Centre applied (or could not apply) an approved plan.
   *
   * Refused — and the plan left waiting for a truthful answer — when the
   * answer is not for this plan: a single change's answer, a different hash
   * (not the operations the user approved), or a list of created ids that
   * does not match the plan's creates. Accepted, the plan is then checked
   * against the workspace the session now holds, operation by operation.
   */
  function completePlan(action: ContextAction, plan: PendingPlan, outcome: ContextActionCompletion): boolean {
    const record = (status: PlanOutcomeStatus, verifiedCount: number, contextVersion: number) =>
      recordOutcome(action.sessionId, { planId: plan.planId, status, operationCount: plan.operations.length, verifiedCount, contextVersion });

    if (!outcome.ok) {
      record("not_applied", 0, bindings.get(action.sessionId)?.version ?? plan.basedOnVersion);
      const failedAt =
        outcome.failedAt !== undefined && Number.isInteger(outcome.failedAt) && outcome.failedAt >= 0 && outcome.failedAt < plan.operations.length
          ? { failedAt: outcome.failedAt }
          : {};
      settle(action.id, { ok: false, reason: "not_applied", ...failedAt }, "failed");
      return true;
    }
    if (!("planHash" in outcome) || outcome.planHash !== plan.hash) return false;
    const creates = plan.operations.filter((operation) => operation.kind === "create_collection").length;
    if (outcome.created.length !== creates || new Set(outcome.created).size !== creates) return false;

    const binding = bindings.get(action.sessionId);
    const verification = binding
      ? verifyWorkspacePlan(binding.snapshot, plan.operations, outcome.created)
      : { verified: false, results: plan.operations.map((operation, index) => ({ index, kind: operation.kind, verified: false })) };
    const results = verification.results.map((result) => ({ ...result, line: planStepLine(plan.preview.steps[result.index]) }));
    const verifiedCount = results.filter((result) => result.verified).length;
    const contextVersion = binding?.version ?? plan.basedOnVersion;

    actions.set(action.id, { ...action, status: "applied" });
    record(verification.verified ? "applied" : "unverified", verifiedCount, contextVersion);
    settle(
      action.id,
      {
        ok: true,
        plan: { ok: true, planId: plan.planId, basedOnVersion: plan.basedOnVersion, contextVersion, verified: verification.verified, results },
      },
      "applied"
    );
    return true;
  }

  const api: SessionContextRegistry = {
    async bind(input) {
      if (bindings.has(input.sessionId)) return undefined;
      const snapshot = readSessionContextSnapshot(input.snapshot, input.workspaceId);
      if (!snapshot) return undefined;

      const token = `${CONTEXT_TOKEN_PREFIX}${toBase64Url(randomBytes(32))}`;
      const serverName = mintContextServerName(randomBytes);
      const hash = await sha256(token);
      const at = now();
      bindings.set(input.sessionId, {
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        serverName,
        access: input.access,
        capabilities: capabilitiesFor(input.access),
        snapshot,
        boundAt: at,
        version: 1,
        syncedAt: at,
        fingerprint: snapshotFingerprint(snapshot),
      });
      logs.set(input.sessionId, newChangeLog(snapshot));
      credentials.set(hash, input.sessionId);
      credentialOf.set(input.sessionId, hash);
      return { token, serverName };
    },

    async authenticate(token) {
      if (typeof token !== "string" || !token.startsWith(CONTEXT_TOKEN_PREFIX) || token.length > 200) {
        return undefined;
      }
      const hash = await sha256(token);
      const sessionId = credentials.get(hash);
      const binding = sessionId ? bindings.get(sessionId) : undefined;
      if (!binding) return undefined;
      if (now() - binding.boundAt >= CREDENTIAL_MAX_AGE_MS) {
        // Expired: forgotten for good. The binding stays, so the session's
        // view and any pending approval are unaffected; only the agent's
        // access ends.
        credentials.delete(hash);
        return undefined;
      }
      return binding;
    },

    binding: (sessionId) => bindings.get(sessionId),

    authority(sessionId) {
      const binding = bindings.get(sessionId);
      if (!binding) return undefined;
      return {
        sessionId: binding.sessionId,
        workspaceId: binding.workspaceId,
        serverName: binding.serverName,
        capabilities: binding.capabilities,
      };
    },

    update(sessionId, raw) {
      const binding = bindings.get(sessionId);
      const log = logs.get(sessionId);
      if (!binding || !log) return undefined;
      // The workspace is fixed at bind time. A snapshot of anything else is refused.
      const snapshot = readSessionContextSnapshot(raw, binding.workspaceId);
      if (!snapshot) return undefined;
      const fingerprint = snapshotFingerprint(snapshot);
      const at = now();
      if (fingerprint === binding.fingerprint) {
        bindings.set(sessionId, { ...binding, syncedAt: at });
        return { version: binding.version, changed: false };
      }

      const version = binding.version + 1;
      const tabPrints = entityPrints(snapshot.workspace.tabs);
      const collectionPrints = entityPrints(snapshot.collections);
      diffEntities(log.tabPrints, tabPrints, log.tabChangedAt, log.tabRemovedAt, version, log);
      diffEntities(log.collectionPrints, collectionPrints, log.collectionChangedAt, log.collectionRemovedAt, version, log);
      log.tabPrints = tabPrints;
      log.collectionPrints = collectionPrints;
      const relationshipsPrint = JSON.stringify(snapshot.dependencies);
      if (relationshipsPrint !== log.relationshipsPrint) {
        log.relationshipsPrint = relationshipsPrint;
        log.relationshipsChangedAt = version;
      }
      if (snapshot.workspace.name !== log.workspaceName) {
        log.workspaceName = snapshot.workspace.name;
        log.workspaceRenamedAt = version;
      }

      bindings.set(sessionId, { ...binding, snapshot, version, syncedAt: at, fingerprint });
      return { version, changed: true };
    },

    changesSince(sessionId, since) {
      const binding = bindings.get(sessionId);
      const log = logs.get(sessionId);
      if (!binding || !log) return undefined;
      const from = Math.max(0, Math.min(Math.floor(since), binding.version));
      const tabsChanged = idsSince(log.tabChangedAt, from);
      const tabsRemoved = idsSince(log.tabRemovedAt, from);
      const collectionsChanged = idsSince(log.collectionChangedAt, from);
      const collectionsRemoved = idsSince(log.collectionRemovedAt, from);
      return {
        version: binding.version,
        since: from,
        complete: from >= log.forgottenThrough,
        tabs: { changed: tabsChanged.ids, removed: tabsRemoved.ids },
        collections: { changed: collectionsChanged.ids, removed: collectionsRemoved.ids },
        relationshipsChanged: log.relationshipsChangedAt > from,
        workspaceRenamed: log.workspaceRenamedAt > from,
        truncated:
          tabsChanged.truncated || tabsRemoved.truncated || collectionsChanged.truncated || collectionsRemoved.truncated,
      };
    },

    async requestChange(sessionId, proposed) {
      const binding = bindings.get(sessionId);
      if (!binding) return { ok: false, reason: "ended" };
      if (!binding.capabilities.includes("collections.write")) return { ok: false, reason: "not_permitted" };

      const checked = validate(binding, proposed);
      if (!checked) return { ok: false, reason: "invalid" };

      const action: ContextAction = {
        id: createId(),
        sessionId,
        workspaceId: binding.workspaceId,
        change: checked.change,
        status: "awaiting_approval",
        requestedAt: now(),
      };
      actions.set(action.id, action);

      const result = new Promise<ContextChangeResult>((resolve) => {
        waiting.set(action.id, {
          resolve: (outcome) => {
            if (!outcome.ok) return resolve({ ok: false, reason: outcome.reason === "stale" ? "not_applied" : outcome.reason });
            if ("collectionId" in outcome) {
              return resolve({ ok: true, collectionId: outcome.collectionId, kind: checked.change.kind, name: checked.name, tabCount: checked.tabCount });
            }
            resolve({ ok: false, reason: "not_applied" });
          },
        });
      });

      void approve({
        sessionId,
        workspaceId: binding.workspaceId,
        actionId: action.id,
        change: checked.summary,
        targets: targetsFor(checked.summary),
        reason: REASONS[checked.change.kind],
      }).then((outcome) => {
        const current = actions.get(action.id);
        if (!current || current.status !== "awaiting_approval") return;
        if (outcome === "denied") return settle(action.id, { ok: false, reason: "denied" }, "denied");
        if (outcome === "expired") return settle(action.id, { ok: false, reason: "expired" }, "expired");
        if (outcome === "cancelled") return settle(action.id, { ok: false, reason: "ended" }, "cancelled");
        actions.set(action.id, { ...current, status: "approved" });
        // Approved: now the Command Centre applies it. If nothing does, the
        // agent is told so rather than left waiting forever.
        const waiter = waiting.get(action.id);
        if (waiter) {
          waiter.timer = setTimer(() => settle(action.id, { ok: false, reason: "not_applied" }, "failed"), APPLY_TIMEOUT_MS);
        }
      });

      return result;
    },

    previewPlan(sessionId, input) {
      const binding = bindings.get(sessionId);
      if (!binding) return { ok: false, reason: "ended" };
      const checked = validateWorkspacePlan(binding.snapshot, input, binding);
      if (!checked.ok) return refusalOf(checked);
      const preview = previewOf(checked.plan, "preview");
      return {
        ok: true,
        preview,
        lines: preview.steps.map(planStepLine),
        canApply: binding.capabilities.includes("collections.write"),
      };
    },

    async requestPlan(sessionId, input) {
      const binding = bindings.get(sessionId);
      if (!binding) return { ok: false, reason: "ended" };
      if (!binding.capabilities.includes("collections.write")) return { ok: false, reason: "not_permitted" };
      // Refused before anyone is asked: malformed, foreign, colliding, oversized — or made against an older version.
      const checked = validateWorkspacePlan(binding.snapshot, input, binding);
      if (!checked.ok) return refusalOf(checked);

      const { basedOnVersion } = checked.plan;
      const operations = freezeOperations(checked.plan.operations);
      const hash = await sha256(canonicalPlan({ sessionId, workspaceId: binding.workspaceId, basedOnVersion, operations }));
      // The session may have ended, or the workspace moved on, while the hash was computed.
      const live = bindings.get(sessionId);
      if (!live) return { ok: false, reason: "ended" };
      if (live.version !== basedOnVersion) return { ok: false, reason: "stale", currentVersion: live.version };

      const planId = `plan-${createId()}`;
      const preview = previewOf(checked.plan, planId);
      const effect = planEffect(checked.plan);
      const action: ContextAction = {
        id: createId(),
        sessionId,
        workspaceId: binding.workspaceId,
        plan: { planId, hash, basedOnVersion, operations, preview },
        status: "awaiting_approval",
        requestedAt: now(),
      };
      actions.set(action.id, action);
      const ended = (status: PlanOutcomeStatus) =>
        recordOutcome(sessionId, {
          planId,
          status,
          operationCount: operations.length,
          verifiedCount: 0,
          contextVersion: bindings.get(sessionId)?.version ?? basedOnVersion,
        });

      const result = new Promise<ContextPlanResult>((resolve) => {
        waiting.set(action.id, {
          resolve: (outcome) => {
            if (outcome.ok) return resolve("plan" in outcome ? outcome.plan : { ok: false, reason: "not_applied" });
            switch (outcome.reason) {
              case "stale":
                return resolve({ ok: false, reason: "stale", currentVersion: bindings.get(sessionId)?.version ?? basedOnVersion });
              case "not_applied":
              case "invalid":
                return resolve({ ok: false, reason: "not_applied", ...(outcome.failedAt !== undefined ? { failedAt: outcome.failedAt } : {}) });
              default:
                return resolve({ ok: false, reason: outcome.reason });
            }
          },
        });
      });

      void approve({
        sessionId,
        workspaceId: binding.workspaceId,
        actionId: action.id,
        plan: preview,
        targets: preview.steps.map(planStepLine),
        reason: `Apply ${plural(operations.length, "change", "changes")} to this workspace.`,
      }).then((outcome) => {
        const current = actions.get(action.id);
        if (!current || current.status !== "awaiting_approval") return;
        if (outcome === "denied") {
          ended("denied");
          return settle(action.id, { ok: false, reason: "denied" }, "denied");
        }
        if (outcome === "expired") {
          ended("expired");
          return settle(action.id, { ok: false, reason: "expired" }, "expired");
        }
        if (outcome === "cancelled") {
          ended("cancelled");
          return settle(action.id, { ok: false, reason: "ended" }, "cancelled");
        }

        // Approved. Is the plan still exactly what the user was shown? If the
        // workspace moved on meanwhile, the same operations are re-validated
        // against it, and anything but an identical effect is stale.
        const latest = bindings.get(sessionId);
        if (!latest) return settle(action.id, { ok: false, reason: "ended" }, "cancelled");
        if (latest.version !== basedOnVersion) {
          const again = validateWorkspacePlan(latest.snapshot, { basedOnVersion: latest.version, operations }, latest);
          if (!again.ok || planEffect(again.plan) !== effect) {
            ended("stale");
            return settle(action.id, { ok: false, reason: "stale" }, "failed");
          }
        }

        actions.set(action.id, { ...current, status: "approved" });
        const waiter = waiting.get(action.id);
        if (waiter) {
          waiter.timer = setTimer(() => {
            ended("not_applied");
            settle(action.id, { ok: false, reason: "not_applied" }, "failed");
          }, APPLY_TIMEOUT_MS);
        }
      });

      return result;
    },

    planOutcomes: (sessionId) => [...(outcomes.get(sessionId) ?? [])],

    pendingApplications(sessionId) {
      return [...actions.values()]
        .filter((action) => action.sessionId === sessionId && action.status === "approved")
        .sort((a, b) => a.requestedAt - b.requestedAt);
    },

    complete(sessionId, actionId, outcome) {
      const action = actions.get(actionId);
      // Only an action the user approved, of this session, may be completed —
      // and only once: the Command Centre cannot make one up, finish one that
      // was denied, or replay one it already applied.
      if (!action || action.sessionId !== sessionId || action.status !== "approved") return false;
      if (action.plan) return completePlan(action, action.plan, outcome);
      // A plan's answer cannot finish a single change.
      if (outcome.ok && !("collectionId" in outcome)) return false;
      if (outcome.ok) {
        actions.set(actionId, { ...action, status: "applied", collectionId: outcome.collectionId });
        settle(actionId, { ok: true, collectionId: outcome.collectionId }, "applied");
      } else {
        settle(actionId, { ok: false, reason: "not_applied" }, "failed");
      }
      return true;
    },

    release(sessionId) {
      const hash = credentialOf.get(sessionId);
      if (hash) credentials.delete(hash);
      credentialOf.delete(sessionId);
      bindings.delete(sessionId);
      logs.delete(sessionId);
      outcomes.delete(sessionId);
      for (const action of [...actions.values()]) {
        if (action.sessionId !== sessionId) continue;
        if (action.status === "awaiting_approval" || action.status === "approved") {
          settle(action.id, { ok: false, reason: "ended" }, "cancelled");
        }
        actions.delete(action.id);
      }
    },

    releaseAll() {
      for (const sessionId of [...bindings.keys()]) api.release(sessionId);
    },

    activeCount: () => credentials.size,

    setApprover(next) {
      approve = next;
    },
  };
  return api;
}
