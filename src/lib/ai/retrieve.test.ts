import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { putChunks } from "./db";
import { retrieveRelevantChunks, retrieveRelevantChunksAcrossWorkspaces, sampleChunksForTabs, toSemanticHints } from "./retrieve";
import type { IndexedChunkRecord } from "./types";

function record(overrides: Partial<IndexedChunkRecord> & { workspaceId: string; tabId: string }): IndexedChunkRecord {
  return {
    key: `${overrides.workspaceId}:${overrides.tabId}:${overrides.kind ?? "summary"}`,
    kind: "summary",
    text: "text",
    embedding: [1, 0, 0],
    tabSignature: "sig",
    title: "Title",
    url: `https://example.com/${overrides.tabId}`,
    indexedAt: Date.now(),
    ...overrides,
  };
}

describe("retrieveRelevantChunks", () => {
  it("ranks chunks by cosine similarity to the query, closest first", async () => {
    const ws = "ws-rank";
    await putChunks([
      record({ workspaceId: ws, tabId: "close", embedding: [1, 0, 0] }),
      record({ workspaceId: ws, tabId: "mid", embedding: [0.6, 0.4, 0] }),
      record({ workspaceId: ws, tabId: "far", embedding: [0, 1, 0] }),
    ]);

    const results = await retrieveRelevantChunks(ws, [1, 0, 0], { minSimilarity: -1, topK: 10 });
    expect(results.map((r) => r.tabId)).toEqual(["close", "mid", "far"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("filters out chunks below the similarity floor", async () => {
    const ws = "ws-floor";
    await putChunks([
      record({ workspaceId: ws, tabId: "relevant", embedding: [1, 0, 0] }),
      record({ workspaceId: ws, tabId: "irrelevant", embedding: [0, 1, 0] }),
    ]);

    const results = await retrieveRelevantChunks(ws, [1, 0, 0], { minSimilarity: 0.5 });
    expect(results.map((r) => r.tabId)).toEqual(["relevant"]);
  });

  it("returns at most one chunk per tab, keeping the higher-scoring one", async () => {
    const ws = "ws-dedupe";
    await putChunks([
      record({ workspaceId: ws, tabId: "tab-1", kind: "summary", embedding: [0.5, 0.5, 0] }),
      record({ workspaceId: ws, tabId: "tab-1", kind: "body", embedding: [1, 0, 0] }),
    ]);

    const results = await retrieveRelevantChunks(ws, [1, 0, 0], { minSimilarity: -1 });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("body");
  });

  it("returns an empty array when nothing is indexed for the workspace", async () => {
    const results = await retrieveRelevantChunks("ws-empty", [1, 0, 0]);
    expect(results).toEqual([]);
  });
});

describe("retrieveRelevantChunksAcrossWorkspaces", () => {
  it("merges and ranks chunks from multiple workspaces together", async () => {
    await putChunks([
      record({ workspaceId: "ws-multi-a", tabId: "close", embedding: [1, 0, 0] }),
      record({ workspaceId: "ws-multi-b", tabId: "mid", embedding: [0.6, 0.4, 0] }),
      record({ workspaceId: "ws-multi-c", tabId: "unrelated", embedding: [0, 1, 0] }),
    ]);

    const results = await retrieveRelevantChunksAcrossWorkspaces(["ws-multi-a", "ws-multi-b", "ws-multi-c"], [1, 0, 0], { minSimilarity: 0.5 });

    expect(results.map((r) => r.tabId)).toEqual(["close", "mid"]);
    expect(results[0].workspaceId).toBe("ws-multi-a");
    expect(results[1].workspaceId).toBe("ws-multi-b");
  });

  it("only includes chunks from the given workspace ids, ignoring any others indexed in IndexedDB", async () => {
    await putChunks([
      record({ workspaceId: "ws-included", tabId: "in", embedding: [1, 0, 0] }),
      record({ workspaceId: "ws-excluded", tabId: "out", embedding: [1, 0, 0] }),
    ]);

    const results = await retrieveRelevantChunksAcrossWorkspaces(["ws-included"], [1, 0, 0], { minSimilarity: -1 });

    expect(results.map((r) => r.tabId)).toEqual(["in"]);
  });

  it("returns an empty array when none of the given workspaces have anything indexed", async () => {
    const results = await retrieveRelevantChunksAcrossWorkspaces(["ws-never-indexed-a", "ws-never-indexed-b"], [1, 0, 0]);
    expect(results).toEqual([]);
  });

  it("still returns at most one chunk per tab across workspaces", async () => {
    await putChunks([
      record({ workspaceId: "ws-multi-dedupe", tabId: "tab-1", kind: "summary", embedding: [0.5, 0.5, 0] }),
      record({ workspaceId: "ws-multi-dedupe", tabId: "tab-1", kind: "body", embedding: [1, 0, 0] }),
    ]);
    const results = await retrieveRelevantChunksAcrossWorkspaces(["ws-multi-dedupe"], [1, 0, 0], { minSimilarity: -1 });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("body");
  });
});

describe("toSemanticHints", () => {
  it("strips chunks down to tabId/workspaceId/score — no embedding vector or chunk text", async () => {
    const ws = "ws-hints";
    await putChunks([record({ workspaceId: ws, tabId: "tab-1", embedding: [1, 0, 0], text: "secret page content" })]);
    const chunks = await retrieveRelevantChunks(ws, [1, 0, 0]);

    const hints = toSemanticHints(chunks);

    expect(hints).toEqual([{ tabId: "tab-1", workspaceId: ws, score: expect.any(Number) }]);
    const serialized = JSON.stringify(hints);
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("secret page content");
  });
});

describe("sampleChunksForTabs", () => {
  it("prefers a tab's body chunk over its summary chunk", async () => {
    const ws = "ws-sample";
    await putChunks([
      record({ workspaceId: ws, tabId: "tab-1", kind: "summary", text: "summary text" }),
      record({ workspaceId: ws, tabId: "tab-1", kind: "body", text: "body text" }),
    ]);

    const results = await sampleChunksForTabs(ws, ["tab-1"], 10);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("body text");
  });

  it("only includes the requested tab ids", async () => {
    const ws = "ws-sample-filter";
    await putChunks([
      record({ workspaceId: ws, tabId: "included" }),
      record({ workspaceId: ws, tabId: "excluded" }),
    ]);

    const results = await sampleChunksForTabs(ws, ["included"], 10);
    expect(results.map((r) => r.tabId)).toEqual(["included"]);
  });
});
