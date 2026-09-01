import { createId } from "@/lib/id";
import { createDefaultWorkspace } from "./migration";
import { markDuplicates } from "@/lib/tabs";
import {
  createSection as createSectionInTree,
  deleteSection as deleteSectionInTree,
  moveSection as moveSectionInTree,
  renameSection as renameSectionInTree,
} from "@/lib/sections/relations";
import type { Section, SectionSource } from "@/lib/sections/types";
import type { Tab } from "@/lib/tabs/types";
import type { Group, Workspace, WorkspaceStore } from "./types";

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

export type MoveTabsResult = {
  store: WorkspaceStore;
  moved: Tab[];
  notFound: string[];
};

/**
 * Moves the tabs matching `tabIds` out of `sourceWorkspaceId` (or, when
 * omitted, wherever each tab is found) and into `targetWorkspaceId`. Ids not
 * found in the expected source are reported in `notFound` rather than
 * throwing — callers (the action layer) decide how to surface a partial
 * move. `markDuplicates` re-runs on the destination so a moved tab's
 * duplicate flag reflects its new neighborhood, not its old one.
 */
export function moveTabsBetweenWorkspaces(
  store: WorkspaceStore,
  tabIds: string[],
  targetWorkspaceId: string,
  sourceWorkspaceId?: string
): MoveTabsResult {
  const wanted = new Set(tabIds);
  const moved: Tab[] = [];
  const foundIds = new Set<string>();

  const withoutMoved = store.workspaces.map((w) => {
    if (sourceWorkspaceId && w.id !== sourceWorkspaceId) return w;
    const keep: Tab[] = [];
    for (const tab of w.tabs) {
      if (wanted.has(tab.id) && !foundIds.has(tab.id)) {
        foundIds.add(tab.id);
        moved.push(tab);
      } else {
        keep.push(tab);
      }
    }
    if (keep.length === w.tabs.length) return w;
    return { ...w, tabs: keep, updatedAt: Date.now() };
  });

  const notFound = tabIds.filter((id) => !foundIds.has(id));

  if (moved.length === 0) {
    return { store, moved: [], notFound };
  }

  // A moved tab's groupId (if any) belonged to a group in its OLD workspace
  // — carrying it across would violate the "a tab's group must live in the
  // tab's own workspace" invariant (a stray groupId string that happens to
  // collide with nothing, or worse, with an unrelated group of the same id
  // shape, in the destination). Moving workspaces always drops group
  // membership; the caller can re-assign a group in the destination
  // afterward via assignTabsToGroup.
  const now = Date.now();
  const ungrouped = moved.map((t) => {
    if (t.groupId === undefined) return t;
    const copy = { ...t };
    delete copy.groupId;
    return copy;
  });
  const withTarget = withoutMoved.map((w) =>
    w.id === targetWorkspaceId
      ? { ...w, tabs: markDuplicates([...w.tabs, ...ungrouped]), updatedAt: now }
      : w
  );

  return { store: { ...store, workspaces: withTarget }, moved: ungrouped, notFound };
}

export function createGroup(store: WorkspaceStore, workspaceId: string, name: string): { store: WorkspaceStore; group: Group } {
  const now = Date.now();
  const group: Group = { id: createId("group"), name, createdAt: now, updatedAt: now };
  const workspaces = store.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, groups: [...(w.groups ?? []), group], updatedAt: now } : w
  );
  return { store: { ...store, workspaces }, group };
}

export function renameGroup(store: WorkspaceStore, workspaceId: string, groupId: string, name: string): WorkspaceStore {
  const now = Date.now();
  const workspaces = store.workspaces.map((w) => {
    if (w.id !== workspaceId) return w;
    const groups = (w.groups ?? []).map((g) => (g.id === groupId ? { ...g, name, updatedAt: now } : g));
    return { ...w, groups, updatedAt: now };
  });
  return { ...store, workspaces };
}

/**
 * Sets `groupId` on every tab in `workspaceId` matching `tabIds` — the pure
 * mutation behind the assign_tabs_to_group action (src/lib/actions/
 * group-membership.ts), which is the only place that validates the group
 * and tabs actually exist/belong to this workspace before calling this.
 * Also doubles as "move a tab from one group to another": passing a
 * different `groupId` for an already-grouped tab simply overwrites it,
 * there is no separate move function. Ids outside `workspaceId`, or not
 * present in it, are silently ignored (not an error at this layer — see the
 * action's own `notFoundTabIds` reporting). Returns the exact same
 * workspace/tab references when nothing actually changed, so unrelated
 * workspaces and untouched tabs stay referentially unchanged.
 */
export function assignTabsToGroup(store: WorkspaceStore, workspaceId: string, tabIds: string[], groupId: string): WorkspaceStore {
  const wanted = new Set(tabIds);
  const now = Date.now();
  const workspaces = store.workspaces.map((w) => {
    if (w.id !== workspaceId) return w;
    let changed = false;
    const tabs = w.tabs.map((t) => {
      if (!wanted.has(t.id) || t.groupId === groupId) return t;
      changed = true;
      return { ...t, groupId };
    });
    return changed ? { ...w, tabs, updatedAt: now } : w;
  });
  return workspaces === store.workspaces || workspaces.every((w, i) => w === store.workspaces[i])
    ? store
    : { ...store, workspaces };
}

/** Clears `groupId` on every tab in `workspaceId` matching `tabIds`, leaving them ungrouped but otherwise untouched. See assignTabsToGroup's doc for the shared contract (silently ignores unmatched ids, referentially stable when nothing changes). */
export function removeTabsFromGroup(store: WorkspaceStore, workspaceId: string, tabIds: string[]): WorkspaceStore {
  const wanted = new Set(tabIds);
  const now = Date.now();
  const workspaces = store.workspaces.map((w) => {
    if (w.id !== workspaceId) return w;
    let changed = false;
    const tabs = w.tabs.map((t) => {
      if (!wanted.has(t.id) || t.groupId === undefined) return t;
      changed = true;
      const copy = { ...t };
      delete copy.groupId;
      return copy;
    });
    return changed ? { ...w, tabs, updatedAt: now } : w;
  });
  return workspaces.every((w, i) => w === store.workspaces[i]) ? store : { ...store, workspaces };
}

/** Creates a section (root when `parentId` is null) in `workspaceId`. Returns `null` (no-op) when the name is blank or `parentId` is already at MAX_SECTION_DEPTH — see src/lib/sections/relations.ts's createSection. */
export function createSectionInWorkspace(
  store: WorkspaceStore,
  workspaceId: string,
  parentId: string | null,
  name: string,
  source: SectionSource
): { store: WorkspaceStore; section: Section } | null {
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;
  const now = Date.now();
  const result = createSectionInTree(workspace.sections ?? [], parentId, name, source, now);
  if (!result) return null;
  const workspaces = store.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, sections: result.sections, updatedAt: now } : w
  );
  return { store: { ...store, workspaces }, section: result.section };
}

export function renameSectionInWorkspace(store: WorkspaceStore, workspaceId: string, sectionId: string, name: string): WorkspaceStore {
  const now = Date.now();
  const workspaces = store.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, sections: renameSectionInTree(w.sections ?? [], sectionId, name), updatedAt: now } : w
  );
  return { ...store, workspaces };
}

/**
 * Deletes `sectionId` (and every descendant section) from `workspaceId`.
 * Every tab that pointed at any removed section has its `sectionId` cleared
 * and is repointed at `reassignToSectionId` when given (must itself survive
 * the deletion — the caller is responsible for that), or left unset
 * ("Other") when omitted — see spec §16's "Delete Section?" flow. Tabs are
 * never deleted.
 */
export function deleteSectionInWorkspace(
  store: WorkspaceStore,
  workspaceId: string,
  sectionId: string,
  reassignToSectionId?: string
): WorkspaceStore {
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return store;
  const now = Date.now();
  const { sections, removedIds } = deleteSectionInTree(workspace.sections ?? [], sectionId);
  const removedSet = new Set(removedIds);
  const tabs = workspace.tabs.map((t) => {
    if (!t.sectionId || !removedSet.has(t.sectionId)) return t;
    if (reassignToSectionId) return { ...t, sectionId: reassignToSectionId };
    const copy = { ...t };
    delete copy.sectionId;
    return copy;
  });
  const workspaces = store.workspaces.map((w) => (w.id === workspaceId ? { ...w, sections, tabs, updatedAt: now } : w));
  return { ...store, workspaces };
}

/** Re-parents `sectionId` within `workspaceId`. No-op (same store reference) when the move would create a cycle or exceed MAX_SECTION_DEPTH — see moveSection. */
export function moveSectionInWorkspace(store: WorkspaceStore, workspaceId: string, sectionId: string, newParentId: string | null): WorkspaceStore {
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return store;
  const moved = moveSectionInTree(workspace.sections ?? [], sectionId, newParentId);
  if (!moved) return store;
  const now = Date.now();
  const workspaces = store.workspaces.map((w) => (w.id === workspaceId ? { ...w, sections: moved, updatedAt: now } : w));
  return { ...store, workspaces };
}

/**
 * Sets `sectionId` (and, when `locked`, `sectionLocked: true` — the
 * mechanism behind "manual placement overrides the AI", spec §13/34) on
 * every tab in `workspaceId` matching `tabIds`. `locked` defaults to `true`
 * since every current caller is a manual user action (drag-drop or the
 * "Move to section" menu); the AI engine writes `sectionId` directly on the
 * Tab objects it returns instead of going through this function, so it never
 * accidentally locks a tab it placed itself.
 */
export function assignTabsToSection(
  store: WorkspaceStore,
  workspaceId: string,
  tabIds: string[],
  sectionId: string,
  locked: boolean = true
): WorkspaceStore {
  const wanted = new Set(tabIds);
  const now = Date.now();
  const workspaces = store.workspaces.map((w) => {
    if (w.id !== workspaceId) return w;
    let changed = false;
    const tabs = w.tabs.map((t) => {
      if (!wanted.has(t.id) || (t.sectionId === sectionId && (!locked || t.sectionLocked))) return t;
      changed = true;
      if (!locked) return { ...t, sectionId };
      // A manual move (the only current caller path with locked=true) makes
      // any AI-era reason/status stale and actively misleading — a future
      // "Why here?" UI should say "you moved this here," not repeat an
      // explanation for a placement the user just overrode.
      const copy = { ...t, sectionId, sectionLocked: true as const, organizationStatus: "manual" as const };
      delete copy.organizationReason;
      return copy;
    });
    return changed ? { ...w, tabs, updatedAt: now } : w;
  });
  return workspaces.every((w, i) => w === store.workspaces[i]) ? store : { ...store, workspaces };
}
