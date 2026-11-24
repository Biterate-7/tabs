import path from "node:path"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { NOW, a, photosynthesisChat, record, storageChoiceChat, syncBugChat, u } from "../__fixtures__/conversations"
import { buildConversationIndex } from "../corpus"
import { extractConversation } from "../extract"
import { RETRIEVAL_CONFIG, answerQuery, parseQuery } from "../retrieve"
import { EMBEDDING_MODEL, conversationVector, embeddingChunks, quantize, searchEmbeddings } from "../semantic"
import { DEFAULT_INTELLIGENCE_SETTINGS } from "../settings"
import type { SemanticHits } from "../semantic-client"

/**
 * Search by meaning with the real model — the copy Hubble bundles in
 * public/models (scripts/fetch-embedding-model.mjs), loaded with remote
 * downloads switched off exactly as the worker does — and the worker's own
 * scoring (`searchEmbeddings`). Proves the bundled files load and that
 * meaning finds what words can't, and measures load, embed and search time.
 *
 *   node scripts/fetch-embedding-model.mjs && npx vitest run --config vitest.perf.config.mts semantic-search
 */

const MODELS = path.resolve("public/models")

describe("search by meaning with the bundled model", () => {
  it("loads offline, finds conversations by meaning, and refuses unrelated questions", async () => {
    expect(existsSync(path.join(MODELS, EMBEDDING_MODEL.id, "onnx", "model_quantized.onnx"))).toBe(true)
    const { pipeline, env } = await import("@huggingface/transformers")
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = `${MODELS}${path.sep}`
    const loadStarted = performance.now()
    const extract = (await pipeline("feature-extraction", EMBEDDING_MODEL.id, { dtype: EMBEDDING_MODEL.dtype })) as unknown as (texts: string[], options: object) => Promise<{ tolist(): number[][] }>
    const loadMs = performance.now() - loadStarted

    const records = [
      syncBugChat(),
      storageChoiceChat(),
      photosynthesisChat(),
      record("k8s", [u("My Kubernetes pods keep getting OOMKilled. How do I set memory limits?"), a("Set resources.limits.memory in the container spec and watch usage with kubectl top.")], { title: "Pods killed for memory" }),
      record("espresso", [u("My espresso tastes sour. Should I grind finer?"), a("Sour usually means under-extraction: grind finer or raise the water temperature.")], { title: "Sour espresso", provider: "gemini" }),
    ]
    const index = buildConversationIndex({ records, extractions: new Map(records.map((entry) => [entry.id, extractConversation(entry)])), settings: DEFAULT_INTELLIGENCE_SETTINGS, now: NOW })

    let chunks = 0
    const embedStarted = performance.now()
    const stored = new Map<string, { conversation: Float32Array; chunks: { messageIndex: number }[]; vectors: Int8Array }>()
    for (const entry of records) {
      const parts = embeddingChunks(entry)
      chunks += parts.length
      const output = (await extract(parts.map((part) => part.text), { pooling: "mean", normalize: true })).tolist()
      const vectors = new Int8Array(parts.length * EMBEDDING_MODEL.dims)
      output.forEach((vector, position) => vectors.set(quantize(vector), position * EMBEDDING_MODEL.dims))
      expect(output[0]!.length).toBe(EMBEDDING_MODEL.dims)
      stored.set(entry.id, { conversation: conversationVector(parts.map((part, position) => ({ messageIndex: part.messageIndex, vector: output[position]! }))), chunks: parts.map((part) => ({ messageIndex: part.messageIndex })), vectors })
    }
    const embedMs = performance.now() - embedStarted

    const search = async (question: string): Promise<SemanticHits> => {
      const [vector] = (await extract([question], { pooling: "mean", normalize: true })).tolist()
      return new Map(searchEmbeddings(vector!, stored, RETRIEVAL_CONFIG.semanticFloor).map(([id, score, messageIndex]) => [id, { score, messageIndex }]))
    }
    const ask = async (question: string) => {
      const hits = await search(question)
      return { hits, words: answerQuery(index, parseQuery(question, NOW)), hybrid: answerQuery(index, parseQuery(question, NOW), { semantic: hits }) }
    }

    // No word in common with the conversation it's about.
    const plants = await ask("How do leaves turn sunshine into food?")
    console.info("[semantic] plants:", [...plants.hits].map(([id, hit]) => `${id.split(":").pop()}=${hit.score}`).join(" "))
    expect(plants.hybrid.conversations[0]?.record.id).toBe(records[2]!.id)
    expect(plants.hybrid.conversations[0]?.why.some((reason) => reason.startsWith("close in meaning"))).toBe(true)

    const lost = await ask("my saved chats vanish when I refresh the page")
    console.info("[semantic] lost:", [...lost.hits].map(([id, hit]) => `${id.split(":").pop()}=${hit.score}`).join(" "))
    expect(lost.hybrid.conversations[0]?.record.id).toBe(records[0]!.id)

    const container = await ask("containers crashing because they run out of RAM")
    expect(container.hybrid.conversations[0]?.record.id).toBe(records[3]!.id)

    // Unrelated to everything saved: nothing close enough to be an answer.
    const lasagna = await ask("a good recipe for vegetarian lasagna")
    console.info("[semantic] lasagna:", [...lasagna.hits].map(([id, hit]) => `${id.split(":").pop()}=${hit.score}`).join(" "))
    expect(lasagna.hybrid.enough).toBe(false)

    // Latency of the worker's scoring at scale: 5,000 conversations × 10 chunks.
    const big = new Map<string, { conversation: Float32Array; chunks: { messageIndex: number }[]; vectors: Int8Array }>()
    const template = [...stored.values()][0]!
    for (let n = 0; n < 5_000; n++) big.set(`r${n}`, { conversation: template.conversation, chunks: Array.from({ length: 10 }, (_, index) => ({ messageIndex: index })), vectors: new Int8Array(10 * EMBEDDING_MODEL.dims).map((_, index) => ((index * 31 + n) % 255) - 127) })
    const [query] = (await extract(["sync server database choice"], { pooling: "mean", normalize: true })).tolist()
    const searchStarted = performance.now()
    searchEmbeddings(query!, big, RETRIEVAL_CONFIG.semanticFloor)
    const searchMs = performance.now() - searchStarted
    console.info(`[semantic] model load ${Math.round(loadMs)} ms; ${chunks} chunks embedded in ${Math.round(embedMs)} ms (${(embedMs / chunks).toFixed(1)} ms/chunk); scoring 5,000 conversations (50,000 chunks) ${Math.round(searchMs)} ms`)
  })
})
