import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { chunkKey, deleteChunksForTabs, getChunksForWorkspace, isIndexedDbAvailable, putChunks } from "./db";
import type { IndexedChunkRecord } from "./types";

function record(overrides: Partial<IndexedChunkRecord> & { workspaceId: string; tabId: string }): IndexedChunkRecord {
  return {
    key: chunkKey(overrides.workspaceId, overrides.tabId, "summary"),
    kind: "summary",
    text: "some text",
    embedding: [0.1, 0.2, 0.3],
    tabSignature: "sig",
    title: "Title",
    url: "https://example.com",
    indexedAt: Date.now(),
    ...overrides,
  };
}

describe("ai/db", () => {
  it("reports IndexedDB as available under the fake-indexeddb polyfill", () => {
    expect(isIndexedDbAvailable()).toBe(true);
  });

  it("stores and retrieves chunks scoped to a workspace", async () => {
    const ws = "ws-store-1";
    await putChunks([record({ workspaceId: ws, tabId: "tab-1" }), record({ workspaceId: ws, tabId: "tab-2" })]);

    const results = await getChunksForWorkspace(ws);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.tabId).sort()).toEqual(["tab-1", "tab-2"]);
  });

  it("does not leak chunks across workspaces", async () => {
    const wsA = "ws-a";
    const wsB = "ws-b";
    await putChunks([record({ workspaceId: wsA, tabId: "tab-a" })]);
    await putChunks([record({ workspaceId: wsB, tabId: "tab-b" })]);

    expect(await getChunksForWorkspace(wsA)).toHaveLength(1);
    expect(await getChunksForWorkspace(wsB)).toHaveLength(1);
  });

  it("overwrites a chunk stored under the same key", async () => {
    const ws = "ws-overwrite";
    await putChunks([record({ workspaceId: ws, tabId: "tab-1", text: "first" })]);
    await putChunks([record({ workspaceId: ws, tabId: "tab-1", text: "second" })]);

    const results = await getChunksForWorkspace(ws);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("second");
  });

  it("deletes only the chunks for the given tab ids", async () => {
    const ws = "ws-delete";
    await putChunks([
      record({ workspaceId: ws, tabId: "keep" }),
      record({ workspaceId: ws, tabId: "remove" }),
    ]);

    await deleteChunksForTabs(ws, ["remove"]);

    const results = await getChunksForWorkspace(ws);
    expect(results.map((r) => r.tabId)).toEqual(["keep"]);
  });
});
