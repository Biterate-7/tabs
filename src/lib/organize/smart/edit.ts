import type { SmartDestination, SmartExclusionReason, SmartGroup, SmartItem, SmartProposal } from "./types";

/**
 * The edits a person makes on the review screen, as pure functions over a
 * proposal. Each returns a new proposal (or the same one when nothing
 * changes) and keeps the one invariant the apply step relies on: every item
 * sits in exactly one place — one group, the review list, or the excluded
 * list.
 */

export type SmartTarget = { kind: "group"; groupId: string } | { kind: "review" } | { kind: "excluded"; reason?: SmartExclusionReason };

/** Where an item is right now. */
export function locate(proposal: SmartProposal, itemId: string): SmartTarget | null {
  const group = proposal.groups.find((g) => g.itemIds.includes(itemId));
  if (group) return { kind: "group", groupId: group.id };
  if (proposal.review.includes(itemId)) return { kind: "review" };
  const exclusion = proposal.excluded.find((entry) => entry.itemId === itemId);
  if (exclusion) return { kind: "excluded", reason: exclusion.reason };
  return null;
}

function without(proposal: SmartProposal, itemId: string): SmartProposal {
  return {
    ...proposal,
    groups: proposal.groups.map((g) => (g.itemIds.includes(itemId) ? { ...g, itemIds: g.itemIds.filter((id) => id !== itemId) } : g)),
    review: proposal.review.filter((id) => id !== itemId),
    excluded: proposal.excluded.filter((entry) => entry.itemId !== itemId),
  };
}

/** Moves one item to a group, to "leave as is" (review), or out of the operation. */
export function moveItem(proposal: SmartProposal, itemId: string, target: SmartTarget): SmartProposal {
  if (!proposal.items.some((item) => item.id === itemId)) return proposal;
  if (target.kind === "group" && !proposal.groups.some((g) => g.id === target.groupId)) return proposal;
  const next = without(proposal, itemId);
  switch (target.kind) {
    case "group":
      return { ...next, groups: next.groups.map((g) => (g.id === target.groupId ? { ...g, itemIds: [...g.itemIds, itemId] } : g)) };
    case "review":
      return { ...next, review: [...next.review, itemId] };
    case "excluded":
      return { ...next, excluded: [...next.excluded, { itemId, reason: target.reason ?? "you" }] };
  }
}

function nextGroupId(proposal: SmartProposal): string {
  let index = proposal.groups.length + 1;
  while (proposal.groups.some((g) => g.id === `group-${index}`)) index += 1;
  return `group-${index}`;
}

/** Starts a new group holding `itemId`, named so it can be told apart and renamed. */
export function moveItemToNewGroup(proposal: SmartProposal, itemId: string, name = "New group"): SmartProposal {
  if (!proposal.items.some((item) => item.id === itemId)) return proposal;
  const id = nextGroupId(proposal);
  const destination: SmartDestination = proposal.mode === "open-tabs" ? { kind: "new-subject" } : { kind: "new-collection" };
  const group: SmartGroup = { id, name, reason: "Started by you", itemIds: [], destination };
  return moveItem({ ...proposal, groups: [...proposal.groups, group] }, itemId, { kind: "group", groupId: id });
}

/** Renames a group. An empty name is kept while typing; applying needs a real one (see validateProposal). */
export function renameGroup(proposal: SmartProposal, groupId: string, name: string): SmartProposal {
  return { ...proposal, groups: proposal.groups.map((g) => (g.id === groupId ? { ...g, name } : g)) };
}

export function setDestination(proposal: SmartProposal, groupId: string, destination: SmartDestination): SmartProposal {
  return { ...proposal, groups: proposal.groups.map((g) => (g.id === groupId ? { ...g, destination } : g)) };
}

/** Leaves every tab of a group as it is, and drops the group. */
export function ungroup(proposal: SmartProposal, groupId: string): SmartProposal {
  const group = proposal.groups.find((g) => g.id === groupId);
  if (!group) return proposal;
  return { ...proposal, groups: proposal.groups.filter((g) => g.id !== groupId), review: [...proposal.review, ...group.itemIds] };
}

/**
 * Keeps the first copy of a duplicated page in the operation and takes the
 * other copies out. Nothing is closed or deleted: the copies just are not
 * organized. Copies that are already out stay out.
 */
export function excludeExtraCopies(proposal: SmartProposal, itemIds: readonly string[]): SmartProposal {
  const inPlay = itemIds.filter((id) => locate(proposal, id)?.kind !== "excluded");
  let next = proposal;
  for (const id of inPlay.slice(1)) next = moveItem(next, id, { kind: "excluded", reason: "duplicate" });
  return next;
}

/** Puts excluded copies back in the first kept copy's place. */
export function includeCopies(proposal: SmartProposal, itemIds: readonly string[]): SmartProposal {
  const keeper = itemIds.map((id) => locate(proposal, id)).find((where) => where && where.kind !== "excluded");
  let next = proposal;
  for (const id of itemIds) {
    const where = locate(next, id);
    if (where?.kind === "excluded" && where.reason === "duplicate") next = moveItem(next, id, keeper ?? { kind: "review" });
  }
  return next;
}

export function itemsById(proposal: SmartProposal): Map<string, SmartItem> {
  return new Map(proposal.items.map((item) => [item.id, item]));
}

/** Groups that will actually do something: at least one tab. */
export function activeGroups(proposal: SmartProposal): SmartGroup[] {
  return proposal.groups.filter((g) => g.itemIds.length > 0);
}

/** An existing subject (open-tabs) or collection (subject) a group can go to. */
export type SmartPlace = { id: string; name: string };

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Where a group really goes: a "new" destination whose name is already taken
 * by an existing subject or collection goes to that one, so organizing never
 * makes a second "Physics" beside the first. The apply step resolves names
 * the same way against the live store.
 */
export function effectiveDestination(group: Pick<SmartGroup, "name" | "destination">, places: readonly SmartPlace[]): SmartDestination {
  const destination = group.destination;
  if (destination.kind !== "new-subject" && destination.kind !== "new-collection") return destination;
  const existing = places.find((place) => sameName(place.name, group.name));
  if (!existing) return destination;
  return destination.kind === "new-subject" ? { kind: "subject", workspaceId: existing.id } : { kind: "collection", collectionId: existing.id };
}

export type SmartPlanSummary = {
  /** Groups with tabs. */
  groups: number;
  /** Distinct pages that will be organized (copies of one page count once — Hubble saves it once). */
  pages: number;
  /** Destinations that will be created. */
  created: number;
  /** Existing subjects or collections that receive tabs. */
  existing: number;
  /** Tabs that stay exactly as they are (review + excluded). */
  unchanged: number;
};

export function summarize(proposal: SmartProposal, places: readonly SmartPlace[] = []): SmartPlanSummary {
  const byId = itemsById(proposal);
  const groups = activeGroups(proposal);
  const pagesPerDestination = new Map<string, Set<string>>();
  let created = 0;
  const existingIds = new Set<string>();
  const newNames = new Set<string>();
  for (const group of groups) {
    const destination = effectiveDestination(group, places);
    const key =
      destination.kind === "subject"
        ? `s:${destination.workspaceId}`
        : destination.kind === "collection"
          ? `c:${destination.collectionId}`
          : `n:${group.name.trim().toLowerCase()}`;
    if (destination.kind === "subject" || destination.kind === "collection") existingIds.add(key);
    else if (!newNames.has(key)) {
      newNames.add(key);
      created += 1;
    }
    const pages = pagesPerDestination.get(key) ?? new Set<string>();
    for (const id of group.itemIds) {
      const item = byId.get(id);
      if (item) pages.add(proposal.mode === "open-tabs" ? item.resourceKey : item.id);
    }
    pagesPerDestination.set(key, pages);
  }
  const pages = [...pagesPerDestination.values()].reduce((sum, set) => sum + set.size, 0);
  return { groups: groups.length, pages, created, existing: existingIds.size, unchanged: proposal.review.length + proposal.excluded.length };
}

export type ProposalProblem = { groupId: string; problem: "empty-name" };

/** What must be fixed before confirming: today, only a group left without a name. */
export function validateProposal(proposal: SmartProposal): ProposalProblem[] {
  return activeGroups(proposal)
    .filter((g) => g.name.trim().length === 0)
    .map((g) => ({ groupId: g.id, problem: "empty-name" as const }));
}
