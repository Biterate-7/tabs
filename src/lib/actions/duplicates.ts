import { findDuplicateGroups } from "@/lib/tabs";
import { normalizeUrl } from "@/lib/tabs/normalize";
import { getCurrentWorkspace } from "@/lib/workspace/store";
import { asRecord } from "./validate";
import { tabSummary } from "./lookup";
import type { ActionDefinition } from "./types";

const MAX_GROUPS_RETURNED = 30;
const MAX_TABS_PER_GROUP = 20;

type TabDumpDuplicateGroup = {
  duplicateGroupId: string;
  reason: string;
  confidence: "high" | "medium";
  tabs: ReturnType<typeof tabSummary>[];
  truncated: boolean;
};

type BrowserDuplicateGroup = {
  duplicateGroupId: string;
  reason: string;
  confidence: "high" | "medium";
  tabIds: number[];
  urls: string[];
};

type FindDuplicatesData = {
  tabdump: { groupCount: number; totalDuplicateTabs: number; groups: TabDumpDuplicateGroup[] };
  browser: { groupCount: number; totalDuplicateTabs: number; groups: BrowserDuplicateGroup[] } | null;
};

/**
 * Read-only duplicate detection (Step 4) exposed directly to the agent, on
 * top of the shared src/lib/tabs/duplicates.ts grouping logic that
 * src/lib/organize/analyze.ts also builds on for Auto-Organize — this is
 * the standalone entry point for requests that aren't "organize my tabs" at
 * all, e.g. "find duplicate tabs and clean them up" or "which of my tabs
 * are duplicates?". Never deletes or closes anything itself: the agent is
 * expected to follow this up with delete_tabs (saved TabDump duplicates) or
 * close_tabs (live browser duplicates) once the user picks which copies to
 * keep, both of which already go through the normal confirmation/undo
 * pipeline for a bulk mutation.
 */
export const findDuplicatesAction: ActionDefinition<{ scope: "current" | "all" }, FindDuplicatesData> = {
  name: "find_duplicates",
  description:
    "Find duplicate tabs — both saved TabDump tabs (across workspaces) and, when the browser extension is connected, the user's actual currently-open browser tabs. Returns duplicate groups with a reason and confidence (\"high\" for an exact URL match, \"medium\" for a likely equivalent URL, e.g. www vs. non-www). Use this for requests like \"find duplicate tabs\", \"which of my tabs are duplicates?\", or \"close the duplicate tabs\" — read-only; follow up with delete_tabs for saved-tab duplicates or close_tabs for open-browser-tab duplicates once it's clear which copies to keep.",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      scope: {
        type: "STRING",
        description: "\"current\" to only check the current workspace's saved tabs, or \"all\" to check every workspace. Defaults to \"all\". Browser-tab duplicate detection always covers every open tab regardless of this setting.",
      },
    },
    required: [],
  },
  validate(raw) {
    const record = asRecord(raw) ?? {};
    const scope = record.scope === "current" ? "current" : "all";
    return { ok: true, args: { scope } };
  },
  run(store, args, ctx) {
    const scopeWorkspaces = args.scope === "current" ? [getCurrentWorkspace(store)] : store.workspaces;

    const items = scopeWorkspaces.flatMap((w) =>
      w.tabs.map((tab) => ({ id: tab.id, normalizedUrl: tab.normalizedUrl, domain: tab.domain, workspace: w }))
    );
    const tabById = new Map(items.map((item) => [item.id, item]));
    const rawGroups = findDuplicateGroups(items.map(({ id, normalizedUrl, domain }) => ({ id, normalizedUrl, domain })));

    const tabdumpGroups: TabDumpDuplicateGroup[] = rawGroups.slice(0, MAX_GROUPS_RETURNED).map((g) => ({
      duplicateGroupId: g.duplicateGroupId,
      reason: g.reason,
      confidence: g.confidence,
      tabs: g.ids.slice(0, MAX_TABS_PER_GROUP).map((id) => {
        const item = tabById.get(id)!;
        const tab = item.workspace.tabs.find((t) => t.id === id)!;
        return tabSummary(tab, item.workspace);
      }),
      truncated: g.ids.length > MAX_TABS_PER_GROUP,
    }));

    let browser: FindDuplicatesData["browser"] = null;
    if (ctx?.browserContext) {
      const browserItems = ctx.browserContext.tabs
        .map((tab) => {
          try {
            return { id: tab.tabId, normalizedUrl: normalizeUrl(new URL(tab.url)), domain: new URL(tab.url).hostname, url: tab.url };
          } catch {
            return null;
          }
        })
        .filter((x): x is { id: number; normalizedUrl: string; domain: string; url: string } => x !== null);

      const browserItemById = new Map(browserItems.map((item) => [item.id, item]));
      const browserRawGroups = findDuplicateGroups(browserItems.map(({ id, normalizedUrl, domain }) => ({ id, normalizedUrl, domain })));

      const browserGroups: BrowserDuplicateGroup[] = browserRawGroups.slice(0, MAX_GROUPS_RETURNED).map((g) => ({
        duplicateGroupId: g.duplicateGroupId,
        reason: g.reason,
        confidence: g.confidence,
        tabIds: g.ids,
        urls: g.ids.map((id) => browserItemById.get(id)!.url),
      }));

      browser = {
        groupCount: browserGroups.length,
        totalDuplicateTabs: browserGroups.reduce((sum, g) => sum + g.tabIds.length, 0),
        groups: browserGroups,
      };
    }

    return {
      ok: true,
      data: {
        tabdump: {
          groupCount: tabdumpGroups.length,
          totalDuplicateTabs: tabdumpGroups.reduce((sum, g) => sum + g.tabs.length, 0),
          groups: tabdumpGroups,
        },
        browser,
      },
    };
  },
};
