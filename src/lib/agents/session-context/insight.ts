import { redactUrl, sanitizeText } from "@/lib/agents/context/sanitize";
import { findDuplicateGroups } from "@/lib/tabs/duplicates";
import type { DuplicateConfidence } from "@/lib/tabs/duplicates";
import type { Tab } from "@/lib/tabs/types";
import { termIndex } from "./terms";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * Bounded answers about a session's workspace as a whole (Phase J.5).
 *
 * An agent asked to "organize this workspace" needs to know its shape before
 * it reads any tab: how many tabs, how many are in no collection, which
 * collections already exist, which sites dominate, whether anything is saved
 * twice. These are that shape — counts and short lists, never the workspace.
 * Every text field goes through the same sanitizer and URL redaction as every
 * other TabDump answer (lib/agents/context/sanitize.ts); matching is done on
 * the redacted URL, so a search cannot be used to probe a secret query value.
 */

export const INSIGHT_LIMITS = {
  /** Collections listed in the summary, largest first. */
  summaryCollections: 30,
  /** Domains listed in the summary. */
  summaryDomains: 12,
  duplicateGroups: 25,
  tabsPerDuplicateGroup: 10,
  searchResults: 25,
  /** Sites listed by `list_domains` (J.6). */
  domains: 50,
  /** Collections named per site. */
  collectionsPerDomain: 3,
  /** "Possibly the same page" groups (J.6). */
  possibleDuplicateGroups: 15,
} as const;

/** A tab as the organizing tools show it: enough to decide where it goes, nothing more. */
export type TabRow = {
  tabId: string;
  title: string;
  domain?: string;
  url?: string;
  urlRedacted?: true;
  /** The collection it is in now, by id and name; absent when it is in none. */
  collection?: { collectionId: string; name: string };
};

export type CollectionIndex = Map<string, { collectionId: string; name: string }>;

/** tab id → the collection holding it. A tab belongs to at most one. */
export function collectionIndex(snapshot: SessionContextSnapshot): CollectionIndex {
  const index: CollectionIndex = new Map();
  for (const collection of snapshot.collections) {
    const entry = { collectionId: collection.id, name: sanitizeText(collection.name) ?? "Untitled collection" };
    for (const tabId of collection.tabIds) if (!index.has(tabId)) index.set(tabId, entry);
  }
  return index;
}

export function tabRow(tab: Tab, collections: CollectionIndex): TabRow {
  const redacted = redactUrl(tab.url);
  const domain = redacted?.domain ?? sanitizeText(tab.domain);
  const collection = collections.get(tab.id);
  return {
    tabId: tab.id,
    title: sanitizeText(tab.title) ?? redacted?.url ?? domain ?? "Untitled tab",
    ...(domain ? { domain } : {}),
    ...(redacted ? { url: redacted.url } : {}),
    ...(redacted?.redacted ? { urlRedacted: true as const } : {}),
    ...(collection ? { collection } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

export type WorkspaceSummary = {
  workspace: { workspaceId: string; name: string };
  tabs: { total: number; uncategorized: number; pinned: number; favorites: number; withNotes: number };
  collections: {
    total: number;
    empty: number;
    /** Largest first. `more` counts the ones left out. */
    list: { collectionId: string; name: string; tabCount: number }[];
    more: number;
  };
  relationships: { total: number };
  domains: { distinct: number; top: { domain: string; tabs: number }[] };
  duplicates: { groups: number; tabs: number };
};

export function summarizeWorkspace(snapshot: SessionContextSnapshot): WorkspaceSummary {
  const { tabs } = snapshot.workspace;
  const inCollection = collectionIndex(snapshot);

  const domainCounts = new Map<string, number>();
  for (const tab of tabs) {
    const domain = sanitizeText(tab.domain) ?? "unknown";
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }
  const top = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, INSIGHT_LIMITS.summaryDomains)
    .map(([domain, count]) => ({ domain, tabs: count }));

  const collections = snapshot.collections
    .map((collection) => ({
      collectionId: collection.id,
      name: sanitizeText(collection.name) ?? "Untitled collection",
      tabCount: collection.tabIds.length,
    }))
    .sort((a, b) => b.tabCount - a.tabCount || a.name.localeCompare(b.name));

  const duplicates = findDuplicateGroups(tabs.map((tab) => ({ id: tab.id, normalizedUrl: tab.normalizedUrl, domain: tab.domain })));

  return {
    workspace: { workspaceId: snapshot.workspace.id, name: sanitizeText(snapshot.workspace.name) ?? "Untitled workspace" },
    tabs: {
      total: tabs.length,
      uncategorized: tabs.filter((tab) => !inCollection.has(tab.id)).length,
      pinned: tabs.filter((tab) => tab.pinned === true).length,
      favorites: tabs.filter((tab) => tab.isFavorite === true).length,
      withNotes: tabs.filter((tab) => typeof tab.notes === "string" && tab.notes.trim() !== "").length,
    },
    collections: {
      total: collections.length,
      empty: collections.filter((collection) => collection.tabCount === 0).length,
      list: collections.slice(0, INSIGHT_LIMITS.summaryCollections),
      more: Math.max(0, collections.length - INSIGHT_LIMITS.summaryCollections),
    },
    relationships: { total: snapshot.dependencies.length },
    domains: { distinct: domainCounts.size, top },
    duplicates: { groups: duplicates.length, tabs: duplicates.reduce((sum, group) => sum + group.ids.length, 0) },
  };
}

/* ------------------------------------------------------------------ *
 * Duplicates — TabDump's own detection (lib/tabs/duplicates.ts), exposed
 * ------------------------------------------------------------------ */

export type DuplicateTabGroup = {
  /** `high`: the same address. `medium`: the same page saved slightly differently (www, protocol). */
  confidence: DuplicateConfidence;
  reason: string;
  tabs: TabRow[];
  moreTabs: number;
};

export function duplicateTabGroups(snapshot: SessionContextSnapshot): { groups: DuplicateTabGroup[]; totalGroups: number; truncated: boolean } {
  const byId = new Map(snapshot.workspace.tabs.map((tab) => [tab.id, tab]));
  const inCollection = collectionIndex(snapshot);
  const found = findDuplicateGroups(
    snapshot.workspace.tabs.map((tab) => ({ id: tab.id, normalizedUrl: tab.normalizedUrl, domain: tab.domain }))
  );
  // Exact copies first, then the looser tier; within each, the biggest groups.
  const ordered = [...found].sort(
    (a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) || b.ids.length - a.ids.length
  );
  const groups = ordered.slice(0, INSIGHT_LIMITS.duplicateGroups).map((group) => ({
    confidence: group.confidence,
    reason: sanitizeText(group.reason) ?? "Likely the same page.",
    tabs: group.ids
      .slice(0, INSIGHT_LIMITS.tabsPerDuplicateGroup)
      .map((id) => byId.get(id))
      .filter((tab): tab is Tab => tab !== undefined)
      .map((tab) => tabRow(tab, inCollection)),
    moreTabs: Math.max(0, group.ids.length - INSIGHT_LIMITS.tabsPerDuplicateGroup),
  }));
  return { groups, totalGroups: found.length, truncated: found.length > groups.length };
}

/**
 * A looser tier, kept apart on purpose (J.6): the same title on the same site
 * at different addresses — a page saved once with a session parameter and
 * once without, say. Often the same page, sometimes not (two different
 * "Dashboard"s), so it is never counted as a duplicate, never in the summary,
 * and says "check before treating them as the same page". A title needs two
 * significant words to count; tabs already in a same-address group are left
 * out, so nothing is reported twice.
 */
export function possibleDuplicateTabGroups(snapshot: SessionContextSnapshot): {
  groups: { reason: string; tabs: TabRow[]; moreTabs: number }[];
  totalGroups: number;
  truncated: boolean;
} {
  const index = termIndex(snapshot);
  const inCollection = collectionIndex(snapshot);
  const certain = new Set(
    findDuplicateGroups(snapshot.workspace.tabs.map((tab) => ({ id: tab.id, normalizedUrl: tab.normalizedUrl, domain: tab.domain }))).flatMap(
      (group) => group.ids
    )
  );
  const buckets = new Map<string, Tab[]>();
  for (const entry of index.entries) {
    if (certain.has(entry.tab.id) || entry.termSource !== "title" || entry.terms.length < 2) continue;
    const title = (sanitizeText(entry.tab.title) ?? "").toLowerCase();
    const key = `${entry.site}\n${title}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry.tab);
    else buckets.set(key, [entry.tab]);
  }
  const found = [...buckets.values()].filter((tabs) => tabs.length >= 2 && new Set(tabs.map((tab) => tab.normalizedUrl)).size >= 2);
  const groups = found.slice(0, INSIGHT_LIMITS.possibleDuplicateGroups).map((tabs) => ({
    reason: `${tabs.length} tabs with the same title on the same site, at different addresses. Possibly the same page — check before treating them as duplicates.`,
    tabs: tabs.slice(0, INSIGHT_LIMITS.tabsPerDuplicateGroup).map((tab) => tabRow(tab, inCollection)),
    moreTabs: Math.max(0, tabs.length - INSIGHT_LIMITS.tabsPerDuplicateGroup),
  }));
  return { groups, totalGroups: found.length, truncated: found.length > groups.length };
}

/* ------------------------------------------------------------------ *
 * Sites (J.6)
 * ------------------------------------------------------------------ */

export type DomainRow = {
  /** The site as a person names it: "YouTube", "Wikipedia". */
  site: string;
  /** Its host, as the tabs' redacted addresses show it. */
  domain: string;
  tabs: number;
  /** Tabs of this site in no collection. */
  unorganized: number;
  /** Where its organized tabs are, most first. */
  collections: { collectionId: string; name: string; tabs: number }[];
};

/** Every site in the workspace (or among its unorganized tabs), biggest first, with where its tabs are filed. */
export function domainBreakdown(
  snapshot: SessionContextSnapshot,
  options: { uncategorizedOnly?: boolean } = {}
): { domains: DomainRow[]; distinct: number; more: number; tabsConsidered: number } {
  const index = termIndex(snapshot);
  const inCollection = collectionIndex(snapshot);
  const rows = new Map<string, DomainRow & { held: Map<string, { name: string; tabs: number }> }>();
  let considered = 0;
  for (const entry of index.entries) {
    const holder = inCollection.get(entry.tab.id);
    if (options.uncategorizedOnly === true && holder) continue;
    considered += 1;
    const key = entry.site || "unknown";
    const row = rows.get(key) ?? { site: entry.siteName, domain: key, tabs: 0, unorganized: 0, collections: [], held: new Map() };
    row.tabs += 1;
    if (!holder) row.unorganized += 1;
    else row.held.set(holder.collectionId, { name: holder.name, tabs: (row.held.get(holder.collectionId)?.tabs ?? 0) + 1 });
    rows.set(key, row);
  }
  const all = [...rows.values()]
    .sort((a, b) => b.tabs - a.tabs || a.domain.localeCompare(b.domain))
    .map(({ held, ...row }) => ({
      ...row,
      collections: [...held.entries()]
        .sort((a, b) => b[1].tabs - a[1].tabs || a[1].name.localeCompare(b[1].name))
        .slice(0, INSIGHT_LIMITS.collectionsPerDomain)
        .map(([collectionId, value]) => ({ collectionId, name: value.name, tabs: value.tabs })),
    }));
  return {
    domains: all.slice(0, INSIGHT_LIMITS.domains),
    distinct: all.length,
    more: Math.max(0, all.length - INSIGHT_LIMITS.domains),
    tabsConsidered: considered,
  };
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export type TabMatchField = "title" | "domain" | "url" | "notes";

export type TabMatch = { tabId: string; score: number; matchedOn: TabMatchField[] };

const WEIGHT: Record<TabMatchField, number> = { title: 3, domain: 2, url: 1, notes: 1 };

/**
 * Tabs matching every word of `query`, best first. A word may match the
 * title, the domain, the redacted address or — only when asked — the notes.
 * Deterministic: equal scores keep the workspace's own order.
 */
export function searchWorkspaceTabs(
  snapshot: SessionContextSnapshot,
  query: string,
  options: { includeNotes?: boolean; uncategorizedOnly?: boolean; limit?: number } = {}
): { matches: TabMatch[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
  if (words.length === 0) return { matches: [], total: 0 };
  const phrase = words.join(" ");
  const inCollection = options.uncategorizedOnly ? collectionIndex(snapshot) : undefined;

  const matches: (TabMatch & { order: number })[] = [];
  snapshot.workspace.tabs.forEach((tab, order) => {
    if (inCollection?.has(tab.id)) return;
    const fields: [TabMatchField, string][] = [
      ["title", (sanitizeText(tab.title) ?? "").toLowerCase()],
      ["domain", (sanitizeText(tab.domain) ?? "").toLowerCase()],
      ["url", (redactUrl(tab.url)?.url ?? "").toLowerCase()],
    ];
    if (options.includeNotes === true) fields.push(["notes", (sanitizeText(tab.notes, 500) ?? "").toLowerCase()]);

    let score = 0;
    const matchedOn = new Set<TabMatchField>();
    for (const word of words) {
      let hit = false;
      for (const [field, text] of fields) {
        if (!text.includes(word)) continue;
        hit = true;
        score += WEIGHT[field];
        matchedOn.add(field);
      }
      if (!hit) return;
    }
    if (words.length > 1 && fields[0][1].includes(phrase)) score += 2;
    matches.push({ tabId: tab.id, score, matchedOn: [...matchedOn], order });
  });

  matches.sort((a, b) => b.score - a.score || a.order - b.order);
  const limit = Math.min(options.limit ?? 10, INSIGHT_LIMITS.searchResults);
  return {
    matches: matches.slice(0, limit).map(({ tabId, score, matchedOn }) => ({ tabId, score, matchedOn })),
    total: matches.length,
  };
}
