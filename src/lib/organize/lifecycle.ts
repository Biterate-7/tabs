/**
 * The dump → organize → layout → settle lifecycle, as one explicit state
 * machine.
 *
 * It exists because "the graph is available" and "organization is still
 * happening" used to be able to be true at the same time: a dump kicked off
 * `organizeNewTabsIntoSections` as fire-and-forget work (app-shell.tsx) and
 * nothing anywhere connected that promise to the Graph View's entry points,
 * so a user who clicked Graph while the pipeline's slow tail — Stage F, the
 * leftover "Other" tabs — was still running got an intermediate graph that
 * then restructured itself underneath them.
 *
 * Everything here is pure: no timers, no React, no clocks. Completion is
 * therefore never approximated by a delay — each transition is called by the
 * thing that actually finished (see app-shell.tsx), and every transition is
 * guarded by `generation`, so a slow first dump resolving after a second
 * dump has started can never mark the second one ready.
 */

/**
 * The real internal steps a dump passes through, in order. Each one is
 * reported by the code that actually enters it — pipeline.ts calls back for
 * the three organization stages (see `OrganizeProgress`), app-shell.tsx
 * drives the two layout stages. Nothing here is a guess or a fraction of a
 * timer, which is why there is no percentage anywhere in this module.
 */
export type OrganizationStage =
  | "receiving"
  | "classifying"
  | "grouping"
  /** Stage F of the pipeline: the leftover, mostly "Other"-category tabs. Reliably the slowest stage, and the one that used to finish after the graph had already been opened. */
  | "other"
  | "arranging"
  | "settling";

export type OrganizationStatus = "idle" | "organizing" | "settling" | "ready" | "error";

export type OrganizationState = {
  status: OrganizationStatus;
  /**
   * Monotonic id of the dump this state describes. Every transition below
   * takes the generation it belongs to and is ignored unless it matches, so
   * a stale callback from a superseded dump cannot move the current one.
   */
  generation: number;
  /** Null exactly when no work is in flight (idle / ready / error). */
  stage: OrganizationStage | null;
  /** How many tabs this dump is organizing — shown in the preparation UI, never used to estimate progress. */
  tabCount: number;
  /** Set only in the `error` status. */
  message: string | null;
};

export function idleOrganizationState(): OrganizationState {
  return { status: "idle", generation: 0, stage: null, tabCount: 0, message: null };
}

/**
 * The state a freshly started dump is in. Takes its generation rather than
 * deriving one, so a caller that mints generations itself (the React hook
 * needs the id synchronously, before any state update has been applied) and
 * the pure `beginOrganization` below can never disagree about which run is
 * current.
 */
export function startOrganization(generation: number, tabCount: number): OrganizationState {
  return { status: "organizing", generation, stage: "receiving", tabCount, message: null };
}

/** Opens a new generation. The only transition that does not require a matching generation — it defines one. */
export function beginOrganization(state: OrganizationState, tabCount: number): OrganizationState {
  return startOrganization(state.generation + 1, tabCount);
}

/** True when `generation` still describes the run `state` is tracking AND that run is still live — a run that already reached ready/error accepts no further transitions. */
function isCurrentRun(state: OrganizationState, generation: number): boolean {
  if (state.generation !== generation) return false;
  return state.status === "organizing" || state.status === "settling";
}

/** Reports entry into one of the organization stages (pipeline-driven). */
export function advanceOrganization(
  state: OrganizationState,
  generation: number,
  stage: OrganizationStage
): OrganizationState {
  if (!isCurrentRun(state, generation)) return state;
  return { ...state, status: "organizing", stage };
}

/**
 * Data organization is done; the layout/physics half begins. Split out from
 * `advanceOrganization` because it is the point where the *status* changes,
 * not just the label: from here on nothing structural is left to happen, only
 * positioning — and the graph still must not open (requirement: settling is
 * part of readiness, not something the user watches).
 */
export function beginSettling(
  state: OrganizationState,
  generation: number,
  stage: Extract<OrganizationStage, "arranging" | "settling"> = "arranging"
): OrganizationState {
  if (!isCurrentRun(state, generation)) return state;
  return { ...state, status: "settling", stage };
}

/** The whole pipeline finished: tabs classified, "Other" placed, layout computed, physics settled. Only this unlocks the graph. */
export function completeOrganization(state: OrganizationState, generation: number): OrganizationState {
  if (!isCurrentRun(state, generation)) return state;
  return { ...state, status: "ready", stage: null, message: null };
}

export function failOrganization(
  state: OrganizationState,
  generation: number,
  message: string
): OrganizationState {
  if (!isCurrentRun(state, generation)) return state;
  return { ...state, status: "error", stage: null, message };
}

/**
 * Clears a failed run back to idle — the recovery path behind the error
 * panel's "Open graph anyway". Deliberately goes to `idle` (no dump in
 * flight) rather than to `ready` (a dump that completed): nothing was
 * verified, so the graph becomes accessible the same way it is for a
 * workspace with no active dump at all, never labelled as a finished one.
 */
export function dismissOrganizationError(state: OrganizationState): OrganizationState {
  if (state.status !== "error") return state;
  return { ...state, status: "idle", stage: null, message: null };
}

/**
 * The single predicate every Graph View entry point is gated on.
 *
 * `idle` — nothing has been dumped this session, so whatever is already in
 * the workspace is as coherent as it will get; `ready` — a dump ran and
 * completed all the way through physics settling. Everything else means work
 * is in flight (or failed), and the graph stays shut.
 */
export function isGraphAvailable(state: OrganizationState): boolean {
  return state.status === "idle" || state.status === "ready";
}

/** Human-readable label for the preparation UI. Stage names only — no invented percentages, and no stage that isn't a real internal state. */
export function describeOrganizationStage(state: OrganizationState): string {
  if (state.status === "error") return state.message ?? "Couldn't finish organizing your tabs.";
  if (state.status === "ready") return "Ready";
  if (state.status === "idle") return "Ready";

  const count = state.tabCount;
  const plural = count === 1 ? "tab" : "tabs";
  switch (state.stage) {
    case "receiving":
      return `Receiving ${count} ${plural}…`;
    case "classifying":
      return `Organizing ${count} ${plural}…`;
    case "grouping":
      return "Building groups…";
    case "other":
      return 'Organizing "Other" tabs…';
    case "arranging":
      return "Arranging tabs…";
    case "settling":
      return "Finalizing layout…";
    default:
      return `Organizing ${count} ${plural}…`;
  }
}
