import { writeFileSync, mkdirSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, it } from "vitest";
import { buildKnowledgeGraph } from "@/lib/knowledge-graph/build";
import { layoutKnowledgeGraph } from "@/lib/knowledge-graph/layout";
import { syntheticCorpus } from "../__fixtures__/synthetic";
import { buildConversationIndex, buildCorpus, deriveIndex } from "../corpus";
import { extractConversation } from "../extract";
import { answerQuery, parseQuery } from "../retrieve";
import { DEFAULT_INTELLIGENCE_SETTINGS } from "../settings";
import { EMBEDDING_MODEL, embeddingChunks, semanticNeighbors, updateNeighbors } from "../semantic";
import type { ConversationExtraction } from "../types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * Scale benchmark on generated corpora (timings only — see synthetic.ts).
 * Node timings on this machine; a browser tab is slower, and the numbers
 * are for comparing versions of the engine, not a promise about a device.
 */

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};
const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;
const SIZES = (process.env.SIZES ?? "100,500,1000,5000").split(",").map(Number);
const NOW = Date.UTC(2026, 9, 30);
const QUERIES = ["What did I decide about postgres?", "Which questions are still open?", "What did Claude suggest about oauth?", "sourdough hydration", "tasks from last week", "What did I accomplish this month?", "kubernetes ingress helm", "What did ChatGPT suggest that I later discussed with Claude?"];

function workspacesOf(records: ReturnType<typeof syntheticCorpus>["records"], ids: string[]): Workspace[] {
  return ids.map((id) => ({
    id,
    name: `Project ${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    tabs: records
      .filter((record) => record.workspaceId === id)
      .map((record): Tab => {
        const tabId = record.ref.kind === "source" ? record.ref.tabId : record.id;
        const url = `https://chatgpt.com/c/${tabId}`;
        return { id: tabId, url, normalizedUrl: url, domain: "chatgpt.com", title: record.title, resource: { kind: "conversation", origin: "extension", status: "ready", addedAt: NOW, updatedAt: NOW, content: { chars: 100, extractedAt: NOW } } };
      }),
  }));
}

describe("conversation intelligence at scale", () => {
  const results: Record<string, unknown>[] = [];
  for (const size of SIZES) {
    it(`${size} conversations`, () => {
      const before = heap();
      const corpus = syntheticCorpus(size);
      const afterRecords = heap();

      let start = performance.now();
      const extractions = new Map<string, ConversationExtraction>();
      for (const record of corpus.records) extractions.set(record.id, extractConversation(record));
      const extractMs = ms(start);
      const afterExtract = heap();

      start = performance.now();
      const index = buildConversationIndex({ records: corpus.records, extractions, settings: DEFAULT_INTELLIGENCE_SETTINGS, now: NOW });
      const indexMs = ms(start);
      const afterIndex = heap();

      // One conversation saved again with a new message.
      const changed = { ...corpus.records[0]!, contentHash: "changed", messages: [...corpus.records[0]!.messages] };
      start = performance.now();
      const nextExtractions = new Map(extractions);
      nextExtractions.set(changed.id, extractConversation(changed));
      const records2 = [changed, ...corpus.records.slice(1)];
      buildConversationIndex({ records: records2, extractions: nextExtractions, settings: DEFAULT_INTELLIGENCE_SETTINGS, now: NOW });
      const incrementalChangeMs = ms(start);

      // A correction only: the corpus stage (relations, threads) is reused, only facts are derived again.
      const built = buildCorpus({ records: corpus.records, extractions, settings: DEFAULT_INTELLIGENCE_SETTINGS });
      const fact = index.facts[0]!;
      start = performance.now();
      deriveIndex(built, { ...DEFAULT_INTELLIGENCE_SETTINGS, facts: { [fact.id]: { verdict: "confirmed", at: NOW } } }, NOW);
      const correctionMs = ms(start);

      const latencies: number[] = [];
      for (let round = 0; round < 3; round++)
        for (const text of QUERIES) {
          start = performance.now();
          answerQuery(index, parseQuery(text, NOW));
          latencies.push(performance.now() - start);
        }
      latencies.sort((a, b) => a - b);

      const links = index.relations
        .filter((relation) => !relation.sameConversation)
        .slice(0, 300)
        .map((relation) => {
          const ra = index.records.find((record) => record.id === relation.a)!;
          const rb = index.records.find((record) => record.id === relation.b)!;
          const key = (record: typeof ra) => `s:${record.ref.kind === "source" ? record.ref.tabId : ""}`;
          return { a: { workspaceId: ra.workspaceId, key: key(ra) }, b: { workspaceId: rb.workspaceId, key: key(rb) }, score: relation.score, shared: relation.sharedTerms };
        });
      const workspaces = workspacesOf(corpus.records, corpus.workspaceIds);
      start = performance.now();
      const graph = buildKnowledgeGraph({ workspaces, conversationLinks: links });
      layoutKnowledgeGraph(graph);
      const graphMs = ms(start);

      const extractionBytes = Buffer.byteLength(JSON.stringify([...extractions.values()]));

      // Meaning: neighbour search and the corpus with exact similarities, on stand-in unit vectors
      // (the cost does not depend on what the vectors say; embedding itself is timed in quality.perf.ts).
      let chunkTotal = 0;
      start = performance.now();
      for (const record of corpus.records) chunkTotal += embeddingChunks(record).length;
      const chunkingMs = ms(start);
      let seed = 1;
      const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
      const vectors = new Map(corpus.records.map((record) => {
        const vector = new Float32Array(EMBEDDING_MODEL.dims);
        // Records in one project lean the same way, so neighbours exist above the floor.
        const lean = Number(record.workspaceId.slice(1)) % 7;
        for (let d = 0; d < vector.length; d++) vector[d] = random() + (d % 7 === lean ? 1.5 : 0);
        let norm = 0;
        for (const value of vector) norm += value * value;
        for (let d = 0; d < vector.length; d++) vector[d]! /= Math.sqrt(norm);
        return [record.id, vector] as const;
      }));
      const entries = [...vectors].map(([recordId, vector]) => ({ recordId, vector }));
      start = performance.now();
      const neighbors = semanticNeighbors(entries);
      const neighborsFullMs = ms(start);
      start = performance.now();
      updateNeighbors(neighbors, entries, new Set([entries[0]!.recordId]));
      const neighborsOneChangedMs = ms(start);
      start = performance.now();
      const hybrid = buildCorpus({ records: corpus.records, extractions, settings: DEFAULT_INTELLIGENCE_SETTINGS, semantic: { neighbors, vectors } });
      const hybridCorpusMs = ms(start);
      const row = {
        conversations: size,
        textMB: Math.round((corpus.chars / 1e6) * 10) / 10,
        extractMs,
        extractPerConversationMs: Math.round((extractMs / size) * 100) / 100,
        indexMs,
        incrementalChangeMs,
        correctionMs,
        queryP50Ms: Math.round(latencies[Math.floor(latencies.length / 2)]! * 10) / 10,
        queryP95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)]! * 10) / 10,
        graphMs,
        relations: index.relations.length,
        threads: index.threads.length,
        heapRecordsMB: Math.round((afterRecords - before) / 1e5) / 10,
        heapExtractionsMB: Math.round((afterExtract - afterRecords) / 1e5) / 10,
        heapIndexMB: Math.round((afterIndex - afterExtract) / 1e5) / 10,
        extractionCacheMB: Math.round(extractionBytes / 1e5) / 10,
        chunks: chunkTotal,
        chunkingMs,
        embeddingStoreMB: Math.round(((chunkTotal * EMBEDDING_MODEL.dims + corpus.records.length * EMBEDDING_MODEL.dims * 4 + chunkTotal * 24) / 1e6) * 10) / 10,
        neighborsFullMs,
        neighborsOneChangedMs,
        hybridCorpusMs,
        hybridRelations: hybrid.relations.length,
      };
      results.push(row);
      console.log(JSON.stringify(row));
    });
  }
  it("writes the results", () => {
    mkdirSync(".bench-cache", { recursive: true });
    writeFileSync(`.bench-cache/scale-${process.env.LABEL ?? "run"}.json`, JSON.stringify(results, null, 2));
  });
});
