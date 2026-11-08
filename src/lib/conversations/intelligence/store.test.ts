import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { a, record, u } from "./__fixtures__/conversations";
import { extractConversation } from "./extract";
import { EMBEDDINGS, EXTRACTIONS, derivedKey, readDerived, readDerivedKeys, resetDerivedStoreForTests, writeDerived } from "./store";
import { deleteContent, pruneContentExcept, putContent, resetContentStoreForTests } from "@/lib/resources/content-store";
import { setStorageNamespace } from "@/lib/storage/namespace";
import type { CachedEmbedding, CachedExtraction } from "./store";

/**
 * What Hubble keeps on the device from its analysis lives exactly as long as
 * the conversation's text: the content store's own deletion paths take it
 * away, and one account never reads another's.
 */

const chat = record("t1", [u("How do I fix the IndexedDB write?"), a("Wrap it in a promise.")], { workspaceId: "w1" });
const extraction = (owner: string, workspaceId: string, item: string): CachedExtraction => {
  const value = extractConversation(chat);
  return { key: derivedKey(owner, workspaceId, item), owner, fingerprint: value.fingerprint, version: value.version, extraction: value };
};
const embedding = (owner: string, workspaceId: string, item: string): CachedEmbedding => ({ key: derivedKey(owner, workspaceId, item), owner, fingerprint: "f", model: "m", chunks: [{ hash: "h", messageIndex: 0 }], vectors: new Int8Array([1, 2, 3]), conversation: new Float32Array([1, 0, 0]) });

afterEach(() => {
  setStorageNamespace(null);
  resetDerivedStoreForTests();
  resetContentStoreForTests();
});

describe("the derived-data cache", () => {
  it("keeps typed vectors and extractions, and reads them back by account and by key", async () => {
    await writeDerived(EXTRACTIONS, [extraction("_", "w1", "t1")]);
    await writeDerived(EMBEDDINGS, [embedding("_", "w1", "t1")]);
    const [found] = await readDerivedKeys<CachedEmbedding>(EMBEDDINGS, [derivedKey("_", "w1", "t1")]);
    expect(Array.from(found!.vectors)).toEqual([1, 2, 3]);
    expect((await readDerived<CachedExtraction>(EXTRACTIONS, "_"))[0]!.extraction.recordId).toBe(chat.id);
  });

  it("is deleted with the conversation's text, by every deletion path", async () => {
    setStorageNamespace("alice");
    await putContent("w1", "t1", { kind: "conversation", turns: [{ role: "user", text: "hi" }], extractedAt: 1 });
    await putContent("w1", "t2", { kind: "conversation", turns: [{ role: "user", text: "hi" }], extractedAt: 1 });
    await writeDerived(EXTRACTIONS, [extraction("alice", "w1", "t1"), extraction("alice", "w1", "t2")]);
    await writeDerived(EMBEDDINGS, [embedding("alice", "w1", "t1"), embedding("alice", "w1", "t2")]);

    await deleteContent("w1", ["t1"]);
    expect((await readDerived(EXTRACTIONS, "alice")).map((entry) => entry.key)).toEqual([derivedKey("alice", "w1", "t2")]);
    expect((await readDerived(EMBEDDINGS, "alice")).map((entry) => entry.key)).toEqual([derivedKey("alice", "w1", "t2")]);

    // A project gone: pruning everything not present takes the rest.
    await pruneContentExcept(new Map());
    expect(await readDerived(EXTRACTIONS, "alice")).toEqual([]);
    expect(await readDerived(EMBEDDINGS, "alice")).toEqual([]);
  });

  it("never touches, or reads, another account's entries", async () => {
    await writeDerived(EXTRACTIONS, [extraction("alice", "w1", "t1"), extraction("bob", "w1", "t1")]);
    setStorageNamespace("alice");
    await pruneContentExcept(new Map());
    expect(await readDerived(EXTRACTIONS, "alice")).toEqual([]);
    expect((await readDerived<CachedExtraction>(EXTRACTIONS, "bob")).map((entry) => entry.owner)).toEqual(["bob"]);
  });
});
