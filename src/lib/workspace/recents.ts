import type { Tab } from "@/lib/tabs/types";

/** Recents is a bounded window onto recent activity, not a growing log — see AGENTS.md's "Recent Limit" section. */
export const RECENTS_LIMIT = 100;

export type RecentGroupKey = "today" | "yesterday" | "earlier";

export type RecentGroup = { key: RecentGroupKey; label: string; tabs: Tab[] };

/** Tabs with a recorded `lastAccessedAt`, most-recent first, capped at `limit`. Tabs never opened from TabDump (no timestamp) are excluded entirely — Recents represents activity, not everything in the workspace. */
export function recentTabs(tabs: Tab[], limit: number = RECENTS_LIMIT): Tab[] {
  return tabs
    .filter((t): t is Tab & { lastAccessedAt: number } => typeof t.lastAccessedAt === "number")
    .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
    .slice(0, limit);
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Buckets already-sorted (most-recent-first) recent tabs into Today /
 * Yesterday / Earlier by local calendar day — the coarse grouping the spec
 * calls for instead of a per-row relative timestamp on every item. Empty
 * groups are omitted so the view never renders a header with nothing under it.
 */
export function groupRecents(tabs: Tab[], now: number = Date.now()): RecentGroup[] {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  const groups: Record<RecentGroupKey, Tab[]> = { today: [], yesterday: [], earlier: [] };
  for (const tab of tabs) {
    const accessedAt = tab.lastAccessedAt ?? 0;
    if (accessedAt >= todayStart) groups.today.push(tab);
    else if (accessedAt >= yesterdayStart) groups.yesterday.push(tab);
    else groups.earlier.push(tab);
  }

  return (
    [
      { key: "today", label: "Today", tabs: groups.today },
      { key: "yesterday", label: "Yesterday", tabs: groups.yesterday },
      { key: "earlier", label: "Earlier", tabs: groups.earlier },
    ] satisfies RecentGroup[]
  ).filter((g) => g.tabs.length > 0);
}
