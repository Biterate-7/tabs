import { describe, expect, it } from "vitest";
import { a, record, u } from "./__fixtures__/conversations";
import { CHUNKING, EMBEDDING_MODEL, bestChunkMatch, conversationVector, embeddingChunks, quantize, semanticNeighbors, updateNeighbors } from "./semantic";
import type { SemanticEntry } from "./semantic";

/**
 * The pure half of on-device semantic matching: what is embedded, how
 * vectors are kept, and the neighbour search — with stand-in vectors, since
 * the model itself runs only in the browser worker (quality is measured in
 * bench/quality.perf.ts with the real model).
 */

function unit(seed: number, dims = 16): Float32Array {
  let state = seed;
  const vector = new Float32Array(dims);
  for (let index = 0; index < dims; index++) {
    state = (state * 16807) % 2147483647;
    vector[index] = (state / 2147483647) * 2 - 1;
  }
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

describe("chunks", () => {
  it("embeds the gist and the prose — never code — person's turns first, deterministically", () => {
    const chat = record("c", [u("How do I fix the IndexedDB write that fails after reload?"), a("Wrap it in a promise.\n\n```ts\nawait new Promise(r => tx.oncomplete = r)\n```\nThat keeps it in one place."), u("That worked, thanks.")], { title: "IndexedDB write" });
    const chunks = embeddingChunks(chat);
    expect(chunks[0]!.messageIndex).toBe(-1);
    expect(chunks[0]!.text).toMatch(/^IndexedDB write\. How do I fix/);
    expect(chunks.some((chunk) => chunk.text.includes("oncomplete = r"))).toBe(false);
    expect(chunks.map((chunk) => chunk.messageIndex)).toEqual([-1, 0, 1, 2]);
    expect(embeddingChunks(chat)).toEqual(chunks);
  });

  it("bounds a long conversation and keeps chunk hashes stable when a message is added", () => {
    const long = record("l", Array.from({ length: 30 }, (_, index) => (index % 2 ? a(`Reply ${index} `.repeat(200)) : u(`Question ${index} about the storage adapter design and its trade-offs.`))), { title: "Long" });
    const chunks = embeddingChunks(long);
    expect(chunks.length).toBeLessThanOrEqual(CHUNKING.maxChunks);
    const short = record("s", [u("Which database should the sync server use?"), a("Postgres is a good default for this.")], { title: "Sync db" });
    const grown = record("s", [u("Which database should the sync server use?"), a("Postgres is a good default for this."), u("And how do I run migrations?")], { title: "Sync db" });
    const before = new Set(embeddingChunks(short).filter((chunk) => chunk.messageIndex >= 0).map((chunk) => chunk.hash));
    const after = embeddingChunks(grown).filter((chunk) => chunk.messageIndex >= 0);
    // Only the new message's chunk is new: everything else is reused, not embedded again.
    expect(after.filter((chunk) => !before.has(chunk.hash)).map((chunk) => chunk.messageIndex)).toEqual([2]);
  });
});

describe("vectors", () => {
  it("keeps int8 vectors within a hundredth of the float cosine", () => {
    const x = unit(1, EMBEDDING_MODEL.dims);
    const y = unit(2, EMBEDDING_MODEL.dims);
    let float = 0;
    let int = 0;
    const qx = quantize(x);
    const qy = quantize(y);
    for (let index = 0; index < x.length; index++) {
      float += x[index]! * y[index]!;
      int += qx[index]! * qy[index]!;
    }
    expect(Math.abs(int / (127 * 127) - float)).toBeLessThan(0.01);
  });

  it("makes a unit conversation vector from the gist and the messages", () => {
    const vector = conversationVector([{ messageIndex: -1, vector: unit(3) }, { messageIndex: 0, vector: unit(4) }, { messageIndex: 1, vector: unit(5) }], 16);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
  });

  it("finds the two closest messages, skipping the gist", () => {
    const dims = 16;
    const shared = unit(9, dims);
    const pack = (vectors: Float32Array[]) => {
      const out = new Int8Array(vectors.length * dims);
      vectors.forEach((vector, index) => out.set(quantize(vector), index * dims));
      return out;
    };
    const left = { chunks: [{ messageIndex: -1 }, { messageIndex: 0 }, { messageIndex: 2 }], vectors: pack([shared, unit(10, dims), shared]) };
    const right = { chunks: [{ messageIndex: -1 }, { messageIndex: 1 }], vectors: pack([shared, shared]) };
    expect(bestChunkMatch(left, right, dims)).toMatchObject({ a: 2, b: 1 });
  });
});

describe("neighbours", () => {
  const entries = (count: number, offset = 0): SemanticEntry[] => Array.from({ length: count }, (_, index) => ({ recordId: `r${index}`, vector: unit(index + 1 + offset) }));

  it("updates incrementally to exactly what a full rebuild gives — after a change, an addition and a removal", () => {
    const options = { k: 4, floor: -1 };
    const start = entries(40);
    let neighbors = semanticNeighbors(start, options);
    // r3 changes, r40 appears.
    const next = [...start.map((entry) => (entry.recordId === "r3" ? { recordId: "r3", vector: unit(999) } : entry)), { recordId: "r40", vector: unit(777) }];
    neighbors = updateNeighbors(neighbors, next, new Set(["r3", "r40"]), options);
    expect(neighbors).toEqual(semanticNeighbors(next, options));
    // r7 and r12 go.
    const fewer = next.filter((entry) => entry.recordId !== "r7" && entry.recordId !== "r12");
    neighbors = updateNeighbors(neighbors, fewer, new Set(["r7", "r12"]), options);
    expect(neighbors).toEqual(semanticNeighbors(fewer, options));
  });

  it("keeps only neighbours above the floor, strongest first, at most k", () => {
    const neighbors = semanticNeighbors(entries(30), { k: 3, floor: 0.2 });
    for (const list of neighbors.values()) {
      expect(list.length).toBeLessThanOrEqual(3);
      expect(list.every((neighbor) => neighbor.score >= 0.2)).toBe(true);
      expect([...list].sort((x, y) => y.score - x.score)).toEqual(list);
    }
  });
});
