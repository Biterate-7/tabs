import { knowledgeItemsOf } from "@/lib/memory/items";
import { sourceKey } from "@/lib/resources/url";
import type { Workspace } from "@/lib/workspace/types";

/**
 * The projects one project is connected to, and by how many shared sources —
 * the same relationships the Graph draws (a page or conversation saved in
 * both, an excerpt in one of a page saved in the other), counted without
 * building the whole graph. Strongest first; ties by name.
 */
export function connectedProjects(workspaces: readonly Workspace[], workspaceId: string): { workspace: Workspace; shared: number }[] {
  const keysOf = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    const keys = new Set<string>();
    for (const item of knowledgeItemsOf(workspace)) {
      if (!item.url) continue;
      const key = sourceKey(item.url);
      if (key) keys.add(key);
    }
    keysOf.set(workspace.id, keys);
  }
  const mine = keysOf.get(workspaceId);
  if (!mine || mine.size === 0) return [];
  const out: { workspace: Workspace; shared: number }[] = [];
  for (const workspace of workspaces) {
    if (workspace.id === workspaceId) continue;
    let shared = 0;
    for (const key of keysOf.get(workspace.id) ?? []) if (mine.has(key)) shared += 1;
    if (shared > 0) out.push({ workspace, shared });
  }
  return out.sort((a, b) => b.shared - a.shared || a.workspace.name.localeCompare(b.workspace.name));
}
