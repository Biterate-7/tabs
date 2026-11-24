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
 *   page → worker   search  a question; the worker answers with the
 *                           conversations closest to it in meaning
 *
 * Where a worker cannot run (no Worker, a blocked script, a policy that
 * forbids WebAssembly, the bundled model missing) the status says
 * "unavailable" with why, and Hubble keeps relating conversations and
 * answering questions by words and names alone.
 */

export type SemanticState = "off" | "starting" | "loading-model" | "embedding" | "ready" | "unavailable";

export type SemanticStatus = { state: SemanticState; done: number; total: number; message?: string };

export type EmbedItem = { key: string; recordId: string; fingerprint: string; chunks: EmbeddingChunk[] };

export type EmbeddingRequest =
  | { type: "sync"; owner: string; generation: number; items: Omit<EmbedItem, "chunks">[] }
  | { type: "chunks"; generation: number; items: Pick<EmbedItem, "key" | "chunks">[]; last: boolean }
  | { type: "forget"; owner: string }
  | { type: "search"; id: number; owner: string; text: string; floor: number; limit: number };

export type EmbeddingResponse =
  | { type: "status"; state: Exclude<SemanticState, "off" | "starting">; done: number; total: number; message?: string }
  | { type: "need"; generation: number; keys: string[] }
  | { type: "result"; generation: number; neighbors: [string, SemanticNeighbor[]][]; ids: string[]; vectors: Float32Array }
  | { type: "forgotten" }
  | { type: "model"; source: string; loadMs: number }
  | { type: "search-result"; id: number; hits: [recordId: string, score: number, messageIndex: number][]; searched: number; ms: number }
  | { type: "search-error"; id: number; message: string };

/** A question's closest conversations by meaning: score, and the message that matched best (-1: the conversation as a whole). */
export type SemanticHits = ReadonlyMap<string, { score: number; messageIndex: number }>;

export type SemanticSearch = { hits: SemanticHits; searched: number; ms: number };

export type SemanticResult = { neighbors: ReadonlyMap<string, readonly SemanticNeighbor[]>; vectors: ReadonlyMap<string, Float32Array> };

export type SemanticClient = {
  sync(owner: string, items: Omit<EmbedItem, "chunks">[], chunksFor: (keys: string[]) => Iterable<Pick<EmbedItem, "key" | "chunks">>): void;
  forget(owner: string): Promise<void>;
  /** The question's closest conversations by meaning, among those embedded; rejects when the model can't run. */
  search(owner: string, text: string, options?: { floor?: number; limit?: number; timeoutMs?: number }): Promise<SemanticSearch>;
  dispose(): void;
};

export function createSemanticClient(handlers: { status: (status: SemanticStatus) => void; result: (result: SemanticResult) => void; model?: (model: { source: string; loadMs: number }) => void }): SemanticClient {
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
  let searchId = 0;
  const searches = new Map<number, { resolve: (value: SemanticSearch) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (id: number) => {
    const pending = searches.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      searches.delete(id);
    }
    return pending;
  };

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
      } else if (message.type === "model") {
        handlers.model?.(message);
      } else if (message.type === "search-result") {
        settle(message.id)?.resolve({ hits: new Map(message.hits.map(([id, score, messageIndex]) => [id, { score, messageIndex }])), searched: message.searched, ms: message.ms });
      } else if (message.type === "search-error") {
        settle(message.id)?.reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      for (const id of [...searches.keys()]) settle(id)?.reject(new Error(event.message || "The on-device model could not start here."));
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
    search(owner, text, options = {}) {
      if (!worker) return Promise.reject(new Error("The on-device model isn't running."));
      const id = ++searchId;
      return new Promise<SemanticSearch>((resolve, reject) => {
        // A stuck or still-loading worker never holds a question up for long: words answer it meanwhile.
        const timer = setTimeout(() => settle(id)?.reject(new Error("The on-device model took too long to answer.")), options.timeoutMs ?? 15_000);
        searches.set(id, { resolve, reject, timer });
        worker!.postMessage({ type: "search", id, owner, text, floor: options.floor ?? 0.2, limit: options.limit ?? 200 } satisfies EmbeddingRequest);
      });
    },
    dispose() {
      clearTimeout(timer);
      for (const id of [...searches.keys()]) settle(id)?.reject(new Error("The on-device model was stopped."));
      worker?.terminate();
      worker = null;
    },
  };
}
