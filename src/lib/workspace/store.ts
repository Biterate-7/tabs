import { createId } from "@/lib/id";
import { createDefaultWorkspace } from "./migration";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "./types";

export function getCurrentWorkspace(store: WorkspaceStore): Workspace {
  const current = store.workspaces.find((w) => w.id === store.currentId);
  // Invariant maintained by every function below: currentId always points
  // at a workspace that exists. Falling back to the first workspace instead
  // of throwing keeps a corrupted currentId (e.g. from a hand-edited export)
  // from taking down the whole app.
  return current ?? store.workspaces[0];
}

export function createWorkspace(store: WorkspaceStore, name: string): WorkspaceStore {
  const trimmed = name.trim();
  const now = Date.now();
  const workspace: Workspace = {
    id: createId("workspace"),
    name: trimmed || "Untitled",
    tabs: [],
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...store,
    currentId: workspace.id,
    workspaces: [...store.workspaces, workspace],
  };
}

export function renameWorkspace(store: WorkspaceStore, id: string, name: string): WorkspaceStore {
  const trimmed = name.trim();
  if (!trimmed) return store;
  return {
    ...store,
    workspaces: store.workspaces.map((w) =>
      w.id === id ? { ...w, name: trimmed, updatedAt: Date.now() } : w
    ),
  };
}

export function switchWorkspace(store: WorkspaceStore, id: string): WorkspaceStore {
  if (!store.workspaces.some((w) => w.id === id)) return store;
  return { ...store, currentId: id };
}

/**
 * Deleting the active workspace hands control to another existing workspace
 * (first remaining one). Deleting the very last workspace never leaves the
 * store empty — a fresh default "General" workspace takes its place, so a
 * user can always dump into something.
 */
export function deleteWorkspace(store: WorkspaceStore, id: string): WorkspaceStore {
  const remaining = store.workspaces.filter((w) => w.id !== id);

  if (remaining.length === 0) {
    const fresh = createDefaultWorkspace();
    return { ...store, currentId: fresh.id, workspaces: [fresh] };
  }

  const currentId = store.currentId === id ? remaining[0].id : store.currentId;
  return { ...store, currentId, workspaces: remaining };
}

export function updateWorkspaceTabs(store: WorkspaceStore, id: string, tabs: Tab[]): WorkspaceStore {
  return {
    ...store,
    workspaces: store.workspaces.map((w) =>
      w.id === id ? { ...w, tabs, updatedAt: Date.now() } : w
    ),
  };
}

/** Appends new workspaces (e.g. from a JSON import) without touching existing ones. */
export function addWorkspaces(store: WorkspaceStore, workspaces: Workspace[]): WorkspaceStore {
  if (workspaces.length === 0) return store;
  return { ...store, workspaces: [...store.workspaces, ...workspaces] };
}
