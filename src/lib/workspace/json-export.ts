import { saveTextFile } from "@/lib/platform";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Collection } from "@/lib/collections/types";
import type { ResourceContent } from "@/lib/resources/types";
import type { Workspace } from "./types";

export const EXPORT_VERSION = 1;

export type WorkspaceExport = {
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  workspaces: Workspace[];
  /** Scoped to the tabs actually included in `workspaces` — see buildWorkspaceExport. Always present (possibly empty) so a reader never has to special-case its absence; an *older* file simply lacks the field, which json-import.ts treats as zero dependencies. */
  dependencies: TabDependency[];
  /** Scoped to `workspaces` the same way `dependencies` is — see buildWorkspaceExport. Always present (possibly empty); an older file simply lacks the field, which json-import.ts treats as zero collections. */
  collections: Collection[];
  /**
   * The text Hubble holds for each project's items — saved conversations,
   * notes, pages, PDFs, transcripts — by project id, then item id. Present
   * only when the person chose to include it; an older file lacks it and
   * imports as titles, links and notes' records only.
   */
  contents?: Record<string, Record<string, ResourceContent>>;
};

/**
 * `dependencies`/`collections` are the full stores, not pre-scoped — this
 * filters each down to only what's actually present in `workspaces`, so
 * exporting a single workspace never leaks a dependency or collection
 * pointing at a tab/workspace that isn't in the file (json-import.ts would
 * drop it as a stale reference anyway, but there's no reason to write it out
 * at all).
 */
export function buildWorkspaceExport(
  workspaces: Workspace[],
  dependencies: TabDependency[] = [],
  collections: Collection[] = [],
  /** Stored text by project, then item — only that of the projects and items exported is written. */
  contents?: ReadonlyMap<string, ReadonlyMap<string, ResourceContent>>
): WorkspaceExport {
  const includedWorkspaceIds = new Set(workspaces.map((w) => w.id));
  const includedTabIds = new Set(workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
  const scopedDependencies = dependencies.filter(
    (d) => includedTabIds.has(d.parentTabId) && includedTabIds.has(d.childTabId)
  );
  const scopedCollections = collections
    .filter((c) => includedWorkspaceIds.has(c.workspaceId))
    .map((c) => {
      const tabIds = c.tabIds.filter((id) => includedTabIds.has(id));
      return tabIds.length === c.tabIds.length ? c : { ...c, tabIds };
    });
  let scopedContents: Record<string, Record<string, ResourceContent>> | undefined;
  if (contents) {
    scopedContents = {};
    for (const workspace of workspaces) {
      const stored = contents.get(workspace.id);
      if (!stored) continue;
      const items = new Set([...workspace.tabs.map((tab) => tab.id), ...(workspace.notes ?? []).map((note) => note.id)]);
      const kept: Record<string, ResourceContent> = {};
      for (const [itemId, content] of stored) if (items.has(itemId)) kept[itemId] = content;
      if (Object.keys(kept).length > 0) scopedContents[workspace.id] = kept;
    }
  }
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workspaces,
    dependencies: scopedDependencies,
    collections: scopedCollections,
    ...(scopedContents ? { contents: scopedContents } : {}),
  };
}

export function serializeWorkspaceExport(data: WorkspaceExport): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Saves a workspace export as JSON. Web: a browser download. Desktop: a
 * native "Save as…" dialog. See downloadTextFile in ./export.ts for why
 * this is async and what `false` covers.
 */
export function downloadJsonFile(filename: string, text: string): Promise<boolean> {
  return saveTextFile(filename, text, "application/json;charset=utf-8");
}
