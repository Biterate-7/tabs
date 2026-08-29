import type { TabDependency } from "@/lib/dependencies/types";
import type { Workspace } from "./types";

export const EXPORT_VERSION = 1;

export type WorkspaceExport = {
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  workspaces: Workspace[];
  /** Scoped to the tabs actually included in `workspaces` — see buildWorkspaceExport. Always present (possibly empty) so a reader never has to special-case its absence; an *older* file simply lacks the field, which json-import.ts treats as zero dependencies. */
  dependencies: TabDependency[];
};

/**
 * `dependencies` is the full store, not pre-scoped — this filters it down to
 * only the pairs where both the parent and child tab are actually present in
 * `workspaces`, so exporting a single workspace never leaks a dependency
 * pointing at a tab that isn't in the file (json-import.ts would drop it as
 * a stale reference anyway, but there's no reason to write it out at all).
 */
export function buildWorkspaceExport(workspaces: Workspace[], dependencies: TabDependency[] = []): WorkspaceExport {
  const includedTabIds = new Set(workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
  const scopedDependencies = dependencies.filter(
    (d) => includedTabIds.has(d.parentTabId) && includedTabIds.has(d.childTabId)
  );
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workspaces,
    dependencies: scopedDependencies,
  };
}

export function serializeWorkspaceExport(data: WorkspaceExport): string {
  return JSON.stringify(data, null, 2);
}

export function downloadJsonFile(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
