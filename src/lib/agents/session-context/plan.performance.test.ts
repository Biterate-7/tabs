// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { createSessionContextServer } from "./http";
import { duplicateTabGroups, searchWorkspaceTabs, summarizeWorkspace } from "./insight";
import { validateWorkspacePlan, verifyWorkspacePlan } from "./plan";
import { createSessionContextRegistry } from "./registry";
import { readSessionContextSnapshot } from "./snapshot";
import type { SessionContextServer } from "./http";

/**
 * Workspace intelligence stays negligible next to a model turn (Phase J.5).
 *
 * Two representative workloads — 50 tabs / 5 collections and 800 tabs / 30
 * collections — measured in-process and over the real loopback MCP server.
 * The bounds asserted are deliberately loose (the suite runs under load);
 * the printed p50/p95 are the numbers documented in §14.
 */

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

function stats(samples: number[]): { p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2);
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

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe.each([
  ["small", 50, 5],
  ["medium", 800, 30],
] as const)("%s workspace (%i tabs, %i collections)", (label, tabCount, collectionCount) => {
  it("keeps summary, search, planning, execution and verification negligible", async () => {
    const raw = workload(tabCount, collectionCount);
    const snapshot = readSessionContextSnapshot(raw, "ws")!;
    const operations = planFor(tabCount, collectionCount);
    const held = { workspaceId: "ws", version: 1 };
    const validated = validateWorkspacePlan(snapshot, { basedOnVersion: 1, operations }, held);
    if (!validated.ok) throw new Error(JSON.stringify(validated.problems));
    const scope = { workspaceId: "ws", tabIds: new Set(snapshot.workspace.tabs.map((entry) => entry.id)) };
    const applied = applyCollectionBatch(snapshot.collections, scope, validated.plan.operations, 1);
    if (!applied.ok) throw new Error("apply failed");
    const after = { ...snapshot, collections: applied.collections };

    const inProcess = {
      summary: time(40, () => summarizeWorkspace(snapshot)),
      duplicates: time(40, () => duplicateTabGroups(snapshot)),
      search: time(40, () => searchWorkspaceTabs(snapshot, "physics reading", { limit: 25 })),
      validate: time(40, () => validateWorkspacePlan(snapshot, { basedOnVersion: 1, operations }, held)),
      execute: time(40, () => applyCollectionBatch(snapshot.collections, scope, validated.plan.operations, 1)),
      verify: time(40, () => verifyWorkspacePlan(after, validated.plan.operations, applied.created)),
    };

    // Over the real loopback server, with the official client.
    let clock = 0;
    const registry = createSessionContextRegistry({ approve: async () => "granted", setTimer: () => clock++, clearTimer: () => {} });
    const server = createSessionContextServer({ registry });
    servers.push(server);
    const bound = await registry.bind({ sessionId: "s1", ownerId: "local", workspaceId: "ws", access: "read_write", snapshot: raw });
    const client = new Client({ name: "bench", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(await server.url()), { requestInit: { headers: { Authorization: `Bearer ${bound!.token}` } } })
    );
    async function timeCall(runs: number, name: string, args: Record<string, unknown>) {
      const samples: number[] = [];
      for (let run = 0; run < runs; run += 1) {
        const start = performance.now();
        const result = await client.callTool({ name, arguments: args });
        samples.push(performance.now() - start);
        expect(result.isError, name).not.toBe(true);
      }
      return stats(samples);
    }
    const overMcp = {
      summary: await timeCall(20, "get_workspace_summary", {}),
      search: await timeCall(20, "search_tabs", { query: "physics reading", maxResults: 25 }),
      preview: await timeCall(20, "preview_workspace_plan", { basedOnVersion: 1, operations }),
    };

    // Approval + execution + version + verification machinery, human excluded.
    const machinery: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      const version = registry.binding("s1")!.version;
      const current = registry.binding("s1")!.snapshot;
      const plan = [{ kind: "rename_collection", collectionId: "c2", name: `Round ${round}` }];
      const start = performance.now();
      const pending = registry.requestPlan("s1", { basedOnVersion: version, operations: plan });
      // Hashing is async Web Crypto; under a loaded suite it can take more than a few ticks.
      const deadline = Date.now() + 5_000;
      while (registry.pendingApplications("s1").length === 0 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
      const [action] = registry.pendingApplications("s1");
      if (!action?.plan) throw new Error("the plan was never approved");
      const result = applyCollectionBatch(current.collections, scope, action.plan!.operations, 1);
      if (!result.ok) throw new Error("apply failed");
      registry.update("s1", { ...current, collections: result.collections });
      registry.complete("s1", action.id, { ok: true, planHash: action.plan!.hash, created: result.created });
      const outcome = await pending;
      machinery.push(performance.now() - start);
      expect(outcome).toMatchObject({ ok: true, verified: true, contextVersion: version + 1 });
    }
    const approvalToVerified = stats(machinery);
    await client.close();

    console.log(`[J.5 bench] ${label}`, JSON.stringify({ inProcess, overMcp, approvalToVerified }));
    // Loose ceilings: an order of magnitude below a model turn even on a loaded machine.
    for (const measure of Object.values(inProcess)) expect(measure.p50).toBeLessThan(50);
    for (const measure of Object.values(overMcp)) expect(measure.p50).toBeLessThan(250);
    expect(approvalToVerified.p50).toBeLessThan(250);
  }, 60_000);
});
