import type { EmbeddingChunk, SemanticNeighbor } from "./semantic";

/**
 * The page's side of on-device semantic matching: one worker
 * (./embedding.worker.ts), started only when the person turned the feature
 * on, and a two-step exchange so unchanged conversations cost nothing:
 *
 *   page → worker   sync    every analysed conversation's key + fingerprint
 *   worker → page   need    the keys it has no current vectors for
 *   page → worker   chunks  the text of just those, in batches
 *   worker → page   result  each conversation's nearest others
 *
 * Where a worker cannot run (no Worker, a blocked script, a policy that
 * forbids WebAssembly) the status says "unavailable" and Hubble keeps
 * relating conversations by words and names alone.
 */

export type SemanticState = "off" | "starting" | "loading-model" | "embedding" | "ready" | "unavailable";

export type SemanticStatus = { state: SemanticState; done: number; total: number; message?: string };

export type EmbedItem = { key: string; recordId: string; fingerprint: string; chunks: EmbeddingChunk[] };

export type EmbeddingRequest =
  | { type: "sync"; owner: string; generation: number; items: Omit<EmbedItem, "chunks">[] }
  | { type: "chunks"; generation: number; items: Pick<EmbedItem, "key" | "chunks">[]; last: boolean }
  | { type: "forget"; owner: string };

export type EmbeddingResponse =
  | { type: "status"; state: Exclude<SemanticState, "off" | "starting">; done: number; total: number; message?: string }
  | { type: "need"; generation: number; keys: string[] }
  | { type: "result"; generation: number; neighbors: [string, SemanticNeighbor[]][]; ids: string[]; vectors: Float32Array }
  | { type: "forgotten" };

export type SemanticResult = { neighbors: ReadonlyMap<string, readonly SemanticNeighbor[]>; vectors: ReadonlyMap<string, Float32Array> };

export type SemanticClient = {
  sync(owner: string, items: Omit<EmbedItem, "chunks">[], chunksFor: (keys: string[]) => Iterable<Pick<EmbedItem, "key" | "chunks">>): void;
  forget(owner: string): Promise<void>;
  dispose(): void;
};

export function createSemanticClient(handlers: { status: (status: SemanticStatus) => void; result: (result: SemanticResult) => void }): SemanticClient {
  let worker: Worker | null = null;
  try {
    if (typeof Worker === "undefined") throw new Error("This browser can't run background workers.");
    // Built by scripts/build-embedding-worker.mjs and served by Hubble itself (a bundler URL would copy the TypeScript uncompiled).
    worker = new Worker("/workers/embedding.worker.js", { type: "module" });
  } catch (error) {
    handlers.status({ state: "unavailable", done: 0, total: 0, message: error instanceof Error ? error.message : String(error) });
  }
  let generation = 0;
  let pendingChunks: ((keys: string[]) => Iterable<Pick<EmbedItem, "key" | "chunks">>) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forgotten: (() => void) | null = null;

  const sendChunks = (forGeneration: number, keys: string[]) => {
    const make = pendingChunks;
    if (!worker || !make) return;
    // A few at a time, yielding to the page between batches: chunking long conversations is real work.
    const iterator = make(keys)[Symbol.iterator]();
    const step = () => {
      if (forGeneration !== generation || !worker) return;
      const batch: Pick<EmbedItem, "key" | "chunks">[] = [];
      let next = iterator.next();
      while (!next.done) {
        batch.push(next.value);
        if (batch.length >= 25) break;
        next = iterator.next();
      }
      const last = !!next.done || batch.length < 25;
      worker.postMessage({ type: "chunks", generation: forGeneration, items: batch, last } satisfies EmbeddingRequest);
      if (!last) timer = setTimeout(step, 0);
    };
    step();
  };

  if (worker) {
    worker.onmessage = (event: MessageEvent<EmbeddingResponse>) => {
      const message = event.data;
      if (message.type === "status") handlers.status(message);
      else if (message.type === "need") {
        if (message.generation === generation) sendChunks(message.generation, message.keys);
      } else if (message.type === "result") {
        if (message.generation === generation) {
          const dims = message.ids.length > 0 ? message.vectors.length / message.ids.length : 0;
          handlers.result({ neighbors: new Map(message.neighbors), vectors: new Map(message.ids.map((id, index) => [id, message.vectors.subarray(index * dims, (index + 1) * dims)])) });
        }
      } else if (message.type === "forgotten") {
        forgotten?.();
        forgotten = null;
      }
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      handlers.status({ state: "unavailable", done: 0, total: 0, message: event.message || "The on-device model could not start here." });
    };
  }

  return {
    sync(owner, items, chunksFor) {
      if (!worker) return;
      generation += 1;
      clearTimeout(timer);
      pendingChunks = chunksFor;
      handlers.status({ state: "starting", done: 0, total: items.length });
      worker.postMessage({ type: "sync", owner, generation, items } satisfies EmbeddingRequest);
    },
    forget(owner) {
      if (!worker) return Promise.resolve();
      generation += 1;
      return new Promise<void>((resolve) => {
        forgotten = resolve;
        worker!.postMessage({ type: "forget", owner } satisfies EmbeddingRequest);
      });
    },
    dispose() {
      clearTimeout(timer);
      worker?.terminate();
      worker = null;
    },
  };
}
