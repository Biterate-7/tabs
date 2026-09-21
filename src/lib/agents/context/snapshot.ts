import { resolveContext } from "./resolve";
import type { ContextResolution, ResolveOptions } from "./resolve";
import type {
  AgentContextItem,
  AgentContextRequest,
  AgentContextSnapshot,
  AgentContextSourceType,
} from "./types";
import type { AgentContextWorld } from "./world";

/**
 * Snapshot lifecycle: refresh, comparison, and explaining one after the fact.
 *
 * ## Refresh is a new snapshot, never an update
 *
 * `refreshContext` re-runs the *whole* resolution — validation, the
 * cross-account gate, scope filtering, every limit — against today's world,
 * and returns a second snapshot linked to the first by
 * `previousSnapshotId`. The original is untouched and still frozen.
 *
 * That is the expensive-looking choice and it is the right one. An in-place
 * update would mean a run's context could change between the moment it was
 * attached and the moment the provider read it, which makes a session
 * impossible to reason about and makes "what did the agent know" a question
 * with no answer. It would also quietly skip the gates: a refresh that only
 * re-read the entities already present would never notice that the scope
 * should now deny one of them.
 *
 * ## What a refresh does not do
 *
 * It does not happen on its own. Nothing here is called from a message
 * path, a timer, or an event subscription — a refresh is something a caller
 * decides to do, for the same reason context attachment is explicit.
 */
export function refreshContext(
  previous: AgentContextSnapshot,
  request: AgentContextRequest,
  world: AgentContextWorld,
  options: ResolveOptions = {}
): ContextResolution {
  const resolution = resolveContext(request, world, options);
  if (!resolution.ok) return resolution;

  // Re-frozen rather than mutated: the resolver hands back a deep-frozen
  // object, so the link to the predecessor is added by building a new one.
  const linked: AgentContextSnapshot = {
    ...resolution.snapshot,
    previousSnapshotId: previous.id,
  };

  return { ok: true, snapshot: Object.freeze(linked) };
}

/**
 * The request that produced a snapshot, as far as the snapshot records it.
 *
 * Deliberately partial. A snapshot keeps the scope, the limits and the
 * requested source types — enough to explain what was asked for and what
 * bounded it — but not the individual ids, because storing those would
 * double the size of every snapshot to restate what `items` and `omissions`
 * already say between them.
 */
export type SnapshotProvenance = {
  snapshotId: string;
  capturedAt: number;
  requestedSources: readonly AgentContextSourceType[];
  /** How many items of each source type survived. */
  includedBySource: Readonly<Partial<Record<AgentContextSourceType, number>>>;
  /** How many entities were dropped, and why. */
  omittedBySource: Readonly<Partial<Record<AgentContextSourceType, number>>>;
  reasons: readonly string[];
  characterCount: number;
  previousSnapshotId?: string;
};

/**
 * Everything needed to answer "why does this snapshot contain what it
 * contains".
 *
 * This is the auditability requirement satisfied as *data* rather than as a
 * screen: given a snapshot, a developer (or a future UI, or a test) can say
 * what was requested, what came back, what was cut and which rule cut it,
 * without having to re-run the resolution or read the resolver's source.
 */
export function describeSnapshot(snapshot: AgentContextSnapshot): SnapshotProvenance {
  const includedBySource: Partial<Record<AgentContextSourceType, number>> = {};
  for (const item of snapshot.items) {
    includedBySource[item.sourceType] = (includedBySource[item.sourceType] ?? 0) + 1;
  }

  const omittedBySource: Partial<Record<AgentContextSourceType, number>> = {};
  const reasons = new Set<string>();
  for (const omission of snapshot.omissions) {
    omittedBySource[omission.sourceType] =
      (omittedBySource[omission.sourceType] ?? 0) + omission.count;
    reasons.add(`${omission.sourceType}: ${omission.reason} (${omission.count})`);
  }

  const provenance: SnapshotProvenance = {
    snapshotId: snapshot.id,
    capturedAt: snapshot.capturedAt,
    requestedSources: snapshot.requestedSources,
    includedBySource,
    omittedBySource,
    reasons: [...reasons].sort(),
    characterCount: snapshot.characterCount,
  };

  if (snapshot.previousSnapshotId) provenance.previousSnapshotId = snapshot.previousSnapshotId;
  return provenance;
}

export type SnapshotDifference = {
  addedSourceIds: readonly string[];
  removedSourceIds: readonly string[];
  /**
   * Entities present in both, whose label changed.
   *
   * Reported separately from added/removed because "the tab is still there,
   * its title changed" and "the tab was deleted" are different facts, and a
   * caller deciding whether a refresh is worth sending needs to tell them
   * apart.
   */
  changedSourceIds: readonly string[];
};

/**
 * What changed between two snapshots.
 *
 * Exists so staleness can be *stated*. A snapshot that resolved at 10:00
 * makes a claim about 10:00, and this is how a caller establishes whether
 * that claim still holds without pretending the old one was live.
 */
export function diffSnapshots(
  before: AgentContextSnapshot,
  after: AgentContextSnapshot
): SnapshotDifference {
  const beforeById = new Map<string, AgentContextItem>(
    before.items.map((item) => [`${item.sourceType}:${item.sourceId}`, item])
  );
  const afterById = new Map<string, AgentContextItem>(
    after.items.map((item) => [`${item.sourceType}:${item.sourceId}`, item])
  );

  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, item] of afterById) {
    const previous = beforeById.get(key);
    if (!previous) added.push(item.sourceId);
    else if (previous.label !== item.label) changed.push(item.sourceId);
  }

  const removed: string[] = [];
  for (const [key, item] of beforeById) {
    if (!afterById.has(key)) removed.push(item.sourceId);
  }

  return {
    addedSourceIds: added.sort(),
    removedSourceIds: removed.sort(),
    changedSourceIds: changed.sort(),
  };
}
