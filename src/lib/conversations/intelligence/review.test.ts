import { describe, expect, it } from "vitest";
import { NOW, a, record, u } from "./__fixtures__/conversations";
import { buildConversationIndex } from "./corpus";
import { extractConversation } from "./extract";
import { reviewMetrics, reviewOf, reviewQueue } from "./review";
import { DEFAULT_INTELLIGENCE_SETTINGS, clearReviews, pairKey, pruneSettings, readIntelligenceSettings, reviewPair } from "./settings";
import type { PairReview } from "./settings";
import type { ConversationRecord } from "./types";

/**
 * Checking Hubble's links on the person's own history: what is asked, what
 * an answer does, and the figures computed from the answers.
 */

const index = (records: ConversationRecord[], settings = DEFAULT_INTELLIGENCE_SETTINGS) => buildConversationIndex({ records, extractions: new Map(records.map((r) => [r.id, extractConversation(r)])), settings, now: NOW });

const sync = record("sync", [u("The IndexedDB write in the content store fails after reload."), a("Wrap the IndexedDB write in a promise that resolves on oncomplete.")], { title: "IndexedDB write fails" });
const quota = record("quota", [u("Safari private windows reject IndexedDB writes in the content store over quota."), a("Fall back to memory when IndexedDB quota is exceeded.")], { provider: "perplexity", title: "Safari IndexedDB quota" });
const bread = record("bread", [u("My sourdough starter isn't rising."), a("Feed it twice a day somewhere warm.")], { provider: "gemini", title: "Sourdough starter" });

describe("the review queue", () => {
  it("asks about links Hubble showed, skips what was answered, and never asks about a shared name alone", () => {
    const built = index([sync, quota, bread]);
    const queue = reviewQueue(built, {});
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((item) => item.kind === "near-miss" || item.relation.level !== "shared-entity")).toBe(true);
    const first = queue[0]!;
    const answered = { [first.key]: { ...reviewOf(first, "related"), at: NOW } };
    expect(reviewQueue(built, answered).some((item) => item.key === first.key)).toBe(false);
  });

  it("applies an answer as a correction — and moves nothing between projects", () => {
    const built = index([sync, quota]);
    const link = reviewQueue(built, {})[0]!;
    expect(link.kind).toBe("link");
    const settings = reviewPair(DEFAULT_INTELLIGENCE_SETTINGS, sync.id, quota.id, reviewOf(link, "unrelated"), NOW);
    expect(settings.unrelated).toEqual([pairKey(sync.id, quota.id)]);
    const after = index([sync, quota], settings);
    expect(after.relations.filter((entry) => !entry.sameConversation)).toHaveLength(0);
    expect(after.records.map((entry) => entry.workspaceId)).toEqual(built.records.map((entry) => entry.workspaceId));
    // Changing one's mind: related again.
    const back = reviewPair(settings, sync.id, quota.id, reviewOf(link, "related", "same-problem"), NOW);
    expect(back.unrelated).toEqual([]);
    expect(back.related).toEqual([pairKey(sync.id, quota.id)]);
    expect(clearReviews(back).related).toEqual(back.related);
  });
});

describe("the figures", () => {
  const review = (verdict: PairReview["verdict"], proposed: PairReview["proposed"], methods: PairReview["methods"], level?: PairReview["level"]): PairReview => ({ verdict, proposed, methods, lexical: methods.includes("words") ? 0.3 : 0.05, ...(methods.includes("meaning") ? { semantic: 0.5 } : {}), ...(level ? { level } : {}), at: NOW });

  it("computes precision, false links, misses and the method comparison from the person's answers only", () => {
    const metrics = reviewMetrics({
      "a|b": review("related", "same-problem", ["words", "meaning"], "same-problem"),
      "a|c": review("related", "related-topic", ["meaning"], "same-project"),
      "a|d": review("unrelated", "related-topic", ["words"]),
      "a|e": review("related", "none", []),
      "a|f": review("unrelated", "none", []),
    });
    expect(metrics.reviewed).toBe(5);
    expect(metrics.precision).toEqual({ value: 0.667, of: 3 });
    expect(metrics.falseLinkRate).toEqual({ value: 0.333, of: 3 });
    expect(metrics.missed).toEqual({ value: 0.5, of: 2 });
    expect(metrics.levelAgreement).toEqual({ value: 0.5, of: 2 });
    expect(metrics.byMethod.words).toEqual({ value: 0.5, of: 2 });
    expect(metrics.byMethod.meaning).toEqual({ value: 1, of: 2 });
  });

  it("says there is nothing to say before any answer", () => {
    expect(reviewMetrics({}).precision).toEqual({ value: null, of: 0 });
  });
});

describe("answers are the person's data", () => {
  it("are re-read strictly and go with the conversations they name", () => {
    const stored = readIntelligenceSettings({ reviews: { "a|b": { verdict: "related", proposed: "same-problem", methods: ["words", "evil"], lexical: 0.3, at: 1 }, "c|d": { verdict: "maybe" }, nopipe: { verdict: "related", proposed: "none", lexical: 0 } }, related: ["a|b"] });
    expect(stored.reviews).toEqual({ "a|b": { verdict: "related", proposed: "same-problem", methods: ["words"], lexical: 0.3, at: 1 } });
    const pruned = pruneSettings(stored, { recordIds: new Set(["a"]), identities: new Set() });
    expect(pruned.reviews).toEqual({});
    expect(pruned.related).toEqual([]);
  });
});
