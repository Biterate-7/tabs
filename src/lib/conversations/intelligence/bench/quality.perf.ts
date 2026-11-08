import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { EVAL_SET as CALIBRATION_SET, truthOf } from "../__fixtures__/relatedness-eval";
import { HOLDOUT_SET } from "../__fixtures__/relatedness-holdout";
import type { EvalConversation } from "../__fixtures__/relatedness-eval";
import { buildCorpus } from "../corpus";
import { extractConversation } from "../extract";
import { pairKey, DEFAULT_INTELLIGENCE_SETTINGS } from "../settings";
import { EMBEDDING_MODEL, conversationVector, embeddingChunks, semanticNeighbors } from "../semantic";
import type { SemanticInput } from "../corpus";
import type { Relation } from "../types";

/**
 * Relatedness quality on the hand-labelled set (../__fixtures__/relatedness-eval.ts),
 * with the real on-device model run in Node (the same ONNX weights the
 * browser worker downloads). Compares words-only (phase 1's method), meaning
 * only, and the hybrid, on two questions:
 *
 *   related      should Hubble link these at all?   positives: same problem, a
 *                shared topic, or the same project with a shared topic;
 *                negatives: unrelated. Same project with nothing in common
 *                is neither — linking it is defensible, not linking it too.
 *   same problem should these be one thread?          positives: same problem.
 *
 * A labelled set this small measures direction, not a guarantee; the
 * thresholds were chosen on it, so the hybrid's figures here are optimistic.
 * Real quality comes from a person's own reviews.
 */

type Counts = { tp: number; fp: number; fn: number; tn: number };
const metrics = ({ tp, fp, fn, tn }: Counts) => ({
  precision: tp + fp === 0 ? null : Math.round((tp / (tp + fp)) * 1000) / 1000,
  recall: tp + fn === 0 ? null : Math.round((tp / (tp + fn)) * 1000) / 1000,
  falsePositiveRate: fp + tn === 0 ? null : Math.round((fp / (fp + tn)) * 1000) / 1000,
  tp,
  fp,
  fn,
  tn,
});

const SETS: [string, EvalConversation[]][] = [
  ["calibration", CALIBRATION_SET],
  ["holdout", HOLDOUT_SET],
];

describe("relatedness quality on the labelled sets", () => {
  for (const [name, EVAL_SET] of SETS)
  it(`compares words, meaning and the hybrid on the ${name} set`, async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = path.resolve(".bench-cache/models");
    const extract = (await pipeline("feature-extraction", EMBEDDING_MODEL.id, { dtype: EMBEDDING_MODEL.dtype })) as unknown as (texts: string[], options: object) => Promise<{ tolist(): number[][] }>;

    const records = EVAL_SET.map((entry) => entry.record);
    const extractions = new Map(records.map((record) => [record.id, extractConversation(record)]));
    const started = performance.now();
    let chunkCount = 0;
    const vectors = new Map<string, Float32Array>();
    for (const record of records) {
      const chunks = embeddingChunks(record);
      chunkCount += chunks.length;
      const output = (await extract(chunks.map((chunk) => chunk.text), { pooling: "mean", normalize: true })).tolist();
      vectors.set(record.id, conversationVector(chunks.map((chunk, index) => ({ messageIndex: chunk.messageIndex, vector: output[index]! }))));
    }
    const embedMs = performance.now() - started;
    const entries = [...vectors].map(([recordId, vector]) => ({ recordId, vector }));
    const semantic: SemanticInput = { neighbors: semanticNeighbors(entries), vectors };
    const workspaceNames = new Map(records.map((record) => [record.workspaceId, record.workspaceId.replace(/-/g, " ")]));

    // Every pair's truth.
    const pairs: { key: string; truth: ReturnType<typeof truthOf>; topical: boolean; cosine: number }[] = [];
    for (let i = 0; i < EVAL_SET.length; i++)
      for (let j = i + 1; j < EVAL_SET.length; j++) {
        const x = EVAL_SET[i]!;
        const y = EVAL_SET[j]!;
        let cosine = 0;
        const vx = vectors.get(x.record.id)!;
        const vy = vectors.get(y.record.id)!;
        for (let d = 0; d < vx.length; d++) cosine += vx[d]! * vy[d]!;
        pairs.push({ key: pairKey(x.record.id, y.record.id), truth: truthOf(x, y), topical: x.topics.some((topic) => y.topics.includes(topic)), cosine });
      }
    const relatedTruth = (pair: (typeof pairs)[number]) => (pair.truth === "unrelated" ? false : pair.truth === "same-project" && !pair.topical ? null : true);

    const score = (predictedRelated: (key: string) => boolean, predictedProblem: (key: string) => boolean) => {
      const related: Counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
      const problem: Counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
      const mistakes: string[] = [];
      for (const pair of pairs) {
        const truth = relatedTruth(pair);
        const predicted = predictedRelated(pair.key);
        if (truth !== null) {
          if (truth && predicted) related.tp++;
          else if (truth) related.fn++;
          else if (predicted) {
            related.fp++;
            mistakes.push(`FP ${pair.key.split("|").map((id) => id.split(":").pop()).join(" ~ ")}`);
          } else related.tn++;
        }
        const isProblem = pair.truth === "same-problem";
        const saysProblem = predictedProblem(pair.key);
        if (isProblem && saysProblem) problem.tp++;
        else if (isProblem) problem.fn++;
        else if (saysProblem) {
          problem.fp++;
          mistakes.push(`same-problem FP ${pair.key.split("|").map((id) => id.split(":").pop()).join(" ~ ")} (truth ${pair.truth})`);
        } else problem.tn++;
      }
      return { related: metrics(related), sameProblem: metrics(problem), mistakes };
    };

    const run = (label: string, input: { semantic?: SemanticInput; names?: boolean }) => {
      const corpus = buildCorpus({ records, extractions, settings: DEFAULT_INTELLIGENCE_SETTINGS, ...(input.semantic ? { semantic: input.semantic } : {}), ...(input.names ? { workspaceNames } : {}) });
      const relations = new Map<string, Relation>(corpus.relations.filter((relation) => !relation.sameConversation).map((relation) => [pairKey(relation.a, relation.b), relation]));
      const threadOf = new Map<string, string>();
      for (const thread of corpus.threads) for (const id of thread.recordIds) threadOf.set(id, thread.id);
      const linked = (key: string) => {
        const relation = relations.get(key);
        return !!relation && relation.level !== "shared-entity";
      };
      const sameThread = (key: string) => {
        const [a, b] = key.split("|") as [string, string];
        return threadOf.has(a) && threadOf.get(a) === threadOf.get(b);
      };
      const watch = ["token-storage", "storage-adapter", "indexeddb-loss", "safari-quota", "auth-architecture", "session-expiry"];
      const detail = [...relations.values()].filter((relation) => watch.some((id) => relation.a.endsWith(":" + id)) && watch.some((id) => relation.b.endsWith(":" + id))).map((relation) => `${relation.a.split(":").pop()}~${relation.b.split(":").pop()} ${relation.level} score=${relation.score} lex=${relation.lexical} sem=${relation.semantic} terms=${relation.sharedTerms.join("/")} ents=${relation.sharedEntities.join("/")}`);
      return { label, detail, ...score(linked, sameThread), relations: relations.size, threads: corpus.threads.map((thread) => thread.recordIds.map((id) => id.split(":").pop()).join(", ")) };
    };

    const variants = [
      run("words only (phase 1 method)", {}),
      run("words + project names", { names: true }),
      run("hybrid: words + meaning + project names", { semantic, names: true }),
    ];
    // Meaning alone, at a range of thresholds: the calibration curve the hybrid's thresholds came from.
    const sweep = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((threshold) => {
      const result = score(
        (key) => pairs.find((pair) => pair.key === key)!.cosine >= threshold,
        (key) => pairs.find((pair) => pair.key === key)!.cosine >= threshold
      );
      return { threshold, related: result.related, sameProblem: result.sameProblem };
    });
    // Where the labelled classes sit in meaning space.
    const distribution = (["same-problem", "same-project", "related-topic", "unrelated"] as const).map((truth) => {
      const values = pairs.filter((pair) => pair.truth === truth).map((pair) => pair.cosine).sort((a, b) => a - b);
      const at = (q: number) => Math.round(values[Math.min(values.length - 1, Math.floor(q * values.length))]! * 1000) / 1000;
      return { truth, pairs: values.length, min: at(0), p25: at(0.25), median: at(0.5), p75: at(0.75), max: at(0.999) };
    });
    // The specific case the spec asks about: sign-in architecture / sessions / tokens.
    const signInIds = ["auth-architecture", "session-expiry", "token-storage"].map((id) => EVAL_SET.find((entry) => entry.record.id.endsWith(`:${id}`))?.record.id);
    const signInPairs = signInIds.every(Boolean)
      ? [[0, 1], [0, 2], [1, 2]].map(([i, j]) => ({ pair: `${signInIds[i!]!.split(":").pop()} ~ ${signInIds[j!]!.split(":").pop()}`, cosine: Math.round(pairs.find((pair) => pair.key === pairKey(signInIds[i!]!, signInIds[j!]!))!.cosine * 1000) / 1000 }))
      : [];
    const report = { conversations: records.length, pairs: pairs.length, chunks: chunkCount, embedMs: Math.round(embedMs), msPerChunk: Math.round((embedMs / chunkCount) * 10) / 10, variants, sweep, distribution, signInPairs };
    mkdirSync(".bench-cache", { recursive: true });
    writeFileSync(`.bench-cache/quality-${name}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, variants: variants.map(({ mistakes, ...rest }) => ({ ...rest, mistakes: mistakes.slice(0, 30) })) }, null, 1));
  });
});
