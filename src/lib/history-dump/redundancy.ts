import { canonicalSiteIdentity } from "@/lib/organize/domain-identity";
import { tokenize, tokenOverlap } from "@/lib/organize/keywords";
import { canonicalResourceKey, searchQueryOf } from "./resource-key";

/**
 * "Does this page add anything the pages already chosen don't?" — the
 * near-duplicate half of History Dump's selection (the exact-duplicate half
 * is handled upstream by resource-key folding in aggregate.ts).
 *
 * The distinction this module exists to draw is between *same resource*
 * (drop it), *same subject* (keep it — a Wikipedia article, a paper and a
 * lecture on one topic are three genuinely different resources) and *same
 * type of resource* (keep it — four React docs pages are four pages). Every
 * rule below therefore requires the two pages to share a canonical site
 * identity: a shared title across two different publishers is two takes on
 * one story, which the user may well want both of, while a shared title
 * within one site is nearly always one page reached two ways.
 *
 * Entirely deterministic and local, like score.ts — no model call, no
 * embedding. History candidates have no embeddings available anyway (the
 * index src/lib/ai/cluster.ts reads only covers tabs already saved into a
 * workspace), and pairwise LLM comparison over a large dump would be
 * exactly the latency/cost problem not to introduce.
 */

/** Redundancy at or above this means the candidate adds too little to be worth a slot. Tuned to fire on "the same thing again" and stay silent on "another thing about this". */
export const REDUNDANCY_THRESHOLD = 0.7;

/** Two searches of one site with at least this much query overlap are variations on one question ("price mechanism" vs "price mechanism notes"), not two lines of research. */
const SEARCH_QUERY_MIN_OVERLAP = 0.5;

/** Ordinary pages need near-total title agreement before they count as redundant — "Introduction to Economics" vs "Introduction to Economics — Lecture 2" must survive. */
const TITLE_MIN_OVERLAP = 0.8;

/** Below this many significant tokens a title is too thin for overlap to mean anything — two one-word titles matching proves nothing. */
const MIN_TITLE_TOKENS = 2;

export type RedundancyReason = "duplicate-resource" | "same-page" | "similar-search" | "near-identical-title";

/** User-facing note shown on a row "Select suggested" passed over — see history-dump-view.tsx. */
export const REDUNDANCY_NOTES: Record<RedundancyReason, string> = {
  "duplicate-resource": "Duplicate of another selected tab",
  "same-page": "Same page as another selected tab",
  "similar-search": "Similar search to another selected tab",
  "near-identical-title": "Nearly identical to another selected tab",
};

/** The minimum a candidate needs for comparison; everything else is derived. */
export type RedundancyInput = {
  url: string;
  normalizedUrl?: string;
  title?: string;
};

/** Precomputed comparison signature — built once per candidate, reused across every comparison it takes part in. */
export type CandidateSignature = {
  resourceKey: string;
  siteIdentity: string;
  /** Lowercased, whitespace-collapsed title; empty when there is no usable title. */
  normalizedTitle: string;
  titleTokens: string[];
  /** Significant tokens of the search query this page runs, or null when it is not a search page. */
  searchTokens: string[] | null;
};

export type RedundancyAssessment = {
  score: number;
  reason?: RedundancyReason;
};

const NOT_REDUNDANT: RedundancyAssessment = { score: 0 };

export function buildSignature(candidate: RedundancyInput): CandidateSignature {
  const source = candidate.normalizedUrl || candidate.url;
  const title = candidate.title?.trim() ?? "";

  let siteIdentity = "";
  let searchTokens: string[] | null = null;
  try {
    const url = new URL(source);
    siteIdentity = canonicalSiteIdentity(url.hostname);
    const query = searchQueryOf(url);
    searchTokens = query ? tokenize(query) : null;
  } catch {
    // An unparseable URL still gets a signature; it simply cannot match any
    // site-scoped rule, which is the conservative outcome.
  }

  return {
    resourceKey: canonicalResourceKey(source),
    siteIdentity,
    normalizedTitle: title.toLowerCase().replace(/\s+/g, " "),
    titleTokens: tokenize(title),
    searchTokens: searchTokens && searchTokens.length > 0 ? searchTokens : null,
  };
}

/**
 * How much of `candidate` one already-chosen page already covers, in [0, 1].
 * Returns the strongest applicable signal — the signals are alternative
 * pieces of evidence for one conclusion, not contributions to be summed.
 */
export function pairRedundancy(candidate: CandidateSignature, other: CandidateSignature): RedundancyAssessment {
  if (candidate.resourceKey === other.resourceKey) {
    return { score: 1, reason: "duplicate-resource" };
  }

  // Every remaining rule is site-scoped: see the module comment.
  if (!candidate.siteIdentity || candidate.siteIdentity !== other.siteIdentity) return NOT_REDUNDANT;

  if (candidate.searchTokens && other.searchTokens) {
    const overlap = tokenOverlap(candidate.searchTokens, other.searchTokens);
    // Maps [0.5, 1] overlap onto [0.75, 1] redundancy: a search variation
    // clears the threshold at the point it stops being a new question.
    if (overlap >= SEARCH_QUERY_MIN_OVERLAP) return { score: 0.5 + 0.5 * overlap, reason: "similar-search" };
    return NOT_REDUNDANT;
  }

  if (candidate.normalizedTitle && candidate.normalizedTitle === other.normalizedTitle) {
    return { score: 0.95, reason: "same-page" };
  }

  if (candidate.titleTokens.length >= MIN_TITLE_TOKENS && other.titleTokens.length >= MIN_TITLE_TOKENS) {
    const overlap = tokenOverlap(candidate.titleTokens, other.titleTokens);
    if (overlap >= TITLE_MIN_OVERLAP) return { score: overlap, reason: "near-identical-title" };
  }

  return NOT_REDUNDANT;
}

/**
 * The worst (highest) redundancy between `candidate` and anything already
 * chosen. Callers holding many chosen pages should prefer `RedundancyIndex`
 * below — this plain form is O(n) per call and exists for small comparisons
 * and for tests.
 */
export function calculateRedundancy(
  candidate: CandidateSignature,
  selected: readonly CandidateSignature[]
): RedundancyAssessment {
  let worst = NOT_REDUNDANT;
  for (const other of selected) {
    const assessment = pairRedundancy(candidate, other);
    if (assessment.score > worst.score) worst = assessment;
    if (worst.score >= 1) break;
  }
  return worst;
}

/**
 * An inverted index over what has been chosen so far, so a dump of
 * thousands of entries never degenerates into an O(n²) sweep. Exact, not
 * approximate: every site-scoped rule above needs the two pages to share at
 * least one significant token, so comparing a candidate only against chosen
 * pages that share a token with it cannot miss a match a full sweep would
 * have found.
 */
export class RedundancyIndex {
  private byResourceKey = new Set<string>();
  /** site identity → token → chosen signatures carrying that token. */
  private byToken = new Map<string, Map<string, CandidateSignature[]>>();

  add(signature: CandidateSignature): void {
    this.byResourceKey.add(signature.resourceKey);
    if (!signature.siteIdentity) return;

    let siteTokens = this.byToken.get(signature.siteIdentity);
    if (!siteTokens) {
      siteTokens = new Map();
      this.byToken.set(signature.siteIdentity, siteTokens);
    }
    for (const token of tokensOf(signature)) {
      const bucket = siteTokens.get(token);
      if (bucket) bucket.push(signature);
      else siteTokens.set(token, [signature]);
    }
  }

  assess(candidate: CandidateSignature): RedundancyAssessment {
    if (this.byResourceKey.has(candidate.resourceKey)) {
      return { score: 1, reason: "duplicate-resource" };
    }
    const siteTokens = candidate.siteIdentity ? this.byToken.get(candidate.siteIdentity) : undefined;
    if (!siteTokens) return NOT_REDUNDANT;

    const neighbours = new Set<CandidateSignature>();
    for (const token of tokensOf(candidate)) {
      for (const other of siteTokens.get(token) ?? []) neighbours.add(other);
    }
    return calculateRedundancy(candidate, [...neighbours]);
  }
}

/** A search page is indexed by its query tokens, everything else by its title tokens — matching whichever rule can fire for it. */
function tokensOf(signature: CandidateSignature): string[] {
  return signature.searchTokens ?? signature.titleTokens;
}
