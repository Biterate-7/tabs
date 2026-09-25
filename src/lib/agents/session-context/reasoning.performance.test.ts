// @vitest-environment node
import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { largeSnapshot } from "./__fixtures__/reasoning";
import { createSessionContextServer } from "./http";
import { domainBreakdown, possibleDuplicateTabGroups } from "./insight";
import { findRelatedTabs, rankCollections, recommendPlacement } from "./relevance";
import { createSessionContextRegistry } from "./registry";
import { readSessionContextSnapshot } from "./snapshot";
import { termIndex } from "./terms";
import { analyzeTopics } from "./topics";
import type { SessionContextServer } from "./http";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * Workspace reasoning stays negligible next to a model turn (Phase J.6).
 *
 * The J.5 workloads' sizes — 50 tabs / 5 collections and 800 tabs / 30 — with
 * titles spread over ten subjects and five sites. Measured in-process (cold:
 * a fresh snapshot, as after a sync; cached: the same snapshot again) and over
 * the real loopback MCP server, plus answer sizes against paging the whole
 * workspace, which is what an agent without these tools would have to read.
 * Ceilings are loose (the suite runs under load). Set J6_BENCH_OUT to a file
 * path to record the p50/p95 documented in §15.
 */

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

/** A structurally new snapshot with the same content: what the registry holds after a sync that changed something. */
function fresh(snapshot: SessionContextSnapshot): SessionContextSnapshot {
  return readSessionContextSnapshot(JSON.parse(JSON.stringify(snapshot)), snapshot.workspace.id)!;
}

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe.each([
  ["small", 50, 5],
  ["medium", 800, 30],
] as const)("%s workspace (%i tabs, %i collections)", (label, tabCount, collectionCount) => {
  it("keeps analysis, related-tab search and collection reasoning negligible, and its answers small", async () => {
    const snapshot = largeSnapshot(tabCount, collectionCount);
    const groups = analyzeTopics(snapshot).groups;

    const copies = Array.from({ length: 20 }, () => fresh(snapshot));
    let next = 0;
    const cold = time(20, () => analyzeTopics(copies[next++]));
    // What the per-snapshot cache holds beyond the snapshot itself, as serialized size — a stable proxy for its memory.
    const index = termIndex(snapshot);
    const cachedBytes =
      JSON.stringify(index.entries.map(({ terms, titleKey, siteTerms, site, siteName }) => ({ terms, titleKey, siteTerms, site, siteName }))).length +
      JSON.stringify([...index.documentFrequency, ...index.display]).length +
      JSON.stringify(analyzeTopics(snapshot)).length;
    const snapshotBytes = JSON.stringify(snapshot).length;

    const inProcess = {
      analyzeCold: cold,
      analyzeCached: time(40, () => analyzeTopics(snapshot)),
      termIndexCold: time(20, () => termIndex(fresh(snapshot))),
      relatedByQuery: time(40, () => findRelatedTabs(snapshot, { query: "astronomy lecture", limit: 50 })),
      relatedByTabs: time(40, () => findRelatedTabs(snapshot, { tabIds: groups[0].tabIds.slice(0, 5) })),
      rankCollections: time(40, () => rankCollections(snapshot, { query: "chemistry", tabIds: groups[1].tabIds })),
      placementAllGroups: time(20, () => {
        for (const group of groups) recommendPlacement(snapshot, { tabIds: group.tabIds, name: group.label, terms: group.terms, confidence: group.confidence });
      }),
      domains: time(40, () => domainBreakdown(snapshot)),
      possibleDuplicates: time(40, () => possibleDuplicateTabGroups(snapshot)),
    };

    const registry = createSessionContextRegistry({});
    const server = createSessionContextServer({ registry });
    servers.push(server);
    const bound = await registry.bind({ sessionId: "s1", ownerId: "local", workspaceId: "ws-large", access: "read_write", snapshot });
    const client = new Client({ name: "bench", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(await server.url()), { requestInit: { headers: { Authorization: `Bearer ${bound!.token}` } } })
    );
    const sizes: Record<string, number> = {};
    async function timeCall(runs: number, name: string, args: Record<string, unknown>) {
      const samples: number[] = [];
      for (let run = 0; run < runs; run += 1) {
        const start = performance.now();
        const result = await client.callTool({ name, arguments: args });
        samples.push(performance.now() - start);
        expect(result.isError, name).not.toBe(true);
        sizes[name] = (result as { content: { text: string }[] }).content[0].text.length;
      }
      return stats(samples);
    }
    const firstGroup = JSON.parse(
      ((await client.callTool({ name: "analyze_topics", arguments: {} })) as { content: { text: string }[] }).content[0].text
    ).groups[0].groupId as string;
    const overMcp = {
      summary: await timeCall(20, "get_workspace_summary", {}),
      analyzeTopics: await timeCall(20, "analyze_topics", {}),
      topicGroup: await timeCall(20, "get_topic_group", { groupId: firstGroup, basedOnVersion: 1 }),
      relatedTabs: await timeCall(20, "find_related_tabs", { query: "astronomy lecture", maxResults: 25 }),
      relevantCollections: await timeCall(20, "find_relevant_collections", { query: "chemistry" }),
      domains: await timeCall(20, "list_domains", {}),
    };

    // What reading the whole workspace costs an agent without the analysis tools: every page of list_tabs.
    let everyTab = 0;
    for (let offset = 0; offset < tabCount; offset += 100) {
      const page = (await client.callTool({ name: "list_tabs", arguments: { offset, limit: 100 } })) as { content: { text: string }[] };
      everyTab += page.content[0].text.length;
    }
    await client.close();

    const report = { label, tabCount, collectionCount, groups: groups.length, inProcess, overMcp, sizes, everyTabBytes: everyTab, snapshotBytes, cachedBytes };
    if (process.env.J6_BENCH_OUT) appendFileSync(process.env.J6_BENCH_OUT, `${JSON.stringify(report)}\n`);

    for (const measure of Object.values(inProcess)) expect(measure.p50).toBeLessThan(label === "small" ? 25 : 150);
    for (const measure of Object.values(overMcp)) expect(measure.p50).toBeLessThan(250);
    // The overview costs less context than reading the workspace it describes — far less once it is large.
    expect(sizes.analyze_topics).toBeLessThan(label === "small" ? everyTab : everyTab / 10);
    // The cache is bounded by the snapshot it derives from.
    expect(cachedBytes).toBeLessThan(snapshotBytes * 2);
    for (const size of Object.values(sizes)) expect(size).toBeLessThan(64 * 1024);
  }, 120_000);
});
