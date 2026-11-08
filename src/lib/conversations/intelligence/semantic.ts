import { contentHash } from "@/lib/conversations/hash";
import type { ConversationRecord } from "./types";

/**
 * Meaning-level similarity between conversations, from a small embedding
 * model that runs on this device (./embedding.worker.ts). Optional: the
 * engine works without it (words and names only), and everything here is
 * pure — the worker supplies vectors, this decides what they mean.
 *
 * ## What gets embedded
 *
 * A conversation becomes a few chunks: a *gist* (the title and the person's
 * own words, which say what they were trying to do) and windows of each
 * message's prose. Code is left out — it embeds as noise. Each chunk is
 * identified by its text's hash, so a conversation saved again with one new
 * message embeds one new chunk, not all of them.
 *
 * The conversation's vector is the gist and the mean of its messages,
 * weighted equally and normalised. Chunk vectors are kept as int8 (a unit
 * vector × 127): a quarter of the space, and cosine within ~0.01.
 *
 * ## Neighbours, not a full matrix
 *
 * Each conversation keeps its `k` nearest others above `floor`. A changed or
 * new conversation recomputes only its own row (n dot products) and is
 * offered to every other row; a removed one is struck out, and only the rows
 * that lost it are recomputed — the result is the same as a full rebuild
 * (tested), at a fraction of the cost.
 */

export const EMBEDDING_MODEL = {
  /** Hugging Face id. Sentence-transformers' all-MiniLM-L6-v2, ONNX, int8. */
  id: "Xenova/all-MiniLM-L6-v2",
  dtype: "q8",
  dims: 384,
  /** Bumped when chunking changes, so cached vectors from older chunking are never mixed in. */
  chunker: 1,
  name: "all-MiniLM-L6-v2",
  approxDownloadMB: 23,
} as const;

export const EMBEDDING_KEY = `${EMBEDDING_MODEL.id}@${EMBEDDING_MODEL.dtype}#c${EMBEDDING_MODEL.chunker}`;

export const CHUNKING = { gistChars: 700, windowChars: 700, windowsPerMessage: 2, maxChunks: 10 } as const;

export type EmbeddingChunk = {
  hash: string;
  /** -1 for the gist, else the message the window came from. */
  messageIndex: number;
  text: string;
};

function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, (match) => match.slice(1, -1))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_|-]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function windows(text: string, size: number, count: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0 && out.length < count) {
    if (rest.length <= size) {
      out.push(rest);
      break;
    }
    // End on a sentence when one ends in the last third of the window.
    const cut = rest.slice(0, size);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    const end = stop > size * 0.66 ? stop + 1 : size;
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  return out;
}

/** The chunks one conversation is embedded as — deterministic for the same record. */
export function embeddingChunks(record: Pick<ConversationRecord, "title" | "messages" | "text">): EmbeddingChunk[] {
  const chunk = (text: string, messageIndex: number): EmbeddingChunk => ({ hash: contentHash({ text }), messageIndex, text });
  const user = record.messages.filter((message) => message.role === "user").map((message) => prose(message.text));
  const gist = `${record.title}. ${user.join(" ") || prose(record.text ?? "")}`.slice(0, CHUNKING.gistChars);
  const out: EmbeddingChunk[] = [chunk(gist, -1)];
  // The person's turns first, then the AI's, so a long reply never crowds out what was asked.
  const ordered = [...record.messages].sort((a, b) => (a.role === b.role ? a.index - b.index : a.role === "user" ? -1 : 1));
  const picked: EmbeddingChunk[] = [];
  for (const message of ordered) {
    for (const window of windows(prose(message.text), CHUNKING.windowChars, CHUNKING.windowsPerMessage)) {
      if (window.length < 20 || picked.length >= CHUNKING.maxChunks - 1) break;
      picked.push(chunk(window, message.index));
    }
  }
  if (record.messages.length === 0 && record.text) for (const window of windows(prose(record.text), CHUNKING.windowChars, CHUNKING.maxChunks - 1)) picked.push(chunk(window, 0));
  return [...out, ...picked.sort((a, b) => a.messageIndex - b.messageIndex)];
}

export function quantize(vector: ArrayLike<number>): Int8Array {
  const out = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index++) out[index] = Math.max(-127, Math.min(127, Math.round(vector[index]! * 127)));
  return out;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>, aOffset = 0, bOffset = 0, length = a.length): number {
  let sum = 0;
  for (let index = 0; index < length; index++) sum += a[aOffset + index]! * b[bOffset + index]!;
  return sum;
}

function normalize(vector: Float32Array): Float32Array {
  const length = Math.sqrt(dot(vector, vector));
  if (length > 0) for (let index = 0; index < vector.length; index++) vector[index]! /= length;
  return vector;
}

/** The conversation's vector from its chunks' (unit) vectors: half gist, half the mean of the messages. */
export function conversationVector(chunks: readonly { messageIndex: number; vector: ArrayLike<number> }[], dims: number = EMBEDDING_MODEL.dims): Float32Array {
  const out = new Float32Array(dims);
  const gist = chunks.find((chunk) => chunk.messageIndex === -1);
  const rest = chunks.filter((chunk) => chunk !== gist);
  if (gist) for (let index = 0; index < dims; index++) out[index] += (rest.length > 0 ? 0.5 : 1) * gist.vector[index]!;
  for (const chunk of rest) for (let index = 0; index < dims; index++) out[index] += ((gist ? 0.5 : 1) / rest.length) * chunk.vector[index]!;
  return normalize(out);
}

export type SemanticEntry = {
  recordId: string;
  /** Unit vector. */
  vector: Float32Array;
};

export type SemanticNeighbor = { id: string; score: number };
export type NeighborMap = Map<string, SemanticNeighbor[]>;

export const NEIGHBORS = { k: 12, floor: 0.3 } as const;

function insert(list: SemanticNeighbor[], neighbor: SemanticNeighbor, k: number): void {
  if (list.length >= k && neighbor.score <= list[list.length - 1]!.score) return;
  let position = list.findIndex((entry) => entry.score < neighbor.score || (entry.score === neighbor.score && entry.id > neighbor.id));
  if (position === -1) position = list.length;
  list.splice(position, 0, neighbor);
  if (list.length > k) list.length = k;
}

function rowOf(entry: SemanticEntry, entries: readonly SemanticEntry[], k: number, floor: number): SemanticNeighbor[] {
  const row: SemanticNeighbor[] = [];
  for (const other of entries) {
    if (other.recordId === entry.recordId) continue;
    const score = dot(entry.vector, other.vector);
    if (score >= floor) insert(row, { id: other.recordId, score: Math.round(score * 1000) / 1000 }, k);
  }
  return row;
}

/** Every entry's nearest others, from scratch. O(n² · dims). */
export function semanticNeighbors(entries: readonly SemanticEntry[], options: { k?: number; floor?: number } = {}): NeighborMap {
  const k = options.k ?? NEIGHBORS.k;
  const floor = options.floor ?? NEIGHBORS.floor;
  const out: NeighborMap = new Map();
  for (const entry of entries) out.set(entry.recordId, rowOf(entry, entries, k, floor));
  return out;
}

/**
 * The neighbours after some entries changed, appeared or went: only their
 * rows, and the rows that lost one, are recomputed. Same result as
 * `semanticNeighbors(entries)`.
 */
export function updateNeighbors(previous: NeighborMap, entries: readonly SemanticEntry[], changed: ReadonlySet<string>, options: { k?: number; floor?: number } = {}): NeighborMap {
  const k = options.k ?? NEIGHBORS.k;
  const floor = options.floor ?? NEIGHBORS.floor;
  const live = new Set(entries.map((entry) => entry.recordId));
  const out: NeighborMap = new Map();
  const recompute = new Set([...changed].filter((id) => live.has(id)));
  for (const entry of entries) {
    if (recompute.has(entry.recordId)) continue;
    const before = previous.get(entry.recordId);
    if (!before) {
      recompute.add(entry.recordId);
      continue;
    }
    const kept = before.filter((neighbor) => live.has(neighbor.id) && !changed.has(neighbor.id));
    // A full row that lost someone may have had a candidate below its cut: recompute it.
    if (kept.length < before.length && before.length >= k) recompute.add(entry.recordId);
    else out.set(entry.recordId, kept);
  }
  const byId = new Map(entries.map((entry) => [entry.recordId, entry]));
  for (const id of recompute) out.set(id, rowOf(byId.get(id)!, entries, k, floor));
  // A changed entry is offered to everyone it is now close to.
  for (const id of changed) {
    const entry = byId.get(id);
    if (!entry) continue;
    for (const other of entries) {
      if (other.recordId === id || recompute.has(other.recordId)) continue;
      const score = dot(entry.vector, other.vector);
      if (score >= floor) insert(out.get(other.recordId)!, { id, score: Math.round(score * 1000) / 1000 }, k);
    }
  }
  return out;
}

/** The two messages that match best between two conversations, from their chunk vectors — the "why" of a semantic link. */
export function bestChunkMatch(
  a: { chunks: readonly { messageIndex: number }[]; vectors: Int8Array },
  b: { chunks: readonly { messageIndex: number }[]; vectors: Int8Array },
  dims: number = EMBEDDING_MODEL.dims
): { a: number; b: number; score: number } | undefined {
  let best: { a: number; b: number; score: number } | undefined;
  for (let i = 0; i < a.chunks.length; i++) {
    if (a.chunks[i]!.messageIndex < 0) continue;
    for (let j = 0; j < b.chunks.length; j++) {
      if (b.chunks[j]!.messageIndex < 0) continue;
      const score = dot(a.vectors, b.vectors, i * dims, j * dims, dims) / (127 * 127);
      if (!best || score > best.score) best = { a: a.chunks[i]!.messageIndex, b: b.chunks[j]!.messageIndex, score: Math.round(score * 1000) / 1000 };
    }
  }
  return best;
}
