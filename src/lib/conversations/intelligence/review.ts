import { INDEX_CONFIG } from "./corpus";
import { pairKey } from "./settings";
import type { PairReview } from "./settings";
import type { ConversationIndex, NearMiss, Relation, RelationLevel } from "./types";

/**
 * Checking Hubble's links against the person's own judgement, on their own
 * saved history — the only accuracy figure that means anything for them.
 *
 * Nothing here leaves the device: the queue is drawn from the index in the
 * page, the verdicts are stored in the account's settings (settings.reviews),
 * and the figures are computed from those verdicts. Seeded or example
 * conversations are never mixed in.
 *
 * ## What is asked
 *
 * A sample, not everything: links of each kind of evidence (words only,
 * meaning only, both), at each level, and some near misses — pairs with
 * some evidence that Hubble did not link — so the figures can say something
 * about links Hubble misses, not only about the links it shows.
 *
 * ## What the figures mean
 *
 *   precision          of the links Hubble showed that the person checked,
 *                      the share they said are really related
 *   false-link rate    the rest: shown, and not related
 *   missed (estimate)  of the near misses they checked, the share that were
 *                      related after all
 *   by method          the same precision for what words alone, and meaning
 *                      alone, would have shown — from the scores recorded
 *                      with each verdict — so the two can be compared on the
 *                      person's own history
 *
 * Small samples say little; the view says how many verdicts each figure
 * rests on.
 */

export type ReviewItem =
  | { kind: "link"; key: string; relation: Relation; methods: ("words" | "meaning")[] }
  | { kind: "near-miss"; key: string; nearMiss: NearMiss; methods: ("words" | "meaning")[] };

/** Which evidence, on its own, would have linked the pair. */
export function methodsOf(pair: { lexical: number; semantic?: number }): ("words" | "meaning")[] {
  const out: ("words" | "meaning")[] = [];
  if (pair.lexical >= INDEX_CONFIG.relatedScore) out.push("words");
  if (pair.semantic !== undefined && pair.semantic >= INDEX_CONFIG.semanticTopic) out.push("meaning");
  return out;
}

/**
 * The next pairs to ask about: not yet reviewed, links first, spread across
 * methods and levels, then near misses. Deterministic for the same index and
 * reviews, so the queue doesn't reshuffle while the person works through it.
 */
export function reviewQueue(index: ConversationIndex, reviews: Readonly<Record<string, PairReview>>, limit = 12): ReviewItem[] {
  // A shared name alone claims no relationship, so there is nothing to check.
  const links = index.relations.filter((relation) => !relation.sameConversation && relation.level !== "shared-entity" && !relation.confirmed && !reviews[pairKey(relation.a, relation.b)]);
  const buckets = new Map<string, ReviewItem[]>();
  for (const relation of links) {
    const methods = methodsOf(relation);
    const bucket = `${methods.join("+") || "context"}:${relation.level}`;
    const item: ReviewItem = { kind: "link", key: pairKey(relation.a, relation.b), relation, methods };
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), item]);
  }
  // Round-robin over buckets, strongest first within each, so every kind of link is checked.
  for (const list of buckets.values()) list.sort((x, y) => (x.kind === "link" && y.kind === "link" ? y.relation.score - x.relation.score : 0) || (x.key < y.key ? -1 : 1));
  const order = [...buckets.keys()].sort();
  const out: ReviewItem[] = [];
  const linkShare = Math.ceil(limit * 0.75);
  for (let round = 0; out.length < linkShare; round++) {
    let added = false;
    for (const bucket of order) {
      const item = buckets.get(bucket)![round];
      if (!item) continue;
      out.push(item);
      added = true;
      if (out.length >= linkShare) break;
    }
    if (!added) break;
  }
  for (const nearMiss of index.nearMisses) {
    if (out.length >= limit) break;
    const key = pairKey(nearMiss.a, nearMiss.b);
    if (reviews[key]) continue;
    out.push({ kind: "near-miss", key, nearMiss, methods: methodsOf(nearMiss) });
  }
  return out;
}

export type Rate = { value: number | null; of: number };

export type ReviewMetrics = {
  reviewed: number;
  /** Links Hubble showed that the person said are related. */
  precision: Rate;
  falseLinkRate: Rate;
  /** Near misses the person said were related. */
  missed: Rate;
  /** Of links judged related with a level given, how often Hubble's level matched. */
  levelAgreement: Rate;
  /** What words alone, meaning alone, and Hubble's combination would have shown, scored by the person's verdicts. */
  byMethod: { words: Rate; meaning: Rate; hybrid: Rate };
};

const rate = (hits: number, of: number): Rate => ({ value: of === 0 ? null : Math.round((hits / of) * 1000) / 1000, of });

export function reviewMetrics(reviews: Readonly<Record<string, PairReview>>): ReviewMetrics {
  const all = Object.values(reviews);
  const shown = all.filter((review) => review.proposed !== "none");
  const related = (review: PairReview) => review.verdict === "related";
  const near = all.filter((review) => review.proposed === "none");
  const leveled = shown.filter((review) => related(review) && review.level);
  const proposedBy = (method: "words" | "meaning") => all.filter((review) => review.methods.includes(method));
  return {
    reviewed: all.length,
    precision: rate(shown.filter(related).length, shown.length),
    falseLinkRate: rate(shown.filter((review) => !related(review)).length, shown.length),
    missed: rate(near.filter(related).length, near.length),
    levelAgreement: rate(leveled.filter((review) => review.level === review.proposed).length, leveled.length),
    byMethod: {
      words: rate(proposedBy("words").filter(related).length, proposedBy("words").length),
      meaning: rate(proposedBy("meaning").filter(related).length, proposedBy("meaning").length),
      hybrid: rate(shown.filter(related).length, shown.length),
    },
  };
}

/** The verdict to record for an item, with what Hubble had shown for it. */
export function reviewOf(item: ReviewItem, verdict: "related" | "unrelated", level?: RelationLevel): Omit<PairReview, "at"> {
  const pair = item.kind === "link" ? item.relation : item.nearMiss;
  return {
    verdict,
    ...(level ? { level } : {}),
    proposed: item.kind === "link" ? item.relation.level : "none",
    methods: item.methods,
    lexical: pair.lexical,
    ...(pair.semantic !== undefined ? { semantic: pair.semantic } : {}),
  };
}
