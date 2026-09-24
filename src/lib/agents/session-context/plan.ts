import { CHANGE_LIMITS, cleanCollectionName, isWorkspaceChangeKind } from "./changes";
import type { WorkspaceChange, WorkspaceChangeKind } from "./changes";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * Workspace plans: several changes an agent proposes as one (Phase J.5).
 *
 * ## The operation model is J.4's
 *
 * A plan is an ordered list of the same three changes an agent could already
 * propose one at a time (./changes.ts) — create a collection, rename one, add
 * tabs to one — plus, per operation, the agent's optional one-line reason and
 * how sure it is. Nothing else can be expressed: no arbitrary store call, no
 * deletion, no other workspace, no script. An operation is data, never code.
 *
 * ## Validated before anyone is asked
 *
 * `validateWorkspacePlan` reads a proposed plan strictly and checks it against
 * the session's bound snapshot, simulating the operations in order:
 *
 *   - the plan names this session's workspace (or none) and was made against
 *     the context version the session holds now — an older one is **stale**;
 *   - every tab and collection it names is this workspace's;
 *   - names are non-empty and do not collide with a collection that exists
 *     (or that an earlier operation creates) — so an agent cannot quietly
 *     make a second "Research";
 *   - no tab is placed twice and no collection renamed twice in one plan, so
 *     the order of operations never decides where a tab ends up;
 *   - every operation changes something, and the plan stays within bounds.
 *
 * Every problem is reported by operation index and code, in fixed words, so
 * an agent can fix its plan; nothing from the plan is echoed back.
 *
 * ## One object, from proposal to execution
 *
 * The validated operations are what the preview is built from, what the user
 * approves (bound by hash, ./registry.ts), what the Command Centre applies
 * (all or nothing, lib/collections/batch.ts) and what `verifyWorkspacePlan`
 * checks the synced workspace against afterwards. There is no second
 * interpretation of a plan anywhere.
 */

export const PLAN_LIMITS = {
  operations: 20,
  tabsPerOperation: CHANGE_LIMITS.tabs,
  /** Distinct tabs one plan may place. */
  affectedTabs: 400,
  /** The plan's operations, encoded. The MCP request itself is capped at 64 KiB. */
  bytes: 48 * 1024,
  reason: 160,
  /** Tab titles shown per step on the approval card. */
  titlesPerStep: 25,
  /** Problems reported for one plan. */
  problems: 20,
} as const;

export type OperationConfidence = "high" | "medium" | "unclear";

export const OPERATION_CONFIDENCES: readonly OperationConfidence[] = ["high", "medium", "unclear"] as const;

/** One operation: a J.4 change, and optionally why and how sure the agent is. Shown to the user as the agent's words. */
export type WorkspaceOperation = WorkspaceChange & { reason?: string; confidence?: OperationConfidence };

export type WorkspacePlanInput = {
  basedOnVersion: unknown;
  workspaceId?: unknown;
  operations: unknown;
};

export type PlanProblemCode =
  | "malformed"
  | "unknown_kind"
  | "empty_plan"
  | "too_many_operations"
  | "too_large"
  | "too_many_tabs"
  | "too_many_affected_tabs"
  | "wrong_workspace"
  | "stale"
  | "empty_name"
  | "duplicate_name"
  | "unknown_tab"
  | "unknown_collection"
  | "no_tabs"
  | "no_change"
  | "tab_conflict"
  | "collection_conflict";

export type PlanProblem = { operation?: number; code: PlanProblemCode };

/** What each problem means, for the agent. Fixed sentences; nothing from the plan is repeated. */
export const PLAN_PROBLEM_MESSAGES: Record<PlanProblemCode, string> = {
  malformed: "This operation is not well formed.",
  unknown_kind: "Unknown operation. Use create_collection, rename_collection or add_tabs_to_collection.",
  empty_plan: "The plan has no operations.",
  too_many_operations: `A plan can have at most ${PLAN_LIMITS.operations} operations. Split it.`,
  too_large: "The plan is too large. Split it.",
  too_many_tabs: `One operation can place at most ${PLAN_LIMITS.tabsPerOperation} tabs.`,
  too_many_affected_tabs: `One plan can place at most ${PLAN_LIMITS.affectedTabs} tabs. Split it.`,
  wrong_workspace: "This session can only change the TabDump workspace it was started from.",
  stale: "The workspace changed since the version this plan was made against. Refresh (get_context_changes or get_workspace_summary) and propose again.",
  empty_name: "The collection name is empty.",
  duplicate_name: "A collection with that name already exists in this workspace (or earlier in this plan). Add tabs to it or choose another name.",
  unknown_tab: "A tab id does not belong to this workspace.",
  unknown_collection: "The collection id does not belong to this workspace. New collections cannot be referenced by id within the same plan; give create_collection its tabs instead.",
  no_tabs: "A new collection needs at least one tab.",
  no_change: "This operation would change nothing.",
  tab_conflict: "A tab is placed by more than one operation in this plan.",
  collection_conflict: "The same collection is renamed more than once in this plan.",
};

/** One step as the user reads it. Names and titles only — never ids. */
export type WorkspacePlanStep = {
  kind: WorkspaceChangeKind;
  /** The collection by name: the new one, the one renamed (old name) or the one added to. */
  subject: string;
  /** For a rename, the new name. */
  to?: string;
  /** Tabs the step places, for create and add. */
  tabCount?: number;
  /** Titles of those tabs, bounded; `moreTabs` counts the rest. */
  tabs: readonly string[];
  moreTabs?: number;
  /** Collections tabs would move out of (a tab belongs to at most one), and how many move. */
  movesFrom: readonly string[];
  movedCount?: number;
  /** The agent's own words and confidence — shown as the agent's, never as TabDump's. */
  reason?: string;
  confidence?: OperationConfidence;
};

export type WorkspacePlanPreview = {
  planId: string;
  /** The context version the plan was made and validated against. */
  basedOnVersion: number;
  operationCount: number;
  /** Distinct tabs the plan places. */
  tabCount: number;
  steps: readonly WorkspacePlanStep[];
};

export type ValidatedWorkspacePlan = {
  workspaceId: string;
  basedOnVersion: number;
  operations: readonly WorkspaceOperation[];
  steps: readonly WorkspacePlanStep[];
  tabCount: number;
};

export type PlanValidation =
  | { ok: true; plan: ValidatedWorkspacePlan }
  | { ok: false; problems: readonly PlanProblem[]; currentVersion: number };

/* ------------------------------------------------------------------ *
 * Reading one operation strictly
 * ------------------------------------------------------------------ */

const ID = /^[^\s\u0000-\u001f\u007f]{1,200}$/;

function readId(value: unknown): string | undefined {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

function readIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > PLAN_LIMITS.tabsPerOperation * 2) return undefined;
  const ids: string[] = [];
  for (const entry of value) {
    const id = readId(entry);
    if (!id) return undefined;
    ids.push(id);
  }
  return [...new Set(ids)];
}

function cleanReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > PLAN_LIMITS.reason ? `${cleaned.slice(0, PLAN_LIMITS.reason - 1)}…` : cleaned;
}

function readConfidence(value: unknown): OperationConfidence | undefined {
  return typeof value === "string" && (OPERATION_CONFIDENCES as readonly string[]).includes(value)
    ? (value as OperationConfidence)
    : undefined;
}

/** An operation's shape, or the reason it has none. Only known fields are copied. */
function readOperation(raw: unknown): WorkspaceOperation | "malformed" | "unknown_kind" {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "malformed";
  const source = raw as Record<string, unknown>;
  if (!isWorkspaceChangeKind(source.kind)) return typeof source.kind === "string" ? "unknown_kind" : "malformed";
  if (source.reason !== undefined && typeof source.reason !== "string") return "malformed";
  if (source.confidence !== undefined && !readConfidence(source.confidence)) return "malformed";
  const extras = {
    ...(cleanReason(source.reason) ? { reason: cleanReason(source.reason) } : {}),
    ...(readConfidence(source.confidence) ? { confidence: readConfidence(source.confidence) } : {}),
  };

  switch (source.kind) {
    case "create_collection": {
      const tabIds = readIds(source.tabIds);
      if (typeof source.name !== "string" || !tabIds) return "malformed";
      return { kind: "create_collection", name: source.name, tabIds, ...extras };
    }
    case "rename_collection": {
      const collectionId = readId(source.collectionId);
      if (typeof source.name !== "string" || !collectionId) return "malformed";
      return { kind: "rename_collection", collectionId, name: source.name, ...extras };
    }
    case "add_tabs_to_collection": {
      const collectionId = readId(source.collectionId);
      const tabIds = readIds(source.tabIds);
      if (!collectionId || !tabIds) return "malformed";
      return { kind: "add_tabs_to_collection", collectionId, tabIds, ...extras };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Validation: the whole plan, simulated in order
 * ------------------------------------------------------------------ */

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function nameKey(name: string): string {
  return name.toLocaleLowerCase();
}

export function validateWorkspacePlan(
  snapshot: SessionContextSnapshot,
  input: WorkspacePlanInput,
  held: { workspaceId: string; version: number }
): PlanValidation {
  const refuse = (problems: PlanProblem[]): PlanValidation => ({
    ok: false,
    problems: problems.slice(0, PLAN_LIMITS.problems),
    currentVersion: held.version,
  });

  if (input.workspaceId !== undefined && input.workspaceId !== held.workspaceId) return refuse([{ code: "wrong_workspace" }]);
  if (typeof input.basedOnVersion !== "number" || !Number.isInteger(input.basedOnVersion) || input.basedOnVersion < 0) {
    return refuse([{ code: "malformed" }]);
  }
  // The plan must describe the workspace as it is now, not as it was.
  if (input.basedOnVersion !== held.version) return refuse([{ code: "stale" }]);
  if (!Array.isArray(input.operations)) return refuse([{ code: "malformed" }]);
  if (input.operations.length === 0) return refuse([{ code: "empty_plan" }]);
  if (input.operations.length > PLAN_LIMITS.operations) return refuse([{ code: "too_many_operations" }]);
  let encoded: string;
  try {
    encoded = JSON.stringify(input.operations);
  } catch {
    return refuse([{ code: "malformed" }]);
  }
  if (new TextEncoder().encode(encoded).length > PLAN_LIMITS.bytes) return refuse([{ code: "too_large" }]);

  const tabs = new Map(snapshot.workspace.tabs.map((tab) => [tab.id, tab]));
  const collectionName = new Map(snapshot.collections.map((collection) => [collection.id, collection.name]));
  const holderOf = new Map<string, string>();
  const membersOf = new Map<string, Set<string>>();
  for (const collection of snapshot.collections) {
    membersOf.set(collection.id, new Set(collection.tabIds));
    for (const tabId of collection.tabIds) holderOf.set(tabId, collection.id);
  }
  /** Lower-cased name → the collection (or the plan-created key) holding it. */
  const names = new Map<string, string>();
  for (const collection of snapshot.collections) names.set(nameKey(collection.name), collection.id);

  const claimed = new Set<string>();
  const renamed = new Set<string>();
  const placed = new Set<string>();
  const problems: PlanProblem[] = [];
  const operations: WorkspaceOperation[] = [];
  const steps: WorkspacePlanStep[] = [];

  const titleOf = (tabId: string) => {
    const tab = tabs.get(tabId);
    return (tab?.title ?? tab?.domain ?? "Tab").replace(/\s+/g, " ").trim().slice(0, 120);
  };

  /** Describes and records the tabs a step places; moves them in the simulation. */
  function place(tabIds: readonly string[], into: string): Pick<WorkspacePlanStep, "tabs" | "moreTabs" | "movesFrom" | "movedCount"> {
    const movedFrom = new Map<string, number>();
    for (const tabId of tabIds) {
      const holder = holderOf.get(tabId);
      if (holder !== undefined && holder !== into) {
        movedFrom.set(holder, (movedFrom.get(holder) ?? 0) + 1);
        membersOf.get(holder)?.delete(tabId);
      }
      holderOf.set(tabId, into);
      if (!membersOf.has(into)) membersOf.set(into, new Set());
      membersOf.get(into)!.add(tabId);
      claimed.add(tabId);
      placed.add(tabId);
    }
    const moved = [...movedFrom.values()].reduce((sum, count) => sum + count, 0);
    return {
      tabs: tabIds.slice(0, PLAN_LIMITS.titlesPerStep).map(titleOf),
      ...(tabIds.length > PLAN_LIMITS.titlesPerStep ? { moreTabs: tabIds.length - PLAN_LIMITS.titlesPerStep } : {}),
      movesFrom: [...movedFrom.keys()].slice(0, 3).map((id) => (collectionName.get(id) ?? "another collection").slice(0, 80)),
      ...(moved > 0 ? { movedCount: moved } : {}),
    };
  }

  /** The tabs an operation names, checked; a problem code when they cannot be used. */
  function checkTabs(tabIds: readonly string[]): PlanProblemCode | undefined {
    if (tabIds.length > PLAN_LIMITS.tabsPerOperation) return "too_many_tabs";
    if (!tabIds.every((tabId) => tabs.has(tabId))) return "unknown_tab";
    if (tabIds.some((tabId) => claimed.has(tabId))) return "tab_conflict";
    return undefined;
  }

  input.operations.forEach((raw, index) => {
    const read = readOperation(raw);
    if (typeof read === "string") {
      problems.push({ operation: index, code: read });
      return;
    }
    const extras = { ...(read.reason ? { reason: read.reason } : {}), ...(read.confidence ? { confidence: read.confidence } : {}) };

    switch (read.kind) {
      case "create_collection": {
        const name = cleanCollectionName(read.name);
        if (!name) return void problems.push({ operation: index, code: "empty_name" });
        if (names.has(nameKey(name))) return void problems.push({ operation: index, code: "duplicate_name" });
        if (read.tabIds.length === 0) return void problems.push({ operation: index, code: "no_tabs" });
        const bad = checkTabs(read.tabIds);
        if (bad) return void problems.push({ operation: index, code: bad });
        // Plan-created collections have no id yet; a key no real id can take (ids never hold control characters).
        const key = ` new:${index}`;
        names.set(nameKey(name), key);
        collectionName.set(key, name);
        operations.push({ kind: "create_collection", name, tabIds: [...read.tabIds], ...extras });
        steps.push({ kind: "create_collection", subject: name, tabCount: read.tabIds.length, ...place(read.tabIds, key), ...extras });
        return;
      }
      case "rename_collection": {
        const current = collectionName.get(read.collectionId);
        if (current === undefined) return void problems.push({ operation: index, code: "unknown_collection" });
        if (renamed.has(read.collectionId)) return void problems.push({ operation: index, code: "collection_conflict" });
        const name = cleanCollectionName(read.name);
        if (!name) return void problems.push({ operation: index, code: "empty_name" });
        if (name === current) return void problems.push({ operation: index, code: "no_change" });
        const owner = names.get(nameKey(name));
        if (owner !== undefined && owner !== read.collectionId) return void problems.push({ operation: index, code: "duplicate_name" });
        renamed.add(read.collectionId);
        names.delete(nameKey(current));
        names.set(nameKey(name), read.collectionId);
        collectionName.set(read.collectionId, name);
        const size = membersOf.get(read.collectionId)?.size ?? 0;
        operations.push({ kind: "rename_collection", collectionId: read.collectionId, name, ...extras });
        steps.push({
          kind: "rename_collection",
          subject: current,
          to: name,
          tabs: [],
          movesFrom: [],
          ...(size > 0 ? { tabCount: size } : {}),
          ...extras,
        });
        return;
      }
      case "add_tabs_to_collection": {
        const current = collectionName.get(read.collectionId);
        if (current === undefined) return void problems.push({ operation: index, code: "unknown_collection" });
        const bad = checkTabs(read.tabIds);
        if (bad) return void problems.push({ operation: index, code: bad });
        const members = membersOf.get(read.collectionId) ?? new Set<string>();
        const tabIds = read.tabIds.filter((tabId) => !members.has(tabId));
        if (tabIds.length === 0) return void problems.push({ operation: index, code: "no_change" });
        operations.push({ kind: "add_tabs_to_collection", collectionId: read.collectionId, tabIds, ...extras });
        steps.push({ kind: "add_tabs_to_collection", subject: current, tabCount: tabIds.length, ...place(tabIds, read.collectionId), ...extras });
        return;
      }
    }
  });

  if (problems.length === 0 && placed.size > PLAN_LIMITS.affectedTabs) problems.push({ code: "too_many_affected_tabs" });
  if (problems.length > 0) return refuse(problems);
  return {
    ok: true,
    plan: { workspaceId: held.workspaceId, basedOnVersion: held.version, operations, steps, tabCount: placed.size },
  };
}

/* ------------------------------------------------------------------ *
 * Describing a plan
 * ------------------------------------------------------------------ */

/** One line per step, as plain text — the approval's targets, and what an agent may quote. */
export function planStepLine(step: WorkspacePlanStep): string {
  const moves = step.movedCount
    ? ` (moves ${plural(step.movedCount, "tab", "tabs")} out of ${step.movesFrom.join(", ")}${step.movesFrom.length < 3 ? "" : ", …"})`
    : "";
  switch (step.kind) {
    case "create_collection":
      return `Create collection "${step.subject}" with ${plural(step.tabCount ?? 0, "tab", "tabs")}${moves}`;
    case "rename_collection":
      return `Rename collection "${step.subject}" to "${step.to ?? ""}"`;
    case "add_tabs_to_collection":
      return `Add ${plural(step.tabCount ?? 0, "tab", "tabs")} to "${step.subject}"${moves}`;
  }
}

export function previewOf(plan: ValidatedWorkspacePlan, planId: string): WorkspacePlanPreview {
  return {
    planId,
    basedOnVersion: plan.basedOnVersion,
    operationCount: plan.operations.length,
    tabCount: plan.tabCount,
    steps: plan.steps,
  };
}

/**
 * The plan in one canonical encoding, for hashing: fixed key order, nothing
 * optional left ambiguous. The same plan always encodes the same way; any
 * change to any operation changes the encoding.
 */
export function canonicalPlan(input: {
  sessionId: string;
  workspaceId: string;
  basedOnVersion: number;
  operations: readonly WorkspaceOperation[];
}): string {
  return JSON.stringify([
    "tabdump-plan/1",
    input.sessionId,
    input.workspaceId,
    input.basedOnVersion,
    input.operations.map((operation) => {
      switch (operation.kind) {
        case "create_collection":
          return [operation.kind, operation.name, [...operation.tabIds], operation.reason ?? null, operation.confidence ?? null];
        case "rename_collection":
          return [operation.kind, operation.collectionId, operation.name, operation.reason ?? null, operation.confidence ?? null];
        case "add_tabs_to_collection":
          return [operation.kind, operation.collectionId, [...operation.tabIds], operation.reason ?? null, operation.confidence ?? null];
      }
    }),
  ]);
}

/** What a plan changes, independent of when it was proposed — for comparing a plan re-validated later with the one approved. */
export function planEffect(plan: ValidatedWorkspacePlan): string {
  return JSON.stringify([plan.operations, plan.steps]);
}

/** Deep-frozen copies, so an approved plan cannot be edited in place by anything holding a reference. */
export function freezeOperations(operations: readonly WorkspaceOperation[]): readonly WorkspaceOperation[] {
  return Object.freeze(
    operations.map((operation) =>
      Object.freeze({ ...operation, ...("tabIds" in operation ? { tabIds: Object.freeze([...operation.tabIds]) } : {}) })
    )
  ) as readonly WorkspaceOperation[];
}

/* ------------------------------------------------------------------ *
 * Verification: did the workspace end up as approved?
 * ------------------------------------------------------------------ */

export type PlanVerification = {
  /** Every operation's result is visible in the workspace. */
  verified: boolean;
  results: readonly { index: number; kind: WorkspaceChangeKind; verified: boolean; collectionId?: string }[];
};

/**
 * Checks the workspace the session now holds against the approved operations.
 * `created` is the id of each collection a create made, in order, as the
 * Command Centre reported it — and a create is verified only if a collection
 * with that id, that name and those tabs is really there.
 */
export function verifyWorkspacePlan(
  snapshot: SessionContextSnapshot,
  operations: readonly WorkspaceOperation[],
  created: readonly string[]
): PlanVerification {
  const byId = new Map(snapshot.collections.map((collection) => [collection.id, collection]));
  let createIndex = 0;
  const results = operations.map((operation, index) => {
    switch (operation.kind) {
      case "create_collection": {
        const collectionId = created[createIndex++];
        const collection = collectionId ? byId.get(collectionId) : undefined;
        const members = new Set(collection?.tabIds ?? []);
        const verified =
          collection !== undefined &&
          collection.name === operation.name &&
          operation.tabIds.every((tabId) => members.has(tabId));
        return { index, kind: operation.kind, verified, ...(collectionId ? { collectionId } : {}) };
      }
      case "rename_collection": {
        const collection = byId.get(operation.collectionId);
        return { index, kind: operation.kind, verified: collection?.name === operation.name, collectionId: operation.collectionId };
      }
      case "add_tabs_to_collection": {
        const members = new Set(byId.get(operation.collectionId)?.tabIds ?? []);
        return {
          index,
          kind: operation.kind,
          verified: operation.tabIds.every((tabId) => members.has(tabId)),
          collectionId: operation.collectionId,
        };
      }
    }
  });
  return { verified: results.every((result) => result.verified), results };
}

/* ------------------------------------------------------------------ *
 * Reading a preview strictly (the approval broker's side)
 * ------------------------------------------------------------------ */

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function count(value: unknown, max = 100_000): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function readStep(raw: unknown): WorkspacePlanStep | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  if (!isWorkspaceChangeKind(source.kind)) return undefined;
  const subject = clean(source.subject, CHANGE_LIMITS.subject);
  if (!subject) return undefined;
  const to = clean(source.to, CHANGE_LIMITS.subject);
  if (source.kind === "rename_collection" && !to) return undefined;
  const list = (value: unknown, max: number, length: number) =>
    (Array.isArray(value) ? value : [])
      .map((entry) => clean(entry, length))
      .filter((entry): entry is string => entry !== undefined)
      .slice(0, max);
  const tabCount = count(source.tabCount);
  const moreTabs = count(source.moreTabs);
  const movedCount = count(source.movedCount);
  const reason = clean(source.reason, PLAN_LIMITS.reason);
  const confidence = readConfidence(source.confidence);
  return {
    kind: source.kind,
    subject,
    ...(to && source.kind === "rename_collection" ? { to } : {}),
    ...(tabCount !== undefined ? { tabCount } : {}),
    tabs: list(source.tabs, PLAN_LIMITS.titlesPerStep, 120),
    ...(moreTabs ? { moreTabs } : {}),
    movesFrom: list(source.movesFrom, 3, 80),
    ...(movedCount ? { movedCount } : {}),
    ...(reason ? { reason } : {}),
    ...(confidence ? { confidence } : {}),
  };
}

/** Reads a preview strictly, applying every bound. `undefined` for anything malformed — a plan that cannot be shown truthfully is not shown. */
export function readWorkspacePlanPreview(raw: unknown): WorkspacePlanPreview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const planId = readId(source.planId);
  const basedOnVersion = count(source.basedOnVersion, 1_000_000_000);
  const tabCount = count(source.tabCount);
  if (!planId || basedOnVersion === undefined || tabCount === undefined || !Array.isArray(source.steps)) return undefined;
  if (source.steps.length === 0 || source.steps.length > PLAN_LIMITS.operations) return undefined;
  const steps: WorkspacePlanStep[] = [];
  for (const entry of source.steps) {
    const step = readStep(entry);
    if (!step) return undefined;
    steps.push(step);
  }
  return { planId, basedOnVersion, operationCount: steps.length, tabCount, steps };
}
