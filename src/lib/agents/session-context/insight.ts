import { redactUrl, sanitizeText } from "@/lib/agents/context/sanitize";
import { findDuplicateGroups } from "@/lib/tabs/duplicates";
import type { DuplicateConfidence } from "@/lib/tabs/duplicates";
import type { Tab } from "@/lib/tabs/types";
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
