import { sanitizeText } from "@/lib/agents/context/sanitize";
import { tokenize } from "@/lib/organize/keywords";
import { CHANGE_LIMITS, cleanCollectionName } from "./changes";
import { collectionIndex } from "./insight";
import { displayTerm, queryTerms, stem, termIndex, termWeight } from "./terms";
import type { TabTerms, TermIndex } from "./terms";
import { themeThreshold } from "./topics";
import type { TopicConfidence } from "./topics";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * "Find everything about X", "which collections already cover this", "should
 * these go in a new collection?" (Phase J.6).
 *
 * Read-only answers over the session's bound snapshot, each with the evidence
 * that produced it. Two ideas:
 *
 *   - **Direct, then related.** A tab is a *direct* match when its title, site
 *     or address path mentions a query word (after the same plural folding
 *     the index uses). The direct matches' own shared vocabulary then finds
 *     *related* tabs — ones that never say the query word but share words the
 *     matches have in common — and a relationship the user drew to a direct
 *     match makes a tab related too. Every result says which it is and why.
 *   - **Collections before creation.** A collection is scored the way
 *     Auto-Organize scores reusing a workspace (`lib/organize/match.ts`: 3 ×
 *     how much of the set is already in it + 2 × its name matching the topic
 *     + 1.5 × its tabs sharing the topic's words), so an agent asked to
 *     organize something first learns what already covers it.
 *
 * ## A recommendation is not an action
 *
 * `recommendPlacement` returns at most one operation, shaped exactly like a
 * J.5 plan operation so the agent can hand it to `preview_workspace_plan`. It
 * is data. Nothing here can propose, approve or apply it — the only way it
 * happens is `propose_workspace_plan` and the user's approval. It is also
 * conservative on purpose: it only ever places tabs that are in no
 * collection (never moves one the user filed), prefers an existing collection
 * that covers the topic over a new near-duplicate, avoids name collisions, and
 * offers nothing at all when the grouping is low-confidence.
 */

export const RELEVANCE_LIMITS = {
  matches: 50,
  collections: 10,
  /** Direct matches whose vocabulary is used to find related tabs. */
  vocabularySeeds: 30,
  vocabulary: 12,
  /** How much evidence an existing collection needs before it is preferred to a new one (Auto-Organize's group threshold). */
  reuseScore: 1.2,
} as const;

const quote = (text: string) => `“${text}”`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/* ------------------------------------------------------------------ *
 * Related tabs
 * ------------------------------------------------------------------ */

export type RelatedMatch = {
  tabId: string;
  /** `direct`: it mentions the topic. `related`: it shares the matches' words, or is linked to one. */
  strength: "direct" | "related";
  confidence: TopicConfidence;
  /** Where the query matched, for direct matches. */
  matchedOn: ("title" | "site" | "address")[];
  why: string;
  score: number;
};

export type RelatedTabs = {
  /** The query's words as understood (folded, stopwords removed), for the agent to show. */
  understoodAs: readonly string[];
  matches: readonly RelatedMatch[];
  totals: { direct: number; related: number };
  truncated: boolean;
  /** Words the direct matches share, used to find related tabs. */
  vocabulary: readonly string[];
  /** Given tab ids that are not tabs of this workspace; dropped, never echoed. */
  unknownTabIds: number;
};

type Scored = { entry: TabTerms; score: number; matchedOn: Set<"title" | "site" | "address">; hits: Set<string> };

function inScope(index: TermIndex, snapshot: SessionContextSnapshot, uncategorizedOnly: boolean): TabTerms[] {
  if (!uncategorizedOnly) return [...index.entries];
  const filed = collectionIndex(snapshot);
  return index.entries.filter((entry) => !filed.has(entry.tab.id));
}

/**
 * Tabs related to a natural-language topic, or to given tabs. With a query,
 * the direct matches seed the vocabulary; with tab ids, those tabs do (and are
 * not listed themselves). At least one of the two is needed.
 */
export function findRelatedTabs(
  snapshot: SessionContextSnapshot,
  input: { query?: string; tabIds?: readonly string[]; uncategorizedOnly?: boolean; limit?: number }
): RelatedTabs {
  const index = termIndex(snapshot);
  const scope = inScope(index, snapshot, input.uncategorizedOnly === true);
  const limit = Math.max(1, Math.min(input.limit ?? 25, RELEVANCE_LIMITS.matches));
  const words = input.query !== undefined ? queryTerms(input.query) : [];
  const requested = [...new Set(input.tabIds ?? [])];
  const seeds = requested.map((tabId) => index.byId.get(tabId)).filter((entry): entry is TabTerms => entry !== undefined);
  const unknownTabIds = requested.length - seeds.length;
  const seedIds = new Set(seeds.map((entry) => entry.tab.id));

  /* ---- Direct matches: the query's words in a title, site name or address path. */
  const direct: Scored[] = [];
  if (words.length > 0) {
    for (const entry of scope) {
      const hits = new Set<string>();
      const matchedOn = new Set<"title" | "site" | "address">();
      let score = 0;
      for (const word of words) {
        const weight = termWeight(index, word);
        if (entry.terms.includes(word)) {
          hits.add(word);
          matchedOn.add(entry.termSource === "address" ? "address" : "title");
          score += weight * 3;
        } else if (entry.siteTerms.includes(word)) {
          hits.add(word);
          matchedOn.add("site");
          score += weight * 2;
        }
      }
      if (hits.size > 0) direct.push({ entry, score, matchedOn, hits });
    }
    direct.sort((a, b) => b.score - a.score || a.entry.order - b.entry.order);
  }

  /* ---- The vocabulary the matches (or the given tabs) share, minus the query itself. */
  const seeded = seeds.length > 0 ? seeds : direct.slice(0, RELEVANCE_LIMITS.vocabularySeeds).map((scored) => scored.entry);
  // One title per page: copies of a match must not make its words look shared.
  const basis = [...new Map(seeded.map((entry) => [entry.titleKey, entry])).values()];
  const counts = new Map<string, number>();
  for (const entry of basis) for (const term of entry.terms) if (!words.includes(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
  // A few matches: any of their words the workspace uses elsewhere is a lead (confidence says how weak).
  // Many matches: only words a good part of them share.
  const needed = basis.length <= 3 ? 1 : Math.max(2, Math.ceil(basis.length * 0.3));
  const common = themeThreshold(index.entries.length);
  const vocabulary = [...counts.entries()]
    .filter(([term, count]) => count >= needed && (index.documentFrequency.get(term) ?? 0) <= common && (index.documentFrequency.get(term) ?? 0) >= 2)
    .sort((a, b) => b[1] - a[1] || termWeight(index, b[0]) - termWeight(index, a[0]) || a[0].localeCompare(b[0]))
    .slice(0, RELEVANCE_LIMITS.vocabulary)
    .map(([term]) => term);

  /* ---- Related: shares that vocabulary, or is linked to a direct match / given tab. */
  const taken = new Set([...direct.map((scored) => scored.entry.tab.id), ...seedIds]);
  const anchors = new Set(seeded.map((entry) => entry.tab.id));
  const linked = new Map<string, string>();
  for (const dependency of snapshot.dependencies) {
    if (anchors.has(dependency.parentTabId) && !anchors.has(dependency.childTabId)) linked.set(dependency.childTabId, dependency.parentTabId);
    if (anchors.has(dependency.childTabId) && !anchors.has(dependency.parentTabId)) linked.set(dependency.parentTabId, dependency.childTabId);
  }
  const related: (RelatedMatch & { order: number })[] = [];
  for (const entry of scope) {
    if (taken.has(entry.tab.id)) continue;
    // Every vocabulary word is already shared by a good part of the matches, so one is enough to be related.
    const shared = vocabulary.filter((term) => entry.terms.includes(term));
    const strongest = shared[0];
    const widelyShared = strongest !== undefined && basis.length >= 2 && (counts.get(strongest) ?? 0) * 2 >= basis.length;
    const link = linked.get(entry.tab.id);
    if (shared.length > 0) {
      const score = shared.reduce((sum, term) => sum + termWeight(index, term) * ((counts.get(term) ?? 0) / basis.length), 0);
      related.push({
        tabId: entry.tab.id,
        strength: "related",
        confidence: shared.length >= 2 || widelyShared ? "medium" : "low",
        matchedOn: [],
        why: `Shares ${shared.slice(0, 3).map((term) => quote(displayTerm(index, term))).join(", ")} with ${seeds.length > 0 ? "the given tabs" : "the matching tabs"}`,
        score: Math.round(score * 100) / 100,
        order: entry.order,
      });
    } else if (link) {
      const other = index.byId.get(link);
      related.push({
        tabId: entry.tab.id,
        strength: "related",
        confidence: "medium",
        matchedOn: [],
        why: `Linked by a relationship to ${quote((sanitizeText(other?.tab.title) ?? other?.siteName ?? "a matching tab").slice(0, 80))}`,
        score: 0.5,
        order: entry.order,
      });
    }
  }
  related.sort((a, b) => b.score - a.score || a.order - b.order);

  const directMatches: RelatedMatch[] = direct.map(({ entry, score, matchedOn, hits }) => {
    const all = hits.size === words.length;
    return {
      tabId: entry.tab.id,
      strength: "direct",
      confidence: all && matchedOn.has("title") ? "high" : hits.size * 2 >= words.length ? "medium" : "low",
      matchedOn: [...matchedOn],
      why: `${matchedOn.has("title") ? "Title" : matchedOn.has("address") ? "Address" : "Site"} mentions ${[...hits].map((term) => quote(displayTerm(index, term))).join(" and ")}`,
      score: Math.round(score * 100) / 100,
    };
  });
  const all: RelatedMatch[] = [
    ...directMatches,
    ...related.map(({ tabId, strength, confidence, matchedOn, why, score }) => ({ tabId, strength, confidence, matchedOn, why, score })),
  ];
  return {
    understoodAs: words.map((term) => displayTerm(index, term)),
    matches: all.slice(0, limit),
    totals: { direct: directMatches.length, related: related.length },
    truncated: all.length > limit,
    vocabulary: vocabulary.map((term) => displayTerm(index, term)),
    unknownTabIds,
  };
}

/* ------------------------------------------------------------------ *
 * Collections
 * ------------------------------------------------------------------ */

export type CollectionRelevance = {
  collectionId: string;
  name: string;
  tabCount: number;
  score: number;
  /** Of the given tabs, how many are already in it. */
  alreadyHolds: number;
  evidence: readonly string[];
};

/** Fraction of `needle` found in `haystack` — containment, not Jaccard, so a one-word name like "Physics" can score fully. */
function containment(needle: readonly string[], haystack: ReadonlySet<string>): number {
  if (needle.length === 0) return 0;
  return needle.filter((term) => haystack.has(term)).length / needle.length;
}

/** The words that describe a set of tabs: those at least two of them share (or all of one tab's), most shared first. */
function topicTermsOf(index: TermIndex, entries: readonly TabTerms[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) for (const term of entry.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  const needed = entries.length <= 1 ? 1 : 2;
  const common = themeThreshold(index.entries.length);
  return [...counts.entries()]
    .filter(([term, count]) => count >= needed && (entries.length <= 2 || (index.documentFrequency.get(term) ?? 0) <= common))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, RELEVANCE_LIMITS.vocabulary)
    .map(([term]) => term);
}

/**
 * Existing collections ranked by how well they cover a topic (query words)
 * and/or a set of tabs. Only collections with some evidence are listed.
 */
export function rankCollections(
  snapshot: SessionContextSnapshot,
  input: { query?: string; tabIds?: readonly string[]; terms?: readonly string[] }
): { collections: CollectionRelevance[]; understoodAs: string[]; unknownTabIds: number } {
  const index = termIndex(snapshot);
  const words = input.query !== undefined ? queryTerms(input.query) : [];
  const requested = [...new Set(input.tabIds ?? [])];
  const given = requested.map((tabId) => index.byId.get(tabId)).filter((entry): entry is TabTerms => entry !== undefined);
  const topic = [...new Set([...words, ...(input.terms ?? []), ...topicTermsOf(index, given)])];
  const givenIds = new Set(given.map((entry) => entry.tab.id));

  const ranked: CollectionRelevance[] = [];
  for (const collection of snapshot.collections) {
    const name = sanitizeText(collection.name) ?? "Untitled collection";
    const nameTerms = [...new Set(tokenize(name).map(stem))];
    const members = new Set(collection.tabIds);
    // Its *other* tabs: a given tab already in it is counted by `holds`, and
    // must not also count as the collection being "about" the given tabs.
    const memberTerms = new Set(
      collection.tabIds.filter((tabId) => !givenIds.has(tabId)).flatMap((tabId) => index.byId.get(tabId)?.terms ?? [])
    );

    const holds = given.filter((entry) => members.has(entry.tab.id)).length;
    const membership = given.length > 0 ? holds / given.length : 0;
    const topicSet = new Set(topic);
    // The share of the given tabs whose own titles use the collection's name: "Physics" describes the tab titled "… (Physics 8.962)".
    const described = nameTerms.length > 0 ? given.filter((entry) => nameTerms.some((term) => entry.terms.includes(term))).length : 0;
    const nameScore = Math.max(
      containment(nameTerms, topicSet),
      containment(words, new Set(nameTerms)),
      given.length > 0 ? described / given.length : 0
    );
    const contentScore = containment(topic, memberTerms);
    const score = membership * 3 + nameScore * 2 + contentScore * 1.5;
    if (score <= 0) continue;

    const evidence: string[] = [];
    const nameHits = nameTerms.filter((term) => topicSet.has(term));
    if (nameHits.length > 0) evidence.push(`Its name matches ${nameHits.map((term) => quote(displayTerm(index, term))).join(", ")}`);
    else if (described > 0) evidence.push(`Its name appears in ${described} of the ${plural(given.length, "tab's", "tabs'")} titles`);
    if (holds > 0) evidence.push(`${holds} of the ${plural(given.length, "tab", "tabs")} ${holds === 1 ? "is" : "are"} already in it`);
    const contentHits = topic.filter((term) => memberTerms.has(term) && !nameHits.includes(term)).slice(0, 3);
    if (contentHits.length > 0) evidence.push(`Its tabs also mention ${contentHits.map((term) => quote(displayTerm(index, term))).join(", ")}`);

    ranked.push({
      collectionId: collection.id,
      name,
      tabCount: collection.tabIds.length,
      score: Math.round(score * 100) / 100,
      alreadyHolds: holds,
      evidence,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    collections: ranked.slice(0, RELEVANCE_LIMITS.collections),
    understoodAs: words.map((term) => displayTerm(index, term)),
    unknownTabIds: requested.length - given.length,
  };
}

/**
 * A name for a new collection: the query's own words ("college applications"
 * → "College Applications"), or else the words the tabs share most. Plain
 * words only, at most five. `undefined` when there is nothing to name it by.
 */
export function suggestedCollectionName(
  snapshot: SessionContextSnapshot,
  input: { query?: string; tabIds?: readonly string[] }
): string | undefined {
  const fromQuery = (sanitizeText(input.query, 80) ?? "")
    .split(" ")
    .filter((word) => /^[A-Za-z0-9]+$/.test(word) && queryTerms(word).length > 0)
    .slice(0, 5)
    .map((word) => (word.length <= 4 && word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()));
  if (fromQuery.length > 0) return fromQuery.join(" ");
  const index = termIndex(snapshot);
  const given = (input.tabIds ?? []).map((tabId) => index.byId.get(tabId)).filter((entry): entry is TabTerms => entry !== undefined);
  const terms = topicTermsOf(index, given).slice(0, 2);
  return terms.length > 0 ? terms.map((term) => displayTerm(index, term)).join(" ") : undefined;
}

/* ------------------------------------------------------------------ *
 * Placement: where a set of tabs should go, if anywhere
 * ------------------------------------------------------------------ */

/** Exactly a J.5 plan operation — for `preview_workspace_plan`. Never applied from here. */
export type SuggestedOperation =
  | { kind: "create_collection"; name: string; tabIds: string[] }
  | { kind: "add_tabs_to_collection"; collectionId: string; tabIds: string[] };

export type Placement =
  | { action: "add_to_existing"; collection: { collectionId: string; name: string }; operation: SuggestedOperation; reason: string }
  | { action: "create"; operation: SuggestedOperation; reason: string }
  | { action: "none"; reason: string }
  | { action: "ask_user"; reason: string };

/**
 * Where a set of tabs belongs. Only tabs in no collection are ever placed;
 * tabs the user already filed stay where they are and are said to.
 */
export function recommendPlacement(
  snapshot: SessionContextSnapshot,
  input: { tabIds: readonly string[]; name?: string; terms?: readonly string[]; confidence?: TopicConfidence }
): Placement {
  const index = termIndex(snapshot);
  const filed = collectionIndex(snapshot);
  const known = [...new Set(input.tabIds)].filter((tabId) => index.byId.has(tabId));
  if (known.length === 0) return { action: "none", reason: "None of those are tabs of this workspace." };
  if (input.confidence === "low") {
    return { action: "ask_user", reason: "This grouping is low-confidence, so no change is suggested. Ask the user whether these belong together." };
  }

  const unfiled = known.filter((tabId) => !filed.has(tabId));
  const holders = [...new Set(known.map((tabId) => filed.get(tabId)?.name).filter((name): name is string => name !== undefined))];
  /** Tabs the user filed somewhere other than `target`: never moved by a suggestion, and said so. */
  const leftNote = (target?: string) => {
    const elsewhere = known.filter((tabId) => filed.has(tabId) && filed.get(tabId)!.collectionId !== target);
    if (elsewhere.length === 0) return "";
    const names = [...new Set(elsewhere.map((tabId) => filed.get(tabId)!.name))].slice(0, 3).map(quote).join(", ");
    return ` ${plural(elsewhere.length, "tab is", "tabs are")} already in ${names} and ${elsewhere.length === 1 ? "is" : "are"} left there.`;
  };

  if (unfiled.length === 0) {
    return {
      action: "none",
      reason: holders.length === 1 ? `Already organized: all of them are in ${quote(holders[0])}.` : `Already organized: all of them are in collections (${holders.slice(0, 3).map(quote).join(", ")}). Moving tabs between collections is the user's call.`,
    };
  }

  const ranked = rankCollections(snapshot, { tabIds: known, terms: input.terms });
  const cleaned = input.name ? cleanCollectionName(input.name) : undefined;
  const sameName = cleaned
    ? snapshot.collections.find((collection) => collection.name.trim().toLowerCase() === cleaned.toLowerCase())
    : undefined;
  const best = ranked.collections[0];
  const reuse = sameName
    ? ranked.collections.find((entry) => entry.collectionId === sameName.id) ?? { collectionId: sameName.id, name: sanitizeText(sameName.name) ?? cleaned!, evidence: ["It already has this name"], score: 0, alreadyHolds: 0, tabCount: sameName.tabIds.length }
    : best && best.score >= RELEVANCE_LIMITS.reuseScore
      ? best
      : undefined;
  const tabIds = unfiled.slice(0, CHANGE_LIMITS.tabs);

  if (reuse) {
    return {
      action: "add_to_existing",
      collection: { collectionId: reuse.collectionId, name: reuse.name },
      operation: { kind: "add_tabs_to_collection", collectionId: reuse.collectionId, tabIds },
      reason: `${quote(reuse.name)} already covers this (${reuse.evidence.join("; ").toLowerCase() || "same topic"}), so add ${plural(tabIds.length, "unorganized tab", "unorganized tabs")} to it rather than creating a near-duplicate.${leftNote(reuse.collectionId)}`,
    };
  }
  if (!cleaned) return { action: "ask_user", reason: `No existing collection covers these. Suggest a name to the user.${leftNote()}` };
  if (tabIds.length < 2) {
    return { action: "ask_user", reason: `Only one of these is unorganized; a one-tab collection is rarely worth it. Ask the user.${leftNote()}` };
  }
  return {
    action: "create",
    operation: { kind: "create_collection", name: cleaned, tabIds },
    reason: `No existing collection covers these (${ranked.collections.length === 0 ? "none share their words" : `the closest, ${quote(ranked.collections[0].name)}, is a weak match`}); ${plural(tabIds.length, "tab is", "tabs are")} in no collection.${leftNote()}`,
  };
}
