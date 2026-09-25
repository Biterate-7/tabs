import { collectionIndex } from "./insight";
import { displayTerm, shortHash, termIndex } from "./terms";
import type { TabTerms, TermIndex } from "./terms";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * Which tabs of a workspace belong together, and why (Phase J.6).
 *
 * ## Term-first, site second
 *
 * Tabs are grouped by the words their titles share. A group is *anchored* on
 * one word: repeatedly, the word shared by the most still-ungrouped titles
 * takes those tabs. A word must be used by at least two different titles
 * (copies of one page share every word) and by no more than half the tabs —
 * a word in most titles ("notes", a school's name in a school workspace) is
 * the workspace's theme, not one of its topics. Tabs left over then join the
 * group whose members they share words with most, when they share one with at
 * least a third of it; that step is one hop and never chains. What is still
 * left and shares a site (not a springboard like google.com) forms a site
 * group. The rest is reported as ungrouped, not forced anywhere.
 *
 * Auto-Organize's own clusterer (`lib/organize/cluster.ts`) is site-first on
 * purpose — every tab on one site is locked together — which is right for
 * moving tabs between workspaces and wrong for "what are the topics here",
 * where Wikipedia or YouTube tabs span every subject. Its tokenizer, site
 * identity and naming are reused (./terms.ts); its grouping order is not.
 *
 * ## Explanations are the computation
 *
 * A group's signals are the counts that formed it: which words how many
 * members share, whether most are on one site, which collections already
 * hold them, how many relationships link them. Its reason is built from those
 * numbers and each member's `why` from the word or site that placed it. Nothing
 * is described that was not measured.
 *
 * ## Confidence, in words, by rule
 *
 *   high    three or more tabs held together by two or more shared words,
 *           with at most a third joining on a weaker link;
 *   medium  three or more tabs on one shared word (or one site), or two tabs
 *           sharing two words;
 *   low     anything thinner — two tabs and one word, or a group mostly made
 *           of weaker links.
 *
 * ## Content-addressed ids
 *
 * A group's id is a hash of its scope and its members. The same tabs grouped
 * the same way get the same id at any version, so a follow-up about "the
 * second group" can be checked against the workspace as it is now: the id is
 * found (the group still stands) or it is not (analyze again). No reasoning
 * state is kept anywhere.
 */

export const TOPIC_LIMITS = {
  /** A word in more than this share of the tabs in scope (and in more than three) is the workspace's theme, not one of its topics. */
  maxTermShare: 0.5,
  /** A leftover tab joins a group when it shares a word with at least this share of the group's members. */
  attachShare: 1 / 3,
  label: 60,
} as const;

/** The most tabs of `total` a word may be in and still name a topic rather than the whole workspace. */
export function themeThreshold(total: number): number {
  return Math.max(3, Math.floor(total * TOPIC_LIMITS.maxTermShare));
}

export type TopicConfidence = "high" | "medium" | "low";

export type TopicSignal =
  | { kind: "shared_term"; term: string; tabs: number }
  | { kind: "same_site"; site: string; tabs: number }
  | { kind: "existing_collection"; collectionId: string; name: string; tabs: number }
  | { kind: "relationships"; links: number };

export type TopicMember = {
  tabId: string;
  /** How it joined: by the group's own word, by sharing a word with members, or by site. */
  via: "term" | "shared_word" | "site";
  why: string;
};

export type TopicGroup = {
  groupId: string;
  label: string;
  kind: "topic" | "site";
  confidence: TopicConfidence;
  /** Members in the workspace's saved order. */
  tabIds: readonly string[];
  members: readonly TopicMember[];
  /** The words shared by at least two members, most shared first (stemmed). */
  terms: readonly string[];
  signals: readonly TopicSignal[];
  reason: string;
  /** Members already in some collection. */
  organized: number;
};

export type TopicScope = "all" | "uncategorized";

export type TopicAnalysis = {
  scope: TopicScope;
  tabsConsidered: number;
  /** Every group found, largest first. Callers bound what they show. */
  groups: readonly TopicGroup[];
  /** Tabs in scope that no group took, in saved order. */
  ungrouped: readonly string[];
};

const CONFIDENCE_RANK: Record<TopicConfidence, number> = { high: 0, medium: 1, low: 2 };
const SCOPE_PREFIX: Record<TopicScope, string> = { all: "t", uncategorized: "u" };

/** What a group id looks like: its scope, then 12 hex digits of its members' hash. Anything else names no group. */
export const TOPIC_GROUP_ID = /^[tu]-[0-9a-f]{12}$/;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const quote = (text: string) => `“${text}”`;

type Draft = {
  kind: "topic" | "site";
  anchor?: string;
  site?: string;
  members: { entry: TabTerms; via: TopicMember["via"]; sharedTerms?: readonly string[]; sharedWith?: number }[];
};

function groupIdOf(scope: TopicScope, tabIds: readonly string[]): string {
  return `${SCOPE_PREFIX[scope]}-${shortHash([...tabIds].sort().join("\n"))}`;
}

function finalize(
  draft: Draft,
  scope: TopicScope,
  index: TermIndex,
  eligible: ReadonlySet<string>,
  scopeFrequency: ReadonlyMap<string, number>,
  snapshot: SessionContextSnapshot,
  inCollection: ReturnType<typeof collectionIndex>
): TopicGroup {
  const members = [...draft.members].sort((a, b) => a.entry.order - b.entry.order);
  const size = members.length;
  const tabIds = members.map((member) => member.entry.tab.id);
  const memberSet = new Set(tabIds);
  // Evidence counts distinct titles: two copies of one page do not make its words "shared".
  const distinct = new Set(members.map(({ entry }) => entry.titleKey)).size;

  const termTabs = new Map<string, number>();
  const termTitles = new Map<string, Set<string>>();
  for (const { entry } of members) {
    for (const term of entry.terms) {
      if (!eligible.has(term)) continue;
      termTabs.set(term, (termTabs.get(term) ?? 0) + 1);
      const titles = termTitles.get(term) ?? new Set<string>();
      titles.add(entry.titleKey);
      termTitles.set(term, titles);
    }
  }
  const titlesWith = (term: string) => termTitles.get(term)?.size ?? 0;
  const shared = [...termTabs.entries()]
    .filter(([term]) => titlesWith(term) >= 2)
    .sort(
      (a, b) =>
        titlesWith(b[0]) - titlesWith(a[0]) || b[1] - a[1] || (scopeFrequency.get(a[0]) ?? 0) - (scopeFrequency.get(b[0]) ?? 0) || a[0].localeCompare(b[0])
    );
  const strong = shared.filter(([term]) => titlesWith(term) >= Math.max(2, Math.ceil(distinct / 2))).map(([term]) => term);

  const siteCounts = new Map<string, { name: string; count: number }>();
  for (const { entry } of members) {
    if (entry.genericSite) continue;
    const current = siteCounts.get(entry.site);
    siteCounts.set(entry.site, { name: entry.siteName, count: (current?.count ?? 0) + 1 });
  }
  const dominant = [...siteCounts.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))[0];
  const sameSite = dominant && dominant[1].count >= 2 && dominant[1].count / size >= 0.5 ? dominant[1] : undefined;

  const collectionCounts = new Map<string, { name: string; count: number }>();
  let organized = 0;
  for (const tabId of tabIds) {
    const entry = inCollection.get(tabId);
    if (!entry) continue;
    organized += 1;
    const current = collectionCounts.get(entry.collectionId);
    collectionCounts.set(entry.collectionId, { name: entry.name, count: (current?.count ?? 0) + 1 });
  }
  const holders = [...collectionCounts.entries()].sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name)).slice(0, 3);
  const links = snapshot.dependencies.filter((dependency) => memberSet.has(dependency.parentTabId) && memberSet.has(dependency.childTabId)).length;

  /* ---- Label */
  let label: string;
  if (draft.kind === "site" || !draft.anchor) {
    label = members[0]?.entry.siteName ?? "Ungrouped";
  } else {
    const second = strong.find((term) => term !== draft.anchor);
    if (!second) {
      label = displayTerm(index, draft.anchor);
    } else {
      // Two words, in the order a member's title uses them: "College Admission", not "Admission College".
      const both = members.find(({ entry }) => entry.terms.includes(draft.anchor!) && entry.terms.includes(second));
      const anchorFirst = !both || both.entry.terms.indexOf(draft.anchor) <= both.entry.terms.indexOf(second);
      const [first, next] = anchorFirst ? [draft.anchor, second] : [second, draft.anchor];
      label = `${displayTerm(index, first)} ${displayTerm(index, next)}`;
    }
  }
  label = label.slice(0, TOPIC_LIMITS.label);

  /* ---- Confidence */
  const joinedWeakly = members.filter((member) => member.via === "shared_word").length;
  let confidence: TopicConfidence;
  if (draft.kind === "site") {
    confidence = distinct >= 3 ? "medium" : "low";
  } else if (distinct < 2) {
    confidence = "low";
  } else if (joinedWeakly > size - joinedWeakly) {
    confidence = "low";
  } else if (distinct >= 3 && strong.length >= 2 && joinedWeakly * 3 <= size) {
    confidence = "high";
  } else if (distinct >= 3 || strong.length >= 2) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  /* ---- Signals and reason: the numbers above, nothing else */
  const signals: TopicSignal[] = [
    ...shared.slice(0, 4).map(([term, count]): TopicSignal => ({ kind: "shared_term", term: displayTerm(index, term), tabs: count })),
    ...(sameSite ? [{ kind: "same_site", site: sameSite.name, tabs: sameSite.count } as const] : []),
    ...holders.map(([collectionId, holder]): TopicSignal => ({ kind: "existing_collection", collectionId, name: holder.name, tabs: holder.count })),
    ...(links > 0 ? [{ kind: "relationships", links } as const] : []),
  ];

  const parts: string[] = [];
  if (draft.kind === "topic" && draft.anchor) {
    parts.push(`${plural(termTabs.get(draft.anchor) ?? 0, "tab mentions", "tabs mention")} ${quote(displayTerm(index, draft.anchor))}`);
    const next = shared.find(([term]) => term !== draft.anchor);
    if (next) parts.push(`${next[1]} also ${next[1] === 1 ? "mentions" : "mention"} ${quote(displayTerm(index, next[0]))}`);
    if (joinedWeakly > 0) parts.push(`${plural(joinedWeakly, "more shares", "more share")} other words with them`);
    if (sameSite) parts.push(`${sameSite.count} ${sameSite.count === 1 ? "is" : "are"} on ${sameSite.name}`);
  } else {
    parts.push(`${plural(size, "tab is", "tabs are")} on ${label}; their titles share no topic word`);
  }
  if (links > 0) parts.push(`${plural(links, "relationship links", "relationships link")} them`);

  const memberViews: TopicMember[] = members.map(({ entry, via, sharedTerms, sharedWith }) => {
    const where = entry.termSource === "address" ? "Address" : "Title";
    if (via === "term" && draft.anchor) {
      const second = strong.find((term) => term !== draft.anchor && entry.terms.includes(term));
      return {
        tabId: entry.tab.id,
        via,
        why: `${where} mentions ${quote(displayTerm(index, draft.anchor))}${second ? ` and ${quote(displayTerm(index, second))}` : ""}`,
      };
    }
    if (via === "shared_word" && sharedTerms && sharedTerms.length > 0) {
      return {
        tabId: entry.tab.id,
        via,
        why: `Shares ${sharedTerms.map((term) => quote(displayTerm(index, term))).join(" and ")} with ${plural(sharedWith ?? 1, "tab", "tabs")} in this group`,
      };
    }
    return { tabId: entry.tab.id, via: "site", why: `On ${entry.siteName}, like ${plural(size - 1, "other tab", "other tabs")} here` };
  });

  return {
    groupId: groupIdOf(scope, tabIds),
    label,
    kind: draft.kind,
    confidence,
    tabIds,
    members: memberViews,
    terms: shared.map(([term]) => term),
    signals,
    reason: `${parts.join("; ")}.`,
    organized,
  };
}

function build(snapshot: SessionContextSnapshot, scope: TopicScope): TopicAnalysis {
  const index = termIndex(snapshot);
  const inCollection = collectionIndex(snapshot);
  const inScope = index.entries.filter((entry) => scope === "all" || !inCollection.has(entry.tab.id));

  const postings = new Map<string, TabTerms[]>();
  for (const entry of inScope) {
    for (const term of entry.terms) {
      const list = postings.get(term);
      if (list) list.push(entry);
      else postings.set(term, [entry]);
    }
  }
  const scopeFrequency = new Map([...postings.entries()].map(([term, list]) => [term, list.length]));
  const maxFrequency = themeThreshold(inScope.length);
  // A word is evidence only when two different titles use it: copies of one page share every word.
  const titlesUsing = (list: readonly TabTerms[]) => new Set(list.map((entry) => entry.titleKey)).size;
  const eligible = new Set(
    [...postings.entries()].filter(([, list]) => titlesUsing(list) >= 2 && list.length <= maxFrequency).map(([term]) => term)
  );
  /*
    Candidates by how many titles use them, most first. Grouping only ever
    removes tabs, so the last count a word had bounds what it can still
    gather: a word whose bound cannot reach the best so far is not counted
    again, and a word left with fewer than two ungrouped titles is dropped for
    good. Neither changes the choice — the most ungrouped titles, ties to the
    alphabetically first word — only how much is counted to make it.
  */
  let candidates = [...eligible]
    .map((term) => ({ term, list: postings.get(term)!, bound: titlesUsing(postings.get(term)!) }))
    .sort((a, b) => b.bound - a.bound || a.term.localeCompare(b.term));

  const unassigned = new Set(inScope.map((entry) => entry.tab.id));
  const drafts: Draft[] = [];

  /* ---- 1. Anchor on the word the most ungrouped titles share. */
  for (;;) {
    let best: string | undefined;
    let bestCount = 1;
    const dead = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.bound < bestCount) continue;
      const titles = new Set<string>();
      for (const entry of candidate.list) if (unassigned.has(entry.tab.id)) titles.add(entry.titleKey);
      const count = titles.size;
      candidate.bound = count;
      if (count < 2) dead.add(candidate.term);
      else if (count > bestCount || (count === bestCount && best !== undefined && candidate.term < best)) {
        best = candidate.term;
        bestCount = count;
      }
    }
    if (dead.size > 0) candidates = candidates.filter((candidate) => !dead.has(candidate.term));
    if (!best) break;
    const members = postings.get(best)!.filter((entry) => unassigned.has(entry.tab.id));
    for (const entry of members) unassigned.delete(entry.tab.id);
    drafts.push({ kind: "topic", anchor: best, members: members.map((entry) => ({ entry, via: "term" as const })) });
  }

  /* ---- 2. One hop: a leftover tab joins the group it shares words with most. Never chains. */
  const anchored = drafts.map((draft) => draft.members.map((member) => member.entry));
  for (const entry of inScope) {
    if (!unassigned.has(entry.tab.id)) continue;
    const own = entry.terms.filter((term) => eligible.has(term));
    if (own.length === 0) continue;
    let bestGroup = -1;
    let bestShared = 0;
    let bestTerms: string[] = [];
    anchored.forEach((group, groupIndex) => {
      const sharing = group.filter((member) => own.some((term) => member.terms.includes(term)));
      if (sharing.length === 0 || sharing.length < group.length * TOPIC_LIMITS.attachShare - 1e-9) return;
      if (sharing.length <= bestShared) return;
      // The words it actually shares with them, most shared first, for its `why`.
      const sharedBy = (term: string) => sharing.filter((member) => member.terms.includes(term)).length;
      bestGroup = groupIndex;
      bestShared = sharing.length;
      bestTerms = own.filter((term) => sharedBy(term) > 0).sort((a, b) => sharedBy(b) - sharedBy(a) || a.localeCompare(b));
    });
    if (bestGroup < 0 || bestTerms.length === 0) continue;
    drafts[bestGroup].members.push({ entry, via: "shared_word", sharedTerms: bestTerms.slice(0, 2), sharedWith: bestShared });
    unassigned.delete(entry.tab.id);
  }

  /* ---- 3. What is left and shares a real site. */
  const bySite = new Map<string, TabTerms[]>();
  for (const entry of inScope) {
    if (!unassigned.has(entry.tab.id) || entry.genericSite) continue;
    const list = bySite.get(entry.site);
    if (list) list.push(entry);
    else bySite.set(entry.site, [entry]);
  }
  for (const [site, members] of [...bySite.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (titlesUsing(members) < 2) continue;
    for (const entry of members) unassigned.delete(entry.tab.id);
    drafts.push({ kind: "site", site, members: members.map((entry) => ({ entry, via: "site" as const })) });
  }

  const groups = drafts
    .map((draft) => finalize(draft, scope, index, eligible, scopeFrequency, snapshot, inCollection))
    .sort(
      (a, b) =>
        b.tabIds.length - a.tabIds.length ||
        CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
        a.label.localeCompare(b.label) ||
        a.groupId.localeCompare(b.groupId)
    );

  return {
    scope,
    tabsConsidered: inScope.length,
    groups,
    ungrouped: inScope.filter((entry) => unassigned.has(entry.tab.id)).map((entry) => entry.tab.id),
  };
}

const cache = new WeakMap<SessionContextSnapshot, Partial<Record<TopicScope, TopicAnalysis>>>();

/** The workspace's topic groups. Deterministic, and cached per snapshot (a sync that changes anything is a new snapshot). */
export function analyzeTopics(snapshot: SessionContextSnapshot, options: { uncategorizedOnly?: boolean } = {}): TopicAnalysis {
  const scope: TopicScope = options.uncategorizedOnly === true ? "uncategorized" : "all";
  const cached = cache.get(snapshot) ?? {};
  const hit = cached[scope];
  if (hit) return hit;
  const analysis = build(snapshot, scope);
  cached[scope] = analysis;
  cache.set(snapshot, cached);
  return analysis;
}

/** A group by id, as the workspace stands now — `undefined` when no group with exactly those members exists any more. */
export function findTopicGroup(snapshot: SessionContextSnapshot, groupId: string): TopicGroup | undefined {
  if (!TOPIC_GROUP_ID.test(groupId)) return undefined;
  const prefix = groupId.split("-", 1)[0];
  const scope = (Object.keys(SCOPE_PREFIX) as TopicScope[]).find((key) => SCOPE_PREFIX[key] === prefix);
  if (!scope) return undefined;
  return analyzeTopics(snapshot, { uncategorizedOnly: scope === "uncategorized" }).groups.find((group) => group.groupId === groupId);
}
