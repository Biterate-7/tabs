import { EMBEDDING_KEY, EMBEDDING_MODEL, conversationVector, quantize, updateNeighbors } from "./semantic";
import { EMBEDDINGS, clearDerived, readDerived, writeDerived } from "./store";
import type { NeighborMap, SemanticEntry } from "./semantic";
import type { CachedEmbedding } from "./store";
import type { EmbeddingRequest, EmbeddingResponse, EmbedItem } from "./semantic-client";

/**
 * Embeds saved conversations with a small model running in this worker —
 * on the device, off the page's thread — and keeps each conversation's
 * nearest others up to date.
 *
 * Only text the page hands over is embedded, and nothing leaves the device:
 * the one network request is the model itself (from Hugging Face, once,
 * then from the browser's cache), and the ONNX runtime is served by Hubble
 * (scripts/copy-ort-assets.mjs). Vectors are stored in the account's
 * derived-data cache (./store.ts) and deleted with their conversations.
 *
 * Unchanged conversations are never embedded again (same fingerprint and
 * model); a changed one embeds only the chunks whose text is new.
 */

// The worker's own scope, typed narrowly (the webworker lib would retype the whole program's globals).
const scope = globalThis as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<EmbeddingRequest>) => void) | null; location: Location; crossOriginIsolated: boolean };

type Extractor = (texts: string[], options: { pooling: "mean"; normalize: true }) => Promise<{ tolist(): number[][] }>;

let extractor: Promise<Extractor> | null = null;
const BATCH = 16;

function post(message: EmbeddingResponse) {
  scope.postMessage(message);
}

async function loadModel(): Promise<Extractor> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = { mjs: new URL("/ort/ort-wasm-simd-threaded.mjs", scope.location.origin).href, wasm: new URL("/ort/ort-wasm-simd-threaded.wasm", scope.location.origin).href };
    onnx.wasm.numThreads = scope.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  }
  const loaded = await pipeline("feature-extraction", EMBEDDING_MODEL.id, {
    dtype: EMBEDDING_MODEL.dtype,
    device: "wasm",
    progress_callback: (progress: { status?: string; loaded?: number; total?: number }) => {
      if (progress.status === "progress" && progress.total) post({ type: "status", state: "loading-model", done: progress.loaded ?? 0, total: progress.total });
    },
  });
  return loaded as unknown as Extractor;
}

function model(): Promise<Extractor> {
  if (!extractor) {
    extractor = loadModel();
    extractor.catch(() => (extractor = null));
  }
  return extractor;
}

// What this worker knows, per account: entries and neighbours, so a sync after a small change is a small update.
let state: { owner: string; entries: Map<string, { fingerprint: string; entry: SemanticEntry }>; neighbors: NeighborMap } | null = null;

type Run = {
  generation: number;
  owner: string;
  items: Map<string, Omit<EmbedItem, "chunks">>;
  cached: Map<string, CachedEmbedding>;
  needed: Set<string>;
  queue: Pick<EmbedItem, "key" | "chunks">[];
  last: boolean;
  done: number;
  working: boolean;
};
let run: Run | null = null;

async function sync(request: Extract<EmbeddingRequest, { type: "sync" }>) {
  const cached = new Map((await readDerived<CachedEmbedding>(EMBEDDINGS, request.owner)).filter((entry) => entry.model === EMBEDDING_KEY).map((entry) => [entry.key, entry]));
  const items = new Map(request.items.map((item) => [item.key, item]));
  const needed = new Set<string>();
  for (const item of request.items) if (cached.get(item.key)?.fingerprint !== item.fingerprint) needed.add(item.key);
  if (run && run.generation > request.generation) return;
  run = { generation: request.generation, owner: request.owner, items, cached, needed, queue: [], last: needed.size === 0, done: 0, working: false };
  if (needed.size === 0) return finish(run);
  post({ type: "need", generation: request.generation, keys: [...needed] });
  // Load the model while the page prepares the text.
  post({ type: "status", state: "loading-model", done: 0, total: 0 });
  try {
    await model();
  } catch (error) {
    if (run?.generation === request.generation) post({ type: "status", state: "unavailable", done: 0, total: needed.size, message: error instanceof Error ? error.message : String(error) });
    run = null;
  }
}

async function work(current: Run) {
  if (current.working) return;
  current.working = true;
  try {
    const extract = await model();
    while (current.queue.length > 0) {
      if (run !== current) return;
      const item = current.queue.shift()!;
      const meta = current.items.get(item.key);
      if (!meta) continue;
      // Reuse every chunk whose text was embedded before; embed only the new ones.
      const previous = current.cached.get(item.key);
      const known = new Map<string, Int8Array>();
      if (previous) previous.chunks.forEach((chunk, index) => known.set(chunk.hash, previous.vectors.slice(index * EMBEDDING_MODEL.dims, (index + 1) * EMBEDDING_MODEL.dims)));
      const missing = item.chunks.filter((chunk) => !known.has(chunk.hash));
      const fresh = new Map<string, number[]>();
      for (let start = 0; start < missing.length; start += BATCH) {
        const batch = missing.slice(start, start + BATCH);
        const output = (await extract(batch.map((chunk) => chunk.text), { pooling: "mean", normalize: true })).tolist();
        batch.forEach((chunk, index) => fresh.set(chunk.hash, output[index]!));
      }
      const vectors = new Int8Array(item.chunks.length * EMBEDDING_MODEL.dims);
      const unit: { messageIndex: number; vector: ArrayLike<number> }[] = [];
      item.chunks.forEach((chunk, index) => {
        const vector = fresh.get(chunk.hash);
        const stored = vector ? quantize(vector) : known.get(chunk.hash)!;
        vectors.set(stored, index * EMBEDDING_MODEL.dims);
        unit.push({ messageIndex: chunk.messageIndex, vector: vector ?? Array.from(stored, (value) => value / 127) });
      });
      const entry: CachedEmbedding = {
        key: item.key,
        owner: current.owner,
        fingerprint: meta.fingerprint,
        model: EMBEDDING_KEY,
        chunks: item.chunks.map((chunk) => ({ hash: chunk.hash, messageIndex: chunk.messageIndex })),
        vectors,
        conversation: conversationVector(unit),
      };
      await writeDerived(EMBEDDINGS, [entry]);
      current.cached.set(item.key, entry);
      current.done += 1;
      post({ type: "status", state: "embedding", done: current.done, total: current.needed.size });
      // Links appear as the work goes, not only at the end.
      if (current.done % 100 === 0) finish(current, false);
    }
    if (current.last && run === current) finish(current);
  } catch (error) {
    if (run === current) post({ type: "status", state: "unavailable", done: current.done, total: current.needed.size, message: error instanceof Error ? error.message : String(error) });
  } finally {
    current.working = false;
  }
}

function finish(current: Run, final = true) {
  const entries: SemanticEntry[] = [];
  const next = new Map<string, { fingerprint: string; entry: SemanticEntry }>();
  for (const [key, item] of current.items) {
    const hit = current.cached.get(key);
    if (!hit || hit.fingerprint !== item.fingerprint) continue;
    const entry = { recordId: item.recordId, vector: hit.conversation };
    entries.push(entry);
    next.set(item.recordId, { fingerprint: item.fingerprint, entry });
  }
  // An update from what this worker last computed, when it can.
  const changed = new Set<string>();
  const previous = state && state.owner === current.owner ? state : null;
  for (const [id, value] of next) if (previous?.entries.get(id)?.fingerprint !== value.fingerprint) changed.add(id);
  if (previous) for (const id of previous.entries.keys()) if (!next.has(id)) changed.add(id);
  const neighbors = updateNeighbors(previous?.neighbors ?? new Map(), entries, changed);
  state = { owner: current.owner, entries: next, neighbors };
  // The vectors too, packed and handed over without a copy: the page scores any candidate pair exactly.
  const ids = [...next.keys()];
  const vectors = new Float32Array(ids.length * EMBEDDING_MODEL.dims);
  ids.forEach((id, index) => vectors.set(next.get(id)!.entry.vector, index * EMBEDDING_MODEL.dims));
  scope.postMessage({ type: "result", generation: current.generation, neighbors: [...neighbors.entries()], ids, vectors } satisfies EmbeddingResponse, [vectors.buffer]);
  if (final) post({ type: "status", state: "ready", done: entries.length, total: current.items.size });
}

scope.onmessage = (event: MessageEvent<EmbeddingRequest>) => {
  const request = event.data;
  if (request.type === "sync") {
    void sync(request).catch((error) => post({ type: "status", state: "unavailable", done: 0, total: 0, message: error instanceof Error ? error.message : String(error) }));
  } else if (request.type === "chunks") {
    const current = run;
    if (!current || current.generation !== request.generation) return;
    for (const item of request.items) if (current.needed.has(item.key)) current.queue.push(item);
    if (request.last) current.last = true;
    void work(current);
  } else if (request.type === "forget") {
    run = null;
    state = null;
    void clearDerived(EMBEDDINGS, request.owner).then(() => post({ type: "forgotten" }));
  }
};
