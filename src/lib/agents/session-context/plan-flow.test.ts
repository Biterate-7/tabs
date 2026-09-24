import { describe, expect, it } from "vitest";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { APPLY_TIMEOUT_MS, CONTEXT_TOKEN_PREFIX, createSessionContextRegistry } from "./registry";
import type { ApprovalOutcome, ContextApprovalRequest, SessionContextRegistry } from "./registry";

/**
 * A plan's life in the registry (Phase J.5): refused before anyone is asked,
 * put to the user as one exact plan, bound to its session, workspace and
 * version, applied once by the one party that may, and verified against the
 * synced workspace.
 */

function tab(id: string, title = id) {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", title };
}

const TABS = [tab("t1", "MIT admissions"), tab("t2", "Stanford essays"), tab("t3", "Physics lecture"), tab("t4", "Quantum notes")];

function snapshot(collections: { id: string; name: string; tabIds: string[] }[] = [{ id: "c1", name: "Collection 2", tabIds: ["t3"] }], workspaceId = "ws") {
  return {
    workspace: { id: workspaceId, name: "Launch Plan", createdAt: 1, updatedAt: 2, tabs: TABS },
    collections: collections.map((collection) => ({ ...collection, workspaceId, createdAt: 1, updatedAt: 1 })),
    dependencies: [],
  };
}

const PLAN = [
  { kind: "create_collection", name: "College Research", tabIds: ["t1", "t2"] },
  { kind: "rename_collection", collectionId: "c1", name: "Physics" },
  { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t4"] },
];

type Harness = {
  registry: SessionContextRegistry;
  asked: ContextApprovalRequest[];
  answer: (outcome: ApprovalOutcome) => void;
  timers: (() => void)[];
};

async function harness(access: "read" | "read_write" = "read_write"): Promise<Harness> {
  const asked: ContextApprovalRequest[] = [];
  const answers: ((outcome: ApprovalOutcome) => void)[] = [];
  const timers: (() => void)[] = [];
  const registry = createSessionContextRegistry({
    approve: (request) => {
      asked.push(request);
      return new Promise((resolve) => answers.push(resolve));
    },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => {},
  });
  await registry.bind({ sessionId: "s1", ownerId: "o", workspaceId: "ws", access, snapshot: snapshot() });
  return { registry, asked, answer: (outcome) => answers.shift()?.(outcome), timers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !predicate(); tries += 1) await flush();
  if (!predicate()) throw new Error("timed out");
}

/** Plays the Command Centre: applies the approved plan with the store's batch, syncs, then reports. */
function applyAsCommandCentre(h: Harness, override: { planHash?: string; created?: string[]; skipSync?: boolean } = {}) {
  const [action] = h.registry.pendingApplications("s1");
  if (!action?.plan) throw new Error("no approved plan");
  const held = h.registry.binding("s1")!.snapshot;
  const applied = applyCollectionBatch(held.collections, { workspaceId: "ws", tabIds: new Set(held.workspace.tabs.map((entry) => entry.id)) }, action.plan.operations, 5);
  if (!applied.ok) throw new Error("apply failed");
  if (!override.skipSync) h.registry.update("s1", { ...held, collections: applied.collections });
  return h.registry.complete("s1", action.id, {
    ok: true,
    planHash: override.planHash ?? action.plan.hash,
    created: override.created ?? applied.created,
  });
}

describe("before anyone is asked", () => {
  it("refuses a malformed, foreign or stale plan — and a read-only session — without an approval", async () => {
    const h = await harness();
    expect(await h.registry.requestPlan("s1", { basedOnVersion: 1, operations: [{ kind: "drop", collectionId: "c1" }] })).toMatchObject({
      ok: false,
      reason: "invalid",
      problems: [{ operation: 0, code: "unknown_kind" }],
    });
    expect(await h.registry.requestPlan("s1", { basedOnVersion: 1, operations: [{ kind: "create_collection", name: "X", tabIds: ["t-bank"] }] })).toMatchObject({
      reason: "invalid",
    });
    expect(await h.registry.requestPlan("s1", { basedOnVersion: 1, workspaceId: "ws-private", operations: PLAN })).toMatchObject({ reason: "invalid" });
    expect(await h.registry.requestPlan("s1", { basedOnVersion: 0, operations: PLAN })).toEqual({ ok: false, reason: "stale", currentVersion: 1 });
    expect(await h.registry.requestPlan("nobody", { basedOnVersion: 1, operations: PLAN })).toEqual({ ok: false, reason: "ended" });
    expect(h.asked).toEqual([]);

    const readOnly = await harness("read");
    expect(await readOnly.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN })).toEqual({ ok: false, reason: "not_permitted" });
    // A read-only session can still check what a plan would do.
    expect(readOnly.registry.previewPlan("s1", { basedOnVersion: 1, operations: PLAN })).toMatchObject({ ok: true, canApply: false });
    expect(readOnly.asked).toEqual([]);
  });

  it("previews exactly what the user would be shown, and asks no one", async () => {
    const h = await harness();
    const preview = h.registry.previewPlan("s1", { basedOnVersion: 1, operations: PLAN });
    expect(preview).toMatchObject({
      ok: true,
      canApply: true,
      lines: [
        'Create collection "College Research" with 2 tabs',
        'Rename collection "Collection 2" to "Physics"',
        'Add 1 tab to "Physics"',
      ],
    });
    expect(h.asked).toEqual([]);
    expect(h.registry.pendingApplications("s1")).toEqual([]);
  });
});

describe("approval", () => {
  it("asks once, for the exact plan — every step, the workspace, no ids and no credential — and applies nothing before the answer", async () => {
    const h = await harness();
    void h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    const request = h.asked[0];
    expect(request).toMatchObject({ sessionId: "s1", workspaceId: "ws", reason: "Apply 3 changes to this workspace." });
    expect(request.targets).toEqual([
      'Create collection "College Research" with 2 tabs',
      'Rename collection "Collection 2" to "Physics"',
      'Add 1 tab to "Physics"',
    ]);
    expect(request.plan).toMatchObject({ operationCount: 3, basedOnVersion: 1, tabCount: 3 });
    expect(request.change).toBeUndefined();
    const shown = JSON.stringify({ targets: request.targets, plan: request.plan, reason: request.reason });
    expect(shown).not.toMatch(/"t\d"|"c1"|"ws"|tdctx_|Bearer/);
    expect(shown).not.toContain(CONTEXT_TOKEN_PREFIX);
    expect(h.registry.pendingApplications("s1")).toEqual([]);
  });

  it("changes nothing when declined or expired, and says so", async () => {
    const h = await harness();
    const declined = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    h.answer("denied");
    expect(await declined).toEqual({ ok: false, reason: "denied" });
    expect(h.registry.pendingApplications("s1")).toEqual([]);

    const expired = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 2);
    h.answer("expired");
    expect(await expired).toEqual({ ok: false, reason: "expired" });
    expect(h.registry.binding("s1")?.version).toBe(1);
    expect(h.registry.planOutcomes("s1").map((outcome) => outcome.status)).toEqual(["denied", "expired"]);
  });
});

describe("execution and verification", () => {
  it("applies an approved plan once, verifies it against the synced workspace, and reports the new version", async () => {
    const h = await harness();
    const result = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);

    const [action] = h.registry.pendingApplications("s1");
    expect(action.plan?.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.isFrozen(action.plan?.operations)).toBe(true);
    expect(applyAsCommandCentre(h)).toBe(true);

    const outcome = await result;
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome).toMatchObject({ basedOnVersion: 1, contextVersion: 2, verified: true });
    expect(outcome.results.map((entry) => [entry.verified, entry.line])).toEqual([
      [true, 'Create collection "College Research" with 2 tabs'],
      [true, 'Rename collection "Collection 2" to "Physics"'],
      [true, 'Add 1 tab to "Physics"'],
    ]);
    expect(h.registry.planOutcomes("s1")).toMatchObject([{ status: "applied", operationCount: 3, verifiedCount: 3, contextVersion: 2 }]);
    // The agent can see what changed since the version it planned against.
    expect(h.registry.changesSince("s1", 1)?.collections.changed.length).toBe(2);

    // Replayed: nothing left to complete, and nothing is listed to apply again.
    expect(h.registry.complete("s1", action.id, { ok: true, planHash: action.plan!.hash, created: outcome.results.flatMap((entry) => (entry.kind === "create_collection" ? [entry.collectionId!] : [])) })).toBe(false);
    expect(h.registry.pendingApplications("s1")).toEqual([]);
  });

  it("refuses to complete with a different plan, the wrong session, a single change's answer, or made-up created ids", async () => {
    const h = await harness();
    await h.registry.bind({ sessionId: "s2", ownerId: "o", workspaceId: "ws", access: "read_write", snapshot: snapshot() });
    void h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);
    const [action] = h.registry.pendingApplications("s1");

    expect(h.registry.complete("s1", action.id, { ok: true, planHash: "a-different-plan", created: ["x"] })).toBe(false);
    expect(h.registry.complete("s2", action.id, { ok: true, planHash: action.plan!.hash, created: ["x"] })).toBe(false);
    expect(h.registry.complete("s1", action.id, { ok: true, collectionId: "c1" })).toBe(false);
    expect(h.registry.complete("s1", action.id, { ok: true, planHash: action.plan!.hash, created: [] })).toBe(false);
    expect(h.registry.complete("s1", action.id, { ok: true, planHash: action.plan!.hash, created: ["x", "y"] })).toBe(false);
    // Still waiting for a truthful answer.
    expect(h.registry.pendingApplications("s1")).toHaveLength(1);
  });

  it("says so when the workspace does not show what was reported — applied, not verified", async () => {
    const h = await harness();
    const result = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);
    // Reported applied, but the result never synced.
    expect(applyAsCommandCentre(h, { skipSync: true })).toBe(true);
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: true, verified: false, contextVersion: 1 });
    expect(h.registry.planOutcomes("s1")).toMatchObject([{ status: "unverified", verifiedCount: 0 }]);
  });

  it("reports a plan the Command Centre could not apply — and which operation — with nothing changed", async () => {
    const h = await harness();
    const result = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);
    const [action] = h.registry.pendingApplications("s1");
    expect(h.registry.complete("s1", action.id, { ok: false, failedAt: 2 })).toBe(true);
    expect(await result).toEqual({ ok: false, reason: "not_applied", failedAt: 2 });
    expect(h.registry.binding("s1")?.version).toBe(1);
  });

  it("gives up on an approved plan nobody applies", async () => {
    const h = await harness();
    const result = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    h.answer("granted");
    await until(() => h.timers.length === 1);
    expect(APPLY_TIMEOUT_MS).toBe(60_000);
    h.timers[0]();
    expect(await result).toEqual({ ok: false, reason: "not_applied" });
    expect(h.registry.pendingApplications("s1")).toEqual([]);
  });
});

describe("staleness", () => {
  it("refuses a plan whose workspace changed materially while the user decided; applies nothing", async () => {
    const h = await harness();
    const result = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    // Meanwhile, the user renamed the collection the plan renames.
    h.registry.update("s1", snapshot([{ id: "c1", name: "Physics", tabIds: ["t3"] }]));
    h.answer("granted");
    expect(await result).toEqual({ ok: false, reason: "stale", currentVersion: 2 });
    expect(h.registry.pendingApplications("s1")).toEqual([]);
    expect(h.registry.planOutcomes("s1")).toMatchObject([{ status: "stale" }]);
  });

  it("refuses a plan that would still validate but now does something the user was not shown", async () => {
    const h = await harness();
    const result = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    // Meanwhile, the user filed t4 in a new collection. The plan still
    // validates — but adding t4 would now pull it out of "Inbox", which the
    // card the user is looking at never said.
    h.registry.update("s1", snapshot([{ id: "c1", name: "Collection 2", tabIds: ["t3"] }, { id: "c9", name: "Inbox", tabIds: ["t4"] }]));
    h.answer("granted");
    expect(await result).toEqual({ ok: false, reason: "stale", currentVersion: 2 });
    expect(h.registry.pendingApplications("s1")).toEqual([]);
  });

  it("still applies a plan whose effect is unchanged by an unrelated edit — then a refreshed plan succeeds", async () => {
    const h = await harness();
    const result = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    // An unrelated collection appears: nothing the plan does or shows changes.
    h.registry.update("s1", snapshot([{ id: "c1", name: "Collection 2", tabIds: ["t3"] }, { id: "c9", name: "Elsewhere", tabIds: [] }]));
    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);
    expect(applyAsCommandCentre(h)).toBe(true);
    expect(await result).toMatchObject({ ok: true, verified: true, basedOnVersion: 1, contextVersion: 3 });

    // The old version is now stale; a plan made against the current one goes through.
    expect(await h.registry.requestPlan("s1", { basedOnVersion: 1, operations: [{ kind: "rename_collection", collectionId: "c9", name: "Misc" }] })).toMatchObject({
      reason: "stale",
      currentVersion: 3,
    });
    const refreshed = h.registry.requestPlan("s1", { basedOnVersion: 3, operations: [{ kind: "rename_collection", collectionId: "c9", name: "Misc" }] });
    await until(() => h.asked.length === 2);
    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);
    expect(applyAsCommandCentre(h)).toBe(true);
    expect(await refreshed).toMatchObject({ ok: true, verified: true, contextVersion: 4 });
  });
});

describe("the session ending", () => {
  it("answers a waiting plan as ended and forgets its outcomes", async () => {
    const h = await harness();
    const result = h.registry.requestPlan("s1", { basedOnVersion: 1, operations: PLAN });
    await until(() => h.asked.length === 1);
    h.registry.release("s1");
    h.answer("granted");
    expect(await result).toEqual({ ok: false, reason: "ended" });
    expect(h.registry.planOutcomes("s1")).toEqual([]);
    expect(h.registry.pendingApplications("s1")).toEqual([]);
  });
});
