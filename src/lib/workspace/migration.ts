import { createId } from "@/lib/id";
import {
  clearWorkspaceStorage,
  loadWorkspace,
  loadWorkspaceStore,
  saveWorkspaceStore,
} from "./persistence";
import type { Workspace, WorkspaceStore } from "./types";

export const DEFAULT_WORKSPACE_NAME = "General";

export function createDefaultWorkspace(tabs: Workspace["tabs"] = []): Workspace {
  const now = Date.now();
  return {
    id: createId("workspace"),
    name: DEFAULT_WORKSPACE_NAME,
    tabs,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Deterministic and idempotent: once the new `tabdump:workspaces:v1` store
 * exists, this always just returns it unchanged, regardless of whether the
 * legacy single-workspace key is still around. Only runs the legacy->default
 * wrap the first time, when the new store hasn't been created yet.
 */
export function migrateToWorkspaceStore(): WorkspaceStore {
  const existing = loadWorkspaceStore();
  if (existing) return existing;

  const legacyTabs = loadWorkspace();
  const defaultWorkspace = createDefaultWorkspace(legacyTabs ?? []);
  const store: WorkspaceStore = {
    version: 1,
    currentId: defaultWorkspace.id,
    workspaces: [defaultWorkspace],
  };

  saveWorkspaceStore(store);
  if (legacyTabs) clearWorkspaceStorage();

  return store;
}
