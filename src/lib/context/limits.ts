/**
 * How much of a person's Hubble one context resolution may describe.
 *
 * ## Why limits live in their own module
 *
 * Every one of these numbers is a security control, not a performance
 * tuning knob. An unbounded context resolution is a way to ship a person's
 * entire saved history to an AI provider by accident, and "the UI only ever
 * asks for one workspace" is a convention, not a boundary. Putting the caps
 * here — read by the resolver, recorded on every snapshot, and impossible to
 * omit because the type has no optional members — is what makes the bound
 * structural.
 *
 * ## Why the defaults are small
 *
 * They are sized for *usefulness*, not for completeness. An AI given 100
 * pages has plenty to reason about; one given 4,000 has a payload it
 * cannot use, costed at the user's expense, containing four thousand
 * opportunities for something private to be in the list. A caller that
 * genuinely needs more raises a specific limit and says so in the request,
 * which is then recorded on the snapshot and visible afterwards.
 *
 * There is deliberately no `unlimited`, no `Infinity` and no zero-means-all:
 * `clampLimits` forces every value into a closed range, so a limit that
 * arrives as `0`, `-1`, `NaN` or `Number.MAX_SAFE_INTEGER` becomes a real
 * number rather than a hole.
 */

export type ContextLimits = {
  /** Total context items of every kind, across the whole snapshot. */
  maxItems: number;
  maxWorkspaces: number;
  maxTabs: number;
  maxCollections: number;
  /** Members listed inside one collection item. */
  maxCollectionMembers: number;
  maxRelationships: number;
  maxGraphNodes: number;
  maxGraphEdges: number;
  /** Hops from a graph centre. See `resolveGraph` on why this is not `GraphDepth`. */
  maxGraphDepth: number;
  /** Total characters across every string the snapshot carries. */
  maxCharacters: number;
};

/**
 * The conservative defaults.
 *
 * Small on purpose: an answer is read by an AI client, and a bounded answer
 * that says it was cut is more useful than an unbounded one.
 */
export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxItems: 200,
  maxWorkspaces: 5,
  maxTabs: 100,
  maxCollections: 25,
  maxCollectionMembers: 100,
  maxRelationships: 100,
  maxGraphNodes: 50,
  maxGraphEdges: 100,
  maxGraphDepth: 2,
  maxCharacters: 20_000,
};

/**
 * The ceiling a caller may raise a limit to.
 *
 * A request supplies its own limits, and a request is not trusted — it can
 * come from a caller that read a number out of persisted UI state. These are
 * the numbers past which "the user asked for a big context" stops being a
 * plausible explanation.
 */
export const MAX_CONTEXT_LIMITS: ContextLimits = {
  maxItems: 500,
  maxWorkspaces: 20,
  maxTabs: 400,
  maxCollections: 100,
  maxCollectionMembers: 400,
  maxRelationships: 400,
  maxGraphNodes: 200,
  maxGraphEdges: 400,
  /**
   * Three, and not higher, because `GraphDepth` in `lib/graph/types.ts` tops
   * out at 3 before it becomes `"infinite"` — and `"infinite"` is exactly
   * what a context bound must never become. Raising this past the canonical
   * type's ceiling would mean either a second traversal implementation or a
   * silent downgrade, and both are worse than the honest cap.
   */
  maxGraphDepth: 3,
  maxCharacters: 120_000,
};

const LIMIT_KEYS = Object.keys(DEFAULT_CONTEXT_LIMITS) as (keyof ContextLimits)[];

function clampOne(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  // Zero is a legitimate answer — "include no tabs" — but a negative one is
  // not, and neither is anything above the ceiling.
  if (floored < 0) return 0;
  return Math.min(floored, ceiling);
}

/**
 * Turns a partial, untrusted limit override into a complete, in-range set.
 *
 * Every field is produced here, so a resolver never reads an optional limit
 * and never has to decide what an absent one means.
 */
export function clampLimits(overrides?: Partial<ContextLimits>): ContextLimits {
  const result = {} as ContextLimits;
  for (const key of LIMIT_KEYS) {
    result[key] = clampOne(overrides?.[key], DEFAULT_CONTEXT_LIMITS[key], MAX_CONTEXT_LIMITS[key]);
  }
  return result;
}
