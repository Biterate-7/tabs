import { ingestResources, MAX_INGEST_BATCH } from "@/lib/resources/ingest";
import { markDuplicates } from "@/lib/tabs/duplicates";
import { createWorkspace, deleteWorkspace, renameWorkspace } from "@/lib/workspace/store";
import { isPristineDefault, subjectName } from "@/lib/product/subjects";
import { activeGroups, effectiveDestination, itemsById } from "./edit";
import type { CollectionBatchOperation } from "@/lib/collections/batch";
import type { Collection } from "@/lib/collections/types";
import type { ResourceInput, ResourceOrigin } from "@/lib/resources/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";
import type { SmartGroup, SmartProposal } from "./types";

/**
 * Applying a confirmed proposal — through the operations Hubble already has,
 * never a parallel path:
 *
 *   open-tabs → each group's tabs go through ingestResources (the one way
 *               anything becomes a source: same validation, same duplicate
 *               rule, same reading in the background) into an existing
 *               subject or one created with createWorkspace.
 *   subject   → each group becomes create_collection / add_tabs_to_collection
 *               operations for the collection store's all-or-nothing batch.
 *
 * Both are pure and both are safe to repeat: a page already in the subject is
 * a duplicate (nothing added), a subject or collection is found by name before
 * one is made, and a tab already in the target collection is skipped. Nothing
 * is ever deleted, and no tab is closed — Hubble cannot close Chrome tabs from
 * here, and organizing never tries.
 */

export type SmartGroupResult = {
  groupId: string;
  name: string;
  /** The subject or collection the group went to, when it went anywhere. */
  targetId?: string;
  targetName?: string;
  /** Whether that subject or collection was made by this apply. */
  created: boolean;
  /** Pages that became sources (open-tabs) or tabs that joined the collection (subject). */
  added: number;
  /** Already there: nothing to do. */
  alreadyThere: number;
  /** Could not be organized (an address Hubble refused, a tab no longer in the subject). */
  failed: number;
  /** Set when the whole group could not be applied. */
  error?: "destination-missing" | "empty-name";
};

// ---------------------------------------------------------------- open tabs

export type SmartSubjectReceipt = {
  /** Subjects this apply created, with the name it gave them (removed again by undo only while still empty and untouched). */
  createdSubjects: { workspaceId: string; name: string }[];
  /** The untouched default subject, renamed to be the first new subject (see createSubjectIn). */
  renamedDefault?: { workspaceId: string; previousName: string; newName: string };
  /** New source tabs, per subject. */
  added: { workspaceId: string; tabIds: string[] }[];
  /** Each new source's title as it was added, so undo can tell a source the person renamed. */
  addedTitles: Record<string, string>;
  /** Existing plain tabs that became sources, per subject — as they were before, so undo can put them back exactly. */
  adopted: { workspaceId: string; tabs: Tab[] }[];
};

export type SmartSubjectApply = {
  store: WorkspaceStore;
  results: SmartGroupResult[];
  receipt: SmartSubjectReceipt;
  /** Whether anything at all changed. */
  changed: boolean;
};

/**
 * Applies an open-tabs proposal to the workspace store. Groups are applied
 * one by one into a working copy; a group that cannot be applied (its subject
 * was deleted meanwhile) is reported and the rest still go through. The
 * caller commits the returned store once, so a partial result is still one
 * consistent write — and the receipt is what undo needs to take back exactly
 * what this added.
 */
export function applySmartToSubjects(
  store: WorkspaceStore,
  proposal: SmartProposal,
  options: { now: number; subjectsStarted: boolean; origin: ResourceOrigin }
): SmartSubjectApply {
  const originalCurrent = store.currentId;
  const byId = itemsById(proposal);
  const receipt: SmartSubjectReceipt = { createdSubjects: [], added: [], addedTitles: {}, adopted: [] };
  const results: SmartGroupResult[] = [];
  let working = store;
  let started = options.subjectsStarted;

  for (const group of activeGroups(proposal)) {
    const name = group.name.trim();
    if (!name) {
      results.push({ groupId: group.id, name: group.name, created: false, added: 0, alreadyThere: 0, failed: group.itemIds.length, error: "empty-name" });
      continue;
    }

    const places = working.workspaces.map((workspace) => ({ id: workspace.id, name: subjectName(workspace) }));
    const destination = effectiveDestination(group, places);
    let target: Workspace | undefined;
    let created = false;
    if (destination.kind === "subject") {
      target = working.workspaces.find((workspace) => workspace.id === destination.workspaceId);
    } else {
      // The same rule the New subject dialog follows: a lone untouched default becomes the first subject.
      const lone = !started && working.workspaces.length === 1 && isPristineDefault(working.workspaces[0]!) ? working.workspaces[0]! : null;
      if (lone) {
        receipt.renamedDefault = { workspaceId: lone.id, previousName: lone.name, newName: name };
        working = renameWorkspace(working, lone.id, name);
        target = working.workspaces.find((workspace) => workspace.id === lone.id);
      } else {
        working = createWorkspace(working, name);
        target = working.workspaces.at(-1);
        if (target) receipt.createdSubjects.push({ workspaceId: target.id, name: target.name });
      }
      created = true;
      started = true;
    }
    if (!target) {
      results.push({ groupId: group.id, name, created: false, added: 0, alreadyThere: 0, failed: group.itemIds.length, error: "destination-missing" });
      continue;
    }

    const inputs: ResourceInput[] = group.itemIds
      .map((id) => byId.get(id))
      .filter((item) => item !== undefined)
      .map((item) => ({ url: item.url, ...(item.title ? { title: item.title } : {}), ...(item.favicon ? { favicon: item.favicon } : {}) }));

    const result: SmartGroupResult = { groupId: group.id, name, targetId: target.id, targetName: subjectName(target), created, added: 0, alreadyThere: 0, failed: 0 };
    const added: string[] = [];
    const adopted: Tab[] = [];
    const originals = new Map(target.tabs.map((tab) => [tab.id, tab]));
    for (let start = 0; start < inputs.length; start += MAX_INGEST_BATCH) {
      const ingested = ingestResources(working, target.id, inputs.slice(start, start + MAX_INGEST_BATCH), options.origin, options.now);
      if (!ingested) {
        result.failed += Math.min(MAX_INGEST_BATCH, inputs.length - start);
        continue;
      }
      working = ingested.store;
      for (const outcome of ingested.plan.outcomes) {
        if (outcome.status === "added") added.push(outcome.tabId);
        else if (outcome.status === "adopted") {
          const original = originals.get(outcome.tabId);
          if (original) adopted.push(original);
        }
        else if (outcome.status === "duplicate") result.alreadyThere += 1;
        else result.failed += 1;
      }
    }
    result.added = added.length + adopted.length;
    if (added.length > 0) {
      receipt.added.push({ workspaceId: target.id, tabIds: added });
      const landed = new Map(working.workspaces.find((workspace) => workspace.id === target.id)?.tabs.map((tab) => [tab.id, tab.title]) ?? []);
      for (const id of added) {
        const title = landed.get(id);
        if (title) receipt.addedTitles[id] = title;
      }
    }
    if (adopted.length > 0) receipt.adopted.push({ workspaceId: target.id, tabs: adopted });
    results.push(result);
  }

  // Creating a subject makes it current; organizing should leave you where you were.
  if (working.currentId !== originalCurrent && working.workspaces.some((workspace) => workspace.id === originalCurrent)) {
    working = { ...working, currentId: originalCurrent };
  }
  return { store: working, results, receipt, changed: working !== store };
}

export type SmartSubjectUndo = {
  store: WorkspaceStore;
  /** Whether anything at all was taken back. */
  changed: boolean;
  /** Sources taken back out (new ones removed, adopted ones back to plain tabs). */
  removed: number;
  /** Exactly those tabs, per subject — the ones whose stored content no longer belongs to a source. */
  removedTabs: { workspaceId: string; tabIds: string[] }[];
  /** Sources kept because the person has made them theirs since (see undoSmartToSubjects). */
  keptTabs: number;
  /** Subjects the apply created (or renamed) that were kept because they have been used since. */
  keptSubjects: string[];
};

/** A project someone has given more than its name and the tabs organizing put there (a folder an earlier version attached counts too). */
function personalized(workspace: Workspace): boolean {
  return Boolean(workspace.brief?.description || workspace.brief?.focus || workspace.logo || (workspace.notes?.length ?? 0) > 0 || (workspace as { project?: unknown }).project);
}

/**
 * Takes back what an apply added — and nothing anyone did since:
 *
 *   - a new source is removed only while it is still in the subject it was
 *     added to and carries nothing of the person's: no note, no star, not
 *     renamed, not pinned to a section, and not in `options.protect` — the
 *     caller's list of tabs the person filed in a collection or gave content
 *     (an uploaded file, a pasted transcript), which the tab record alone
 *     cannot show. One that is theirs now stays, with its stored content;
 *   - an adopted tab goes back to the plain tab it was, in the same subject,
 *     unless it is in `options.protect` (its supplied content would go with it);
 *   - a subject the apply created is removed only while it is empty, still has
 *     the name it was created with, and has no brief, icon or folder; the
 *     renamed default goes back to its old name under the same rule.
 *
 * Safe on a store that has moved on, including another account's: matching is
 * by id, and anything already gone is skipped. `changed` is false when there
 * was nothing left to take back.
 */
export function undoSmartToSubjects(
  store: WorkspaceStore,
  receipt: SmartSubjectReceipt,
  options: { protect?: ReadonlySet<string> } = {}
): SmartSubjectUndo {
  const protect = options.protect ?? new Set<string>();
  const madeTheirs = (tab: Tab) => {
    const addedTitle = receipt.addedTitles[tab.id];
    return Boolean(tab.notes || tab.isFavorite || tab.sectionLocked || protect.has(tab.id) || (addedTitle !== undefined && tab.title !== addedTitle));
  };
  const addedIn = new Map(receipt.added.flatMap((entry) => entry.tabIds.map((tabId) => [tabId, entry.workspaceId] as const)));
  const adoptedIn = new Map(receipt.adopted.flatMap((entry) => entry.tabs.map((tab) => [tab.id, { workspaceId: entry.workspaceId, original: tab }] as const)));
  let removed = 0;
  let keptTabs = 0;
  const removedTabs: { workspaceId: string; tabIds: string[] }[] = [];
  let working: WorkspaceStore = {
    ...store,
    workspaces: store.workspaces.map((workspace) => {
      let touched = false;
      const tabs: Tab[] = [];
      const taken: string[] = [];
      for (const tab of workspace.tabs) {
        const addedTo = addedIn.get(tab.id);
        if (addedTo !== undefined) {
          if (addedTo === workspace.id && !madeTheirs(tab)) {
            removed += 1;
            touched = true;
            taken.push(tab.id);
            continue;
          }
          keptTabs += 1;
          tabs.push(tab);
          continue;
        }
        const adopted = adoptedIn.get(tab.id);
        if (adopted && adopted.workspaceId === workspace.id && tab.resource && protect.has(tab.id)) {
          keptTabs += 1;
          tabs.push(tab);
          continue;
        }
        if (adopted && adopted.workspaceId === workspace.id && tab.resource) {
          removed += 1;
          touched = true;
          taken.push(tab.id);
          // Back to the plain tab it was, keeping anything the person changed on it since (a note, a favourite).
          const plain: Tab = { ...tab };
          delete plain.resource;
          if (adopted.original.updatedAt === undefined) delete plain.updatedAt;
          else plain.updatedAt = adopted.original.updatedAt;
          if (adopted.original.isDuplicate === undefined) delete plain.isDuplicate;
          else plain.isDuplicate = adopted.original.isDuplicate;
          tabs.push(plain);
          continue;
        }
        tabs.push(tab);
      }
      if (!touched) return workspace;
      removedTabs.push({ workspaceId: workspace.id, tabIds: taken });
      // Re-flag duplicates, touching only a tab whose flag really flips (a removed copy can make its twin unique again).
      const flagged = markDuplicates(tabs);
      return { ...workspace, tabs: tabs.map((tab, index) => (Boolean(tab.isDuplicate) === flagged[index]!.isDuplicate ? tab : flagged[index]!)) };
    }),
  };

  const keptSubjects: string[] = [];
  let subjectsChanged = false;
  for (const created of receipt.createdSubjects) {
    const workspace = working.workspaces.find((entry) => entry.id === created.workspaceId);
    if (!workspace) continue;
    if (workspace.tabs.length > 0 || workspace.name !== created.name || personalized(workspace)) {
      keptSubjects.push(subjectName(workspace));
      continue;
    }
    working = deleteWorkspace(working, workspace.id);
    subjectsChanged = true;
  }
  const renamed = receipt.renamedDefault;
  if (renamed) {
    const workspace = working.workspaces.find((entry) => entry.id === renamed.workspaceId);
    if (workspace && workspace.tabs.length === 0 && workspace.name === renamed.newName && !personalized(workspace)) {
      working = renameWorkspace(working, workspace.id, renamed.previousName);
      subjectsChanged = true;
    } else if (workspace) {
      keptSubjects.push(subjectName(workspace));
    }
  }
  const changed = removed > 0 || subjectsChanged;
  return { store: changed ? working : store, changed, removed, removedTabs, keptTabs, keptSubjects };
}

// ---------------------------------------------------------------- subject

export type SmartCollectionPlan = {
  operations: CollectionBatchOperation[];
  results: SmartGroupResult[];
};

/**
 * The collection-store operations for a subject proposal. Groups going to the
 * same collection (or the same new name) are folded into one operation, so
 * two "Essays" never become two collections; tabs no longer in the subject
 * and tabs already in their target collection are left out of the batch.
 */
export function smartCollectionOperations(
  proposal: SmartProposal,
  workspace: Pick<Workspace, "id" | "tabs">,
  collections: readonly Collection[]
): SmartCollectionPlan {
  const own = collections.filter((collection) => collection.workspaceId === workspace.id);
  const places = own.map((collection) => ({ id: collection.id, name: collection.name }));
  const liveTabIds = new Set(workspace.tabs.map((tab) => tab.id));

  type Target = { key: string; collectionId?: string; name: string; groups: SmartGroup[]; created: boolean };
  const targets = new Map<string, Target>();
  const results: SmartGroupResult[] = [];

  for (const group of activeGroups(proposal)) {
    const name = group.name.trim();
    if (!name) {
      results.push({ groupId: group.id, name: group.name, created: false, added: 0, alreadyThere: 0, failed: group.itemIds.length, error: "empty-name" });
      continue;
    }
    const destination = effectiveDestination(group, places);
    if (destination.kind === "collection" && !own.some((collection) => collection.id === destination.collectionId)) {
      results.push({ groupId: group.id, name, created: false, added: 0, alreadyThere: 0, failed: group.itemIds.length, error: "destination-missing" });
      continue;
    }
    const key = destination.kind === "collection" ? `c:${destination.collectionId}` : `n:${name.toLowerCase()}`;
    const target = targets.get(key) ?? {
      key,
      ...(destination.kind === "collection" ? { collectionId: destination.collectionId } : {}),
      name: destination.kind === "collection" ? own.find((collection) => collection.id === destination.collectionId)!.name : name,
      groups: [],
      created: destination.kind !== "collection",
    };
    target.groups.push(group);
    targets.set(key, target);
  }

  const operations: CollectionBatchOperation[] = [];
  for (const target of targets.values()) {
    const already = new Set(target.collectionId ? own.find((collection) => collection.id === target.collectionId)!.tabIds : []);
    const tabIds: string[] = [];
    for (const group of target.groups) {
      const result: SmartGroupResult = {
        groupId: group.id,
        name: group.name.trim(),
        ...(target.collectionId ? { targetId: target.collectionId } : {}),
        targetName: target.name,
        created: target.created,
        added: 0,
        alreadyThere: 0,
        failed: 0,
      };
      for (const id of group.itemIds) {
        if (!liveTabIds.has(id)) result.failed += 1;
        else if (already.has(id) || tabIds.includes(id)) result.alreadyThere += 1;
        else {
          tabIds.push(id);
          result.added += 1;
        }
      }
      results.push(result);
    }
    if (tabIds.length === 0) continue;
    operations.push(
      target.collectionId
        ? { kind: "add_tabs_to_collection", collectionId: target.collectionId, tabIds }
        : { kind: "create_collection", name: target.name, tabIds }
    );
  }
  return { operations, results };
}

/** "Organized 9 tabs into 3 projects (2 new)." — the line a completed apply reports. */
export function describeApplied(results: readonly SmartGroupResult[], mode: SmartProposal["mode"]): { title: string; details: string[] } {
  const applied = results.filter((result) => !result.error && result.added + result.alreadyThere > 0);
  const added = applied.reduce((sum, result) => sum + result.added, 0);
  const targets = new Set(applied.filter((result) => result.added > 0).map((result) => result.targetId ?? `new:${result.targetName}`));
  const createdTargets = new Set(applied.filter((result) => result.created && result.added > 0).map((result) => result.targetName));
  const place = mode === "open-tabs" ? ["project", "projects"] : ["collection", "collections"];
  const what = mode === "open-tabs" ? ["page", "pages"] : ["tab", "tabs"];
  const title =
    added === 0
      ? "Everything was already organized"
      : `Organized ${added} ${added === 1 ? what[0] : what[1]} into ${targets.size} ${targets.size === 1 ? place[0] : place[1]}${createdTargets.size > 0 ? ` (${createdTargets.size} new)` : ""}`;
  const details: string[] = [];
  const already = results.reduce((sum, result) => sum + result.alreadyThere, 0);
  if (already > 0) details.push(`${already} already there`);
  const failedGroups = results.filter((result) => result.error);
  if (failedGroups.length > 0) details.push(`Couldn't organize ${failedGroups.map((result) => `“${result.name || "Untitled"}”`).join(", ")}`);
  const failedTabs = results.filter((result) => !result.error).reduce((sum, result) => sum + result.failed, 0);
  if (failedTabs > 0) details.push(`${failedTabs} couldn't be added`);
  return { title, details };
}
