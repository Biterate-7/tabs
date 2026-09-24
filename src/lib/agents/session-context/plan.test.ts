import { describe, expect, it } from "vitest";
import { applyCollectionBatch } from "@/lib/collections/batch";
import {
  PLAN_LIMITS,
  canonicalPlan,
  planStepLine,
  previewOf,
  readWorkspacePlanPreview,
  validateWorkspacePlan,
  verifyWorkspacePlan,
} from "./plan";
import { readSessionContextSnapshot } from "./snapshot";
import type { WorkspaceOperation } from "./plan";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * Plans (Phase J.5): validated against the bound workspace before anyone is
 * asked, described from the validated operations, hashed canonically, and
 * verified against the workspace afterwards.
 */

function tab(id: string, title = id) {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", title };
}

function snapshot(
  tabs = [tab("t1", "MIT admissions"), tab("t2", "Stanford essays"), tab("t3", "Physics lecture"), tab("t4", "Quantum notes"), tab("t5", "Recipes")],
  collections = [
    { id: "c1", workspaceId: "ws", name: "Collection 2", tabIds: ["t3"], createdAt: 1, updatedAt: 1 },
    { id: "c2", workspaceId: "ws", name: "Research", tabIds: [] as string[], createdAt: 1, updatedAt: 1 },
  ]
): SessionContextSnapshot {
  return readSessionContextSnapshot(
    { workspace: { id: "ws", name: "Launch Plan", createdAt: 1, updatedAt: 2, tabs }, collections, dependencies: [] },
    "ws"
  )!;
}

const HELD = { workspaceId: "ws", version: 7 };

function validate(operations: unknown, extra: Record<string, unknown> = {}, held = HELD, data = snapshot()) {
  return validateWorkspacePlan(data, { basedOnVersion: held.version, operations, ...extra }, held);
}

function codes(result: ReturnType<typeof validate>) {
  return result.ok ? [] : result.problems.map((problem) => [problem.operation, problem.code]);
}

describe("a valid plan", () => {
  it("is accepted, normalized, and described step by step — names and titles, never ids", () => {
    const result = validate([
      { kind: "create_collection", name: "  College   Research ", tabIds: ["t1", "t2", "t1"], reason: "Admissions\u0000 pages", confidence: "high" },
      { kind: "rename_collection", collectionId: "c1", name: "Physics" },
      { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t3", "t4"], confidence: "medium" },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.plan.operations).toEqual([
      { kind: "create_collection", name: "College Research", tabIds: ["t1", "t2"], reason: "Admissions pages", confidence: "high" },
      { kind: "rename_collection", collectionId: "c1", name: "Physics" },
      // t3 is already in it: only the tab that changes anything is kept.
      { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t4"], confidence: "medium" },
    ]);
    expect(result.plan.tabCount).toBe(3);
    const lines = result.plan.steps.map(planStepLine);
    expect(lines).toEqual([
      'Create collection "College Research" with 2 tabs',
      'Rename collection "Collection 2" to "Physics"',
      'Add 1 tab to "Physics"',
    ]);
    expect(result.plan.steps[0].tabs).toEqual(["MIT admissions", "Stanford essays"]);
    expect(JSON.stringify(result.plan.steps)).not.toMatch(/"t\d"|"c\d"|"ws"/);
  });

  it("says when tabs move out of another collection", () => {
    const result = validate([{ kind: "create_collection", name: "Physics", tabIds: ["t3", "t4"] }]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.steps[0]).toMatchObject({ movesFrom: ["Collection 2"], movedCount: 1 });
    expect(planStepLine(result.plan.steps[0])).toBe('Create collection "Physics" with 2 tabs (moves 1 tab out of Collection 2)');
  });
});

describe("refused before anyone is asked", () => {
  it("malformed, unknown or empty", () => {
    expect(codes(validate("not an array"))).toEqual([[undefined, "malformed"]]);
    expect(codes(validate([]))).toEqual([[undefined, "empty_plan"]]);
    expect(codes(validate([{ kind: "delete_collection", collectionId: "c1" }]))).toEqual([[0, "unknown_kind"]]);
    expect(codes(validate([{ kind: 7 }]))).toEqual([[0, "malformed"]]);
    expect(codes(validate([null, { kind: "create_collection", name: "X", tabIds: "t1" }]))).toEqual([
      [0, "malformed"],
      [1, "malformed"],
    ]);
    expect(codes(validate([{ kind: "create_collection", name: "X", tabIds: ["t1"], confidence: 0.93 }]))).toEqual([[0, "malformed"]]);
    expect(codes(validateWorkspacePlan(snapshot(), { basedOnVersion: "7", operations: [] }, HELD))).toEqual([[undefined, "malformed"]]);
  });

  it("oversized: too many operations, tabs per operation, tabs per plan, or bytes", () => {
    const one = { kind: "rename_collection", collectionId: "c1", name: "x" };
    expect(codes(validate(Array.from({ length: PLAN_LIMITS.operations + 1 }, () => one)))).toEqual([[undefined, "too_many_operations"]]);

    const many = Array.from({ length: 450 }, (_, index) => tab(`m${index}`));
    const big = snapshot(many, []);
    expect(codes(validate([{ kind: "create_collection", name: "Big", tabIds: many.slice(0, 201).map((entry) => entry.id) }], {}, HELD, big))).toEqual([
      [0, "too_many_tabs"],
    ]);
    const spread = [0, 1, 2].map((part) => ({
      kind: "create_collection",
      name: `Part ${part}`,
      tabIds: many.slice(part * 150, part * 150 + 150).map((entry) => entry.id),
    }));
    expect(codes(validate(spread, {}, HELD, big))).toEqual([[undefined, "too_many_affected_tabs"]]);
    expect(codes(validate([{ kind: "create_collection", name: "X", tabIds: ["t1"], reason: "y".repeat(60_000) }]))).toEqual([
      [undefined, "too_large"],
    ]);
  });

  it("another workspace, or a stale version", () => {
    expect(codes(validate([{ kind: "create_collection", name: "X", tabIds: ["t1"] }], { workspaceId: "ws-private" }))).toEqual([
      [undefined, "wrong_workspace"],
    ]);
    const stale = validateWorkspacePlan(snapshot(), { basedOnVersion: 6, operations: [{ kind: "create_collection", name: "X", tabIds: ["t1"] }] }, HELD);
    expect(stale).toEqual({ ok: false, problems: [{ code: "stale" }], currentVersion: 7 });
  });

  it("tabs and collections that are not this workspace's", () => {
    expect(codes(validate([{ kind: "create_collection", name: "X", tabIds: ["t1", "t-bank"] }]))).toEqual([[0, "unknown_tab"]]);
    expect(codes(validate([{ kind: "rename_collection", collectionId: "c-private", name: "Mine" }]))).toEqual([[0, "unknown_collection"]]);
    expect(codes(validate([{ kind: "add_tabs_to_collection", collectionId: "c-private", tabIds: ["t1"] }]))).toEqual([[0, "unknown_collection"]]);
    // A plan cannot name the collection it creates by a made-up id.
    expect(
      codes(
        validate([
          { kind: "create_collection", name: "New", tabIds: ["t1"] },
          { kind: "add_tabs_to_collection", collectionId: "\u0000new:0", tabIds: ["t2"] },
        ])
      )
    ).toEqual([[1, "malformed"]]);
  });

  it("duplicate names, conflicts, empty names and changes that change nothing", () => {
    expect(codes(validate([{ kind: "create_collection", name: "research", tabIds: ["t1"] }]))).toEqual([[0, "duplicate_name"]]);
    expect(
      codes(
        validate([
          { kind: "create_collection", name: "Admissions", tabIds: ["t1"] },
          { kind: "create_collection", name: "ADMISSIONS", tabIds: ["t2"] },
        ])
      )
    ).toEqual([[1, "duplicate_name"]]);
    expect(codes(validate([{ kind: "rename_collection", collectionId: "c1", name: "Research" }]))).toEqual([[0, "duplicate_name"]]);
    expect(
      codes(
        validate([
          { kind: "create_collection", name: "A", tabIds: ["t1"] },
          { kind: "add_tabs_to_collection", collectionId: "c2", tabIds: ["t1"] },
        ])
      )
    ).toEqual([[1, "tab_conflict"]]);
    expect(
      codes(
        validate([
          { kind: "rename_collection", collectionId: "c1", name: "A" },
          { kind: "rename_collection", collectionId: "c1", name: "B" },
        ])
      )
    ).toEqual([[1, "collection_conflict"]]);
    expect(codes(validate([{ kind: "rename_collection", collectionId: "c1", name: " \u0007 " }]))).toEqual([[0, "empty_name"]]);
    expect(codes(validate([{ kind: "rename_collection", collectionId: "c1", name: "Collection 2" }]))).toEqual([[0, "no_change"]]);
    expect(codes(validate([{ kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t3"] }]))).toEqual([[0, "no_change"]]);
    expect(codes(validate([{ kind: "create_collection", name: "Empty", tabIds: [] }]))).toEqual([[0, "no_tabs"]]);
  });

  it("allows renaming a collection to a different case of its own name", () => {
    expect(validate([{ kind: "rename_collection", collectionId: "c2", name: "RESEARCH" }]).ok).toBe(true);
  });
});

describe("hash, preview and verification", () => {
  const operations: WorkspaceOperation[] = [
    { kind: "create_collection", name: "College Research", tabIds: ["t1", "t2"] },
    { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t4"] },
  ];

  it("encodes a plan canonically: the same plan the same way, any change differently", () => {
    const base = { sessionId: "s1", workspaceId: "ws", basedOnVersion: 7, operations };
    expect(canonicalPlan(base)).toBe(canonicalPlan({ ...base, operations: operations.map((operation) => ({ ...operation })) }));
    const variants = [
      { ...base, sessionId: "s2" },
      { ...base, workspaceId: "other" },
      { ...base, basedOnVersion: 8 },
      { ...base, operations: [{ ...operations[0], name: "College research" }, operations[1]] },
      { ...base, operations: [{ ...operations[0], tabIds: ["t2", "t1"] }, operations[1]] },
      { ...base, operations: [operations[1], operations[0]] },
      { ...base, operations: [{ ...operations[0], reason: "why" }, operations[1]] },
    ];
    for (const variant of variants) expect(canonicalPlan(variant)).not.toBe(canonicalPlan(base));
  });

  it("verifies against the workspace, operation by operation — and catches a state that does not match", () => {
    const data = snapshot();
    const applied = applyCollectionBatch(data.collections, { workspaceId: "ws", tabIds: new Set(data.workspace.tabs.map((entry) => entry.id)) }, operations, 10);
    if (!applied.ok) throw new Error("apply failed");
    const after = { ...data, collections: applied.collections };
    expect(verifyWorkspacePlan(after, operations, applied.created)).toEqual({
      verified: true,
      results: [
        { index: 0, kind: "create_collection", verified: true, collectionId: applied.created[0] },
        { index: 1, kind: "add_tabs_to_collection", verified: true, collectionId: "c1" },
      ],
    });
    // Nothing applied at all.
    expect(verifyWorkspacePlan(data, operations, applied.created).verified).toBe(false);
    // An id that exists but is not what the plan created.
    expect(verifyWorkspacePlan(after, operations, ["c2"]).results[0].verified).toBe(false);
    // Half applied: the create landed, the add did not.
    const half = { ...data, collections: applied.collections.map((collection) => (collection.id === "c1" ? data.collections[0] : collection)) };
    expect(verifyWorkspacePlan(half, operations, applied.created).results.map((result) => result.verified)).toEqual([true, false]);
  });

  it("reads a preview strictly: every bound applied, anything malformed dropped", () => {
    const result = validate([{ kind: "create_collection", name: "College Research", tabIds: ["t1"], reason: "because", confidence: "unclear" }]);
    if (!result.ok) throw new Error("expected ok");
    const preview = previewOf(result.plan, "plan-1");
    expect(readWorkspacePlanPreview(JSON.parse(JSON.stringify(preview)))).toEqual(preview);
    expect(readWorkspacePlanPreview({ ...preview, steps: [] })).toBeUndefined();
    expect(readWorkspacePlanPreview({ ...preview, planId: "" })).toBeUndefined();
    expect(readWorkspacePlanPreview({ ...preview, steps: [{ kind: "drop_table", subject: "x" }] })).toBeUndefined();
    const noisy = readWorkspacePlanPreview({ ...preview, steps: [{ ...preview.steps[0], subject: "a\u0000b", tabs: Array(99).fill("t"), confidence: 0.9 }] });
    expect(noisy?.steps[0]).toMatchObject({ subject: "a b" });
    expect(noisy?.steps[0].tabs).toHaveLength(PLAN_LIMITS.titlesPerStep);
    expect(noisy?.steps[0].confidence).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Properties, over seeded random plans (no new framework: a small PRNG)
 * ------------------------------------------------------------------ */

function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("properties over random plans", () => {
  const OWN_TABS = ["t1", "t2", "t3", "t4", "t5"];
  const FOREIGN = ["t-bank", "w2-tab-0", "../t1", "t1 ", "", "c1", "\u0000new:0"];
  const COLLECTIONS = ["c1", "c2", "c-private", "ws-private-c1", ""];
  const KINDS = ["create_collection", "rename_collection", "add_tabs_to_collection", "delete_collection", "run_script", 3, null];

  function randomPlan(random: () => number) {
    const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
    const count = Math.floor(random() * 6);
    return Array.from({ length: count }, () => {
      const ids = Array.from({ length: Math.floor(random() * 4) }, () => (random() < 0.75 ? pick(OWN_TABS) : pick(FOREIGN)));
      return {
        kind: pick(KINDS),
        name: random() < 0.9 ? `Name ${Math.floor(random() * 4)}` : pick(["", "  ", 42, "Research"]),
        collectionId: pick(COLLECTIONS),
        tabIds: random() < 0.95 ? ids : "t1",
        ...(random() < 0.2 ? { confidence: pick(["high", "low", 1]) } : {}),
      };
    });
  }

  it("never accepts a plan naming anything outside the bound workspace, and every accepted plan applies cleanly and verifies", () => {
    const random = prng(0x5eed);
    let accepted = 0;
    for (let round = 0; round < 3000; round += 1) {
      const data = snapshot();
      const operations = randomPlan(random);
      const result = validate(operations, random() < 0.1 ? { workspaceId: "ws-private" } : {}, HELD, data);
      if (!result.ok) {
        expect(result.problems.length).toBeGreaterThan(0);
        continue;
      }
      accepted += 1;
      const own = new Set(data.workspace.tabs.map((entry) => entry.id));
      const ownCollections = new Set(data.collections.map((collection) => collection.id));
      for (const operation of result.plan.operations) {
        expect(["create_collection", "rename_collection", "add_tabs_to_collection"]).toContain(operation.kind);
        if ("tabIds" in operation) for (const tabId of operation.tabIds) expect(own.has(tabId)).toBe(true);
        if ("collectionId" in operation) expect(ownCollections.has(operation.collectionId)).toBe(true);
      }
      // Accepted means applicable: the store's batch takes it whole, and the result verifies.
      const applied = applyCollectionBatch(data.collections, { workspaceId: "ws", tabIds: own }, result.plan.operations, 1);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(verifyWorkspacePlan({ ...data, collections: applied.collections }, result.plan.operations, applied.created).verified).toBe(true);
      }
    }
    // The generator does produce valid plans, so the property is not vacuous.
    expect(accepted).toBeGreaterThan(50);
  });

  it("always rejects oversized plans and stale versions, whatever they contain", () => {
    const random = prng(42);
    for (let round = 0; round < 300; round += 1) {
      const size = PLAN_LIMITS.operations + 1 + Math.floor(random() * 40);
      const operations = Array.from({ length: size }, () => ({ kind: "create_collection", name: `N${round}`, tabIds: ["t1"] }));
      expect(validate(operations).ok).toBe(false);
      const version = Math.floor(random() * 100);
      if (version !== HELD.version) {
        expect(validateWorkspacePlan(snapshot(), { basedOnVersion: version, operations: operations.slice(0, 1) }, HELD).ok).toBe(false);
      }
    }
  });
});
