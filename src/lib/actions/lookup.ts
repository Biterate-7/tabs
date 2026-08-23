import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

export function findWorkspace(store: WorkspaceStore, workspaceId: string): Workspace | null {
  return store.workspaces.find((w) => w.id === workspaceId) ?? null;
}

export function findGroup(workspace: Workspace, groupId: string) {
  return (workspace.groups ?? []).find((g) => g.id === groupId) ?? null;
}

/**
 * Looks up a tab by id. When `workspaceId` is given the search is scoped to
 * exactly that workspace — this is the enforcement point for "the tab must
 * be yours, in the workspace you said it's in," not just "exists somewhere
 * in the store." Omitting it searches every workspace in the snapshot.
 */
export function findTab(
  store: WorkspaceStore,
  tabId: string,
  workspaceId?: string
): { tab: Tab; workspace: Workspace } | null {
  const scope = workspaceId
    ? store.workspaces.filter((w) => w.id === workspaceId)
    : store.workspaces;
  for (const workspace of scope) {
    const tab = workspace.tabs.find((t) => t.id === tabId);
    if (tab) return { tab, workspace };
  }
  return null;
}

export function workspaceSummary(w: Workspace) {
  return {
    workspaceId: w.id,
    name: w.name,
    tabCount: w.tabs.length,
    groups: (w.groups ?? []).map((g) => ({ groupId: g.id, name: g.name })),
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function tabSummary(tab: Tab, workspace: Workspace) {
  return {
    tabId: tab.id,
    title: tab.title?.trim() || tab.domain,
    url: tab.url,
    domain: tab.domain,
    category: tab.category ?? "other",
    isDuplicate: Boolean(tab.isDuplicate),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  };
}
