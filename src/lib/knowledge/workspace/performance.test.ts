import { describe, expect, it } from "vitest";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { largeSnapshot } from "./__fixtures__/reasoning";
import { domainBreakdown, duplicateTabGroups, possibleDuplicateTabGroups, searchWorkspaceTabs, summarizeWorkspace } from "./insight";
import { validateWorkspacePlan, verifyWorkspacePlan } from "./plan";
import { findRelatedTabs, rankCollections, recommendPlacement } from "./relevance";
import { readWorkspaceSnapshot } from "./snapshot";
import { termIndex } from "./terms";
import { analyzeTopics } from "./topics";
import type { WorkspaceSnapshot } from "./snapshot";

/**
 * Workspace reasoning stays negligible next to a model turn.
 *
 * The in-process half of the J.5 and J.6 benchmarks, kept when the agent
 * session server they also measured was removed: the same code now answers
 * the AI connectors' MCP tools (lib/integrations), so its cost still matters.
 * Workloads of 50 tabs / 5 collections and 800 tabs / 30. Ceilings are loose
 * (the suite runs under load).
 */

function stats(samples: number[]): { p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(2);
  return { p50: at(0.5), p95: at(0.95) };
}

function time(runs: number, fn: () => void): { p50: number; p95: number } {
  const samples: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return stats(samples);
}

/** A structurally new snapshot with the same content: what a sync that changed something produces. */
function fresh(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return readWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)), snapshot.workspace.id)!;
}

const TOPICS = ["admissions", "physics", "pricing", "press", "recipes", "travel", "finance", "design"];

function workload(tabCount: number, collectionCount: number) {
  const tabs = Array.from({ length: tabCount }, (_, index) => {
    const topic = TOPICS[index % TOPICS.length];
    const url = `https://${topic}.example.com/page/${index % (tabCount - 10)}`;
    return { id: `t${index}`, url, normalizedUrl: url, domain: `${topic}.example.com`, title: `${topic} reading ${index}` };
  });
  const collections = Array.from({ length: collectionCount }, (_, index) => ({
    id: `c${index}`,
    workspaceId: "ws",
    name: `Collection ${index}`,
    tabIds: tabs.slice(index * 5, index * 5 + 5).map((entry) => entry.id),
    createdAt: 1,
    updatedAt: 1,
  }));
  return { workspace: { id: "ws", name: "Launch Plan", createdAt: 1, updatedAt: 2, tabs }, collections, dependencies: [] };
}

function planFor(tabCount: number, collectionCount: number) {
  const free = Array.from({ length: tabCount - collectionCount * 5 }, (_, index) => `t${collectionCount * 5 + index}`);
  return [
    { kind: "create_collection", name: "Research", tabIds: free.slice(0, 40) },
    { kind: "create_collection", name: "Product", tabIds: free.slice(40, 60) },
    { kind: "rename_collection", collectionId: "c0", name: "Renamed" },
    { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: free.slice(60, 70) },
  ].filter((operation) => operation.kind === "rename_collection" || (operation.tabIds?.length ?? 0) > 0);
}

describe.each([
  ["small", 50, 5],
  ["medium", 800, 30],
] as const)("%s workspace (%i tabs, %i collections)", (label, tabCount, collectionCount) => {
  it("keeps summary, search, planning, execution and verification negligible", () => {
    const snapshot = readWorkspaceSnapshot(workload(tabCount, collectionCount), "ws")!;
    const operations = planFor(tabCount, collectionCount);
    const held = { workspaceId: "ws", version: 1 };
    const validated = validateWorkspacePlan(snapshot, { basedOnVersion: 1, operations }, held);
    if (!validated.ok) throw new Error(JSON.stringify(validated.problems));
    const scope = { workspaceId: "ws", tabIds: new Set(snapshot.workspace.tabs.map((entry) => entry.id)) };
    const applied = applyCollectionBatch(snapshot.collections, scope, validated.plan.operations, 1);
    if (!applied.ok) throw new Error("apply failed");
    const after = { ...snapshot, collections: applied.collections };

    const measures = {
      summary: time(40, () => summarizeWorkspace(snapshot)),
      duplicates: time(40, () => duplicateTabGroups(snapshot)),
      search: time(40, () => searchWorkspaceTabs(snapshot, "physics reading", { limit: 25 })),
      validate: time(40, () => validateWorkspacePlan(snapshot, { basedOnVersion: 1, operations }, held)),
      execute: time(40, () => applyCollectionBatch(snapshot.collections, scope, validated.plan.operations, 1)),
      verify: time(40, () => verifyWorkspacePlan(after, validated.plan.operations, applied.created)),
    };
    for (const [name, measure] of Object.entries(measures)) expect(measure.p50, `${label} ${name}`).toBeLessThan(50);
  });

  it("keeps topic analysis, related-tab search and collection reasoning negligible, and its cache bounded", () => {
    const snapshot = largeSnapshot(tabCount, collectionCount);
    const groups = analyzeTopics(snapshot).groups;
    const copies = Array.from({ length: 20 }, () => fresh(snapshot));
    let next = 0;
    const measures = {
      analyzeCold: time(20, () => analyzeTopics(copies[next++]!)),
      analyzeCached: time(40, () => analyzeTopics(snapshot)),
      termIndexCold: time(20, () => termIndex(fresh(snapshot))),
      relatedByQuery: time(40, () => findRelatedTabs(snapshot, { query: "astronomy lecture", limit: 50 })),
      relatedByTabs: time(40, () => findRelatedTabs(snapshot, { tabIds: groups[0]!.tabIds.slice(0, 5) })),
      rankCollections: time(40, () => rankCollections(snapshot, { query: "chemistry", tabIds: groups[1]!.tabIds })),
      placementAllGroups: time(20, () => {
        for (const group of groups) recommendPlacement(snapshot, { tabIds: group.tabIds, name: group.label, terms: group.terms, confidence: group.confidence });
      }),
      domains: time(40, () => domainBreakdown(snapshot)),
      possibleDuplicates: time(40, () => possibleDuplicateTabGroups(snapshot)),
    };
    for (const [name, measure] of Object.entries(measures)) expect(measure.p50, `${label} ${name}`).toBeLessThan(label === "small" ? 25 : 150);

    // What the per-snapshot cache holds beyond the snapshot itself, as serialized size — a stable proxy for its memory.
    const index = termIndex(snapshot);
    const cachedBytes =
      JSON.stringify(index.entries.map(({ terms, titleKey, siteTerms, site, siteName }) => ({ terms, titleKey, siteTerms, site, siteName }))).length +
      JSON.stringify([...index.documentFrequency, ...index.display]).length +
      JSON.stringify(analyzeTopics(snapshot)).length;
    expect(cachedBytes).toBeLessThan(JSON.stringify(snapshot).length * 2);
  });
});
