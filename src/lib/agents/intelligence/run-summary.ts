import type { AgentDomainIndex } from "./domain-index";
import type { AgentRunSummary, WorkItemCounts } from "./types";
import type { AgentWorkItem, AgentWorkItemProgress, AgentWorkItemStatus } from "@/lib/agents/types";

/**
 * Reducing one run to numbers.
 *
 * Every number here is a count of things that exist. None is a rate, an
 * estimate, an extrapolation, or a function of elapsed time. That is the
 * whole discipline of this file, and it is worth stating plainly because the
 * failure this phase must avoid is a confident figure assembled from nothing:
 *
 *     4 work items, 2 completed        -> 50%     (a count)
 *     agent edited 4 files             -> 80%     (invented)
 *     transcript ended                 -> done    (invented)
 *     run status is working            -> 75%     (invented)
 *
 * Only the first is computed. The other three have no code path.
 */

/**
 * Per-status counts, in one pass.
 *
 * Exhaustive by construction: the switch covers all five statuses and the
 * buckets sum to `total`, so a status added to the domain later becomes a
 * type error here rather than a silently uncounted item.
 */
export function countWorkItems(items: readonly AgentWorkItem[] | undefined): WorkItemCounts {
  const counts: WorkItemCounts = {
    total: 0,
    pending: 0,
    active: 0,
    blocked: 0,
    completed: 0,
    cancelled: 0,
  };
  if (!items) return counts;

  for (const item of items) {
    counts.total += 1;
    counts[item.status] += 1;
  }

  return counts;
}

/**
 * How far a run has got through its work items.
 *
 * The bucket-level twin of `getRunWorkProgress` in lib/agents/selectors.ts,
 * operating on an already-grouped array so the indexed path stays linear
 * rather than rescanning every work item in the account per run.
 *
 * The rule is Phase 15's, unchanged and deliberately not re-decided here:
 *
 * - `total` is how many items actually exist;
 * - `completed` is how many actually reached `completed`;
 * - **cancelled items count toward neither side**, so a plan whose last two
 *   items were abandoned can still read as finished;
 * - a run with nothing countable returns `undefined`, never `0 / 0` - an
 *   honest-looking zero is a measurement, and there was no measurement.
 *
 * Duplicating the rule rather than importing the selector is a real cost, so
 * `run-summary.test.ts` pins the two implementations against each other over
 * generated states. If they ever disagree, that test fails rather than one
 * surface quietly disagreeing with another.
 */
export function deriveWorkProgress(
  items: readonly AgentWorkItem[] | undefined
): AgentWorkItemProgress | undefined {
  if (!items?.length) return undefined;

  let completed = 0;
  let total = 0;
  for (const item of items) {
    if (item.status === "cancelled") continue;
    total += 1;
    if (item.status === "completed") completed += 1;
  }

  return total === 0 ? undefined : { completed, total };
}

/**
 * Attention order for the primary work item.
 *
 * Phase 15's ordering, reused rather than re-invented: work being done now
 * outranks work that is stuck, which outranks work not yet started, which
 * outranks work already finished.
 */
const ATTENTION_RANK: Record<AgentWorkItemStatus, number> = {
  active: 0,
  blocked: 1,
  pending: 2,
  completed: 3,
  cancelled: 4,
};

/**
 * The one item that best represents what a run is doing.
 *
 * Derived, never stored - there is no `isPrimary` flag to keep in sync, and a
 * flag would go stale the moment an item finished.
 *
 * The algorithm, stated exactly because §13 of the brief asks for it:
 *
 *   1. among the run's items, take the lowest `ATTENTION_RANK`
 *      (active > blocked > pending > completed > cancelled);
 *   2. break ties by creation order, oldest first;
 *   3. break remaining ties by id, so the order is total and the result is
 *      stable across renders;
 *   4. a run with no items has no primary - `undefined`, never a placeholder.
 *
 * Note what is *not* consulted: the item's title, its summary, its length, or
 * any judgement about whether the text "sounds important". Selection is
 * purely structural, so it cannot be steered by provider-authored prose.
 *
 * Items arrive from the index already sorted oldest-first, so a single scan
 * that takes strictly-better candidates satisfies (1) and (2) together. The
 * explicit id comparison covers callers that pass an unsorted array.
 */
export function selectPrimaryWorkItem(
  items: readonly AgentWorkItem[] | undefined
): AgentWorkItem | undefined {
  if (!items?.length) return undefined;

  let best: AgentWorkItem | undefined;
  for (const item of items) {
    if (!best) {
      best = item;
      continue;
    }
    const delta = ATTENTION_RANK[item.status] - ATTENTION_RANK[best.status];
    if (delta < 0) {
      best = item;
      continue;
    }
    if (delta === 0 && olderFirst(item, best) < 0) best = item;
  }

  return best;
}

/**
 * When this run last showed evidence of doing something.
 *
 * A maximum over timestamps the domain already carries, and nothing else:
 *
 * - the run's own `updatedAt`;
 * - its newest event;
 * - the newest `updatedAt` among its work items;
 * - the newest `createdAt` among its artifact links.
 *
 * It is never `Date.now()`. Reading the wall clock here would answer "when
 * did TabDump last look at this?" while appearing to answer "when did this
 * last happen?" - and the two diverge exactly when it matters, on a run that
 * has gone quiet.
 *
 * Returns `undefined` only for a run that does not exist; a real run always
 * has at least its own `updatedAt`.
 */
export function deriveLastActivityAt(
  index: AgentDomainIndex,
  runId: string
): number | undefined {
  const run = index.runsById.get(runId);
  if (!run) return undefined;

  let latest = run.updatedAt;

  const eventAt = index.latestEventAtByRun.get(runId);
  if (eventAt !== undefined && eventAt > latest) latest = eventAt;

  for (const item of index.workItemsByRun.get(runId) ?? []) {
    if (item.updatedAt > latest) latest = item.updatedAt;
  }

  for (const link of index.artifactLinksByRun.get(runId) ?? []) {
    if (link.createdAt > latest) latest = link.createdAt;
  }

  return latest;
}

/**
 * Everything one run amounts to.
 *
 * Returns `undefined` for a run this index does not hold - a run deleted out
 * from under a selection is an ordinary race, and a caller gets nothing back
 * rather than a summary of zeros that would read as "a run that did nothing".
 *
 * Counts are of DISTINCT targets: a run that both inspected and edited one
 * file holds two artifact links to it, and reporting "2 files" would be
 * wrong. The same applies to a tab that is both context and produced.
 */
export function getAgentRunSummary(
  index: AgentDomainIndex,
  runId: string
): AgentRunSummary | undefined {
  const run = index.runsById.get(runId);
  if (!run) return undefined;

  const items = index.workItemsByRun.get(runId);

  const artifactIds = new Set<string>();
  for (const link of index.artifactLinksByRun.get(runId) ?? []) {
    artifactIds.add(link.artifactId);
  }

  const contextTabIds = new Set<string>();
  const producedTabIds = new Set<string>();
  for (const link of index.tabLinksByRun.get(runId) ?? []) {
    if (link.role === "context") contextTabIds.add(link.tabId);
    else producedTabIds.add(link.tabId);
  }

  const summary: AgentRunSummary = {
    runId,
    agentId: run.agentId,
    // The run's own status, copied. Never recomputed - see the type notes.
    status: run.status,
    workItems: countWorkItems(items),
    artifactCount: artifactIds.size,
    contextTabCount: contextTabIds.size,
    producedTabCount: producedTabIds.size,
  };

  const progress = deriveWorkProgress(items);
  if (progress) summary.progress = progress;

  const lastActivityAt = deriveLastActivityAt(index, runId);
  if (lastActivityAt !== undefined) summary.lastActivityAt = lastActivityAt;

  return summary;
}

/** Oldest first, id breaking ties. Keeps primary selection a total order. */
function olderFirst(a: AgentWorkItem, b: AgentWorkItem): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
