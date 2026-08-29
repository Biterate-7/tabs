import type { Workspace } from "./types";
import type { TabDependency } from "@/lib/dependencies/types";

/**
 * Maps each workspace id to how many dependency relationships touch a tab it
 * currently holds — used for the sidebar's per-space metadata line. A
 * dependency spanning two different workspaces counts toward both.
 */
export function countRelationshipsByWorkspace(
  workspaces: Workspace[],
  dependencies: TabDependency[]
): Record<string, number> {
  const workspaceOfTab = new Map<string, string>();
  for (const workspace of workspaces) {
    for (const tab of workspace.tabs) workspaceOfTab.set(tab.id, workspace.id);
  }

  const counts: Record<string, number> = {};
  for (const workspace of workspaces) counts[workspace.id] = 0;

  for (const dep of dependencies) {
    const parentWorkspace = workspaceOfTab.get(dep.parentTabId);
    const childWorkspace = workspaceOfTab.get(dep.childTabId);
    if (parentWorkspace) counts[parentWorkspace] = (counts[parentWorkspace] ?? 0) + 1;
    if (childWorkspace && childWorkspace !== parentWorkspace) {
      counts[childWorkspace] = (counts[childWorkspace] ?? 0) + 1;
    }
  }

  return counts;
}
