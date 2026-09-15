import { recordArtifactWork } from "./artifacts";
import { appendRunEvent } from "./events";
import { createRun, findRunByExternalId, transitionRunStatus, updateRun } from "./runs";
import { agentFailure, isTerminalRunStatus, normalizeSummary } from "./types";
import type {
  AgentFailure,
  AgentRun,
  AgentRunArtifactRole,
  AgentRunStatus,
  AgentState,
} from "./types";

/**
 * The seam a provider integration plugs into.
 *
 * This interface is READ-ONLY on purpose, and the omissions are the design.
 * There is no `start`, `stop`, `kill`, `prompt`, `sendMessage`, `exec` or
 * `run` here, and none may be added: TabDump observes agents, it does not
 * drive them. An adapter that could control a coding agent would make this
 * app a remote-execution surface for anything that could reach its state,
 * which is a categorically different and much more dangerous product than
 * the one being built.
 *
 * Everything an adapter knows arrives as AgentAdapterObservation — a small,
 * already-sanitised record. The reduction from provider-specific data to that
 * record happens on the provider's side of this boundary, so the domain never
 * sees a transcript, a prompt, a tool result or a command.
 */

/**
 * One file an observation says a run worked on.
 *
 * `relativePath` is expected to already be project-relative; it is
 * nonetheless re-normalised during ingestion, because "the provider promised"
 * is not a boundary. A path that turns out to escape its project is dropped
 * rather than stored.
 */
export type AgentArtifactObservation = {
  /** The project root the path belongs to. */
  projectPath: string;
  /** Path within that project, forward-slashed. */
  relativePath: string;
  role: AgentRunArtifactRole;
  /** Provider-stable id of the record this came from, for event deduplication. */
  sourceId?: string;
};

/**
 * One thing an adapter noticed about one provider session.
 *
 * Every field beyond `provider` and `externalId` is optional because
 * observation is incremental: a poll that learns only "still working" says
 * only that, and must not be read as "and the title is now empty". See
 * ingestObservation, which treats absent fields as no news.
 */
export type AgentAdapterObservation = {
  /** Opaque provider key, matching the Agent this adapter speaks for. */
  provider: string;
  /** The provider's stable session identity. The domain matches on it, never parses it. */
  externalId: string;
  /**
   * The workspace this session belongs to, if the caller has an explicit
   * mapping for it.
   *
   * Absent means "discovered but unattached" — the session is real, but
   * nothing says which workspace owns it. ingestObservation will not guess:
   * an unattached observation creates no run. Attaching it later is a matter
   * of supplying this field on a subsequent observation.
   */
  workspaceId?: string;
  status?: AgentRunStatus;
  title?: string;
  /** A short, already-safe activity line. Never a command, a prompt or a tool result. */
  activity?: string;
  /**
   * An opaque key identifying the session's project, for the caller's own
   * workspace mapping.
   *
   * Explicitly NOT a filesystem path. A provider that knows an absolute path
   * should hash or otherwise key it before putting it here, so that local
   * directory layout does not travel with the observation.
   */
  projectKey?: string;
  /** Branch name, when the provider already knows it. Never obtained by running git. */
  gitBranch?: string;
  /** Stable id of the source record, so re-observing it does not duplicate history. */
  sourceId?: string;
  /**
   * Files this observation says the run worked on.
   *
   * Optional and plural: one tool invocation may legitimately touch several
   * files, and most touch none. Paths arrive already reduced to
   * project-relative form by the provider — an adapter that cannot express a
   * path that way omits it rather than sending an absolute one.
   *
   * Still only metadata. There is no field here for contents, a diff or a
   * size, and there is nowhere downstream that would accept one.
   */
  artifacts?: AgentArtifactObservation[];
  /**
   * A URL the session referenced.
   *
   * Left as a URL rather than a tab id because resolving one to an existing
   * tab needs the workspace's tabs, which this domain does not import. The
   * caller resolves it and calls addRunLink; an unmatched URL links nothing.
   */
  url?: string;
  /** When the observation happened, epoch ms. Falls back to the ingest clock if absent. */
  observedAt?: number;
};

export type AgentObserver = (observations: AgentAdapterObservation[]) => void;

export type AgentAdapterUnsubscribe = () => void;

/**
 * A provider integration.
 *
 * Two members, and there is no room for a third that acts on the agent.
 * `subscribe` hands observations to an observer and returns the function that
 * stops the flow; an adapter must clean up everything it started when that is
 * called.
 */
export interface AgentAdapter {
  readonly provider: string;
  subscribe(observer: AgentObserver): AgentAdapterUnsubscribe;
}

export type IngestObservationInput = {
  /** The Agent identity this observation belongs to — resolved by the caller from `provider`. */
  agentId: string;
  observation: AgentAdapterObservation;
  now: number;
};

/**
 * What ingesting an observation did.
 *
 * `unattached` is a success, not a failure: the session was seen, and
 * declining to invent a workspace for it is the correct outcome.
 */
export type IngestOutcome = "created" | "updated" | "unattached";

export type IngestObservationResult =
  | { ok: true; state: AgentState; run?: AgentRun; outcome: IngestOutcome }
  | AgentFailure;

/**
 * Folds one observation into the domain.
 *
 * The provider-agnostic half of what a later phase's poller does, kept here
 * so that every adapter gets the same identity, stickiness and terminal-state
 * behaviour rather than each reimplementing it:
 *
 *   - identity is (agentId, externalId), so observing the same session
 *     repeatedly updates one run instead of minting a new one;
 *   - absent fields are no news and never erase what is already known;
 *   - a terminal run stops taking status changes, but still accepts events,
 *     because its history is still being written even though its life is not;
 *   - an observation with no workspace creates nothing.
 */
export function ingestObservation(
  state: AgentState,
  input: IngestObservationInput
): IngestObservationResult {
  const { agentId, observation, now } = input;
  const externalId = observation.externalId.trim();
  if (!externalId) return agentFailure("invalid-input");

  const observedAt = Number.isFinite(observation.observedAt) ? observation.observedAt! : now;
  const existing = findRunByExternalId(state, agentId, externalId);

  if (!existing) {
    const workspaceId = observation.workspaceId?.trim();
    // Discovered, but nothing says where it belongs. Guessing here — from the
    // active workspace, a name match, or the nearest anything — is exactly
    // the inference that would file a stranger's work under the user's.
    if (!workspaceId) return { ok: true, state, outcome: "unattached" };

    const created = createRun(
      state,
      {
        agentId,
        workspaceId,
        externalId,
        title: observation.title,
        status: observation.status ?? "working",
      },
      now
    );
    if (!created.ok) return created;

    let next = created.state;
    const started = appendRunEvent(next, {
      runId: created.run.id,
      kind: "started",
      summary: observation.title?.trim() || "Session started",
      timestamp: observedAt,
    });
    if (started.ok) next = started.state;

    next = applyActivity(next, created.run.id, observation, observedAt, now);
    next = applyArtifacts(next, created.run.id, observation, now);
    return { ok: true, state: next, run: findRun(next, created.run.id), outcome: "created" };
  }

  let next = state;

  // Metadata first: a run that is about to end should still record the title
  // and activity the same observation carried.
  const patched = updateRun(
    next,
    existing.id,
    { title: observation.title, currentActivity: observation.activity },
    now
  );
  if (patched.ok) next = patched.state;

  if (observation.status && observation.status !== existing.status) {
    const moved = transitionRunStatus(next, existing.id, observation.status, now);
    // A refused transition is not an ingest failure — a finished run being
    // re-reported as working is a stale observation, not a corrupt one, and
    // the rest of the observation is still worth keeping.
    if (moved.ok) {
      next = moved.state;
      const ended = isTerminalRunStatus(observation.status);
      const noted = appendRunEvent(next, {
        runId: existing.id,
        kind: ended ? "ended" : "status",
        summary: ended ? `Run ${observation.status}` : `Now ${observation.status}`,
        timestamp: observedAt,
      });
      if (noted.ok) next = noted.state;
    }
  }

  next = applyActivity(next, existing.id, observation, observedAt, now);
  next = applyArtifacts(next, existing.id, observation, now);
  return { ok: true, state: next, run: findRun(next, existing.id), outcome: "updated" };
}

/**
 * Records the files an observation says the run worked on.
 *
 * Each entry is resolved into the run's own workspace and linked, through
 * `recordArtifactWork` — so the workspace boundary and the path check are
 * enforced by the domain rather than restated here.
 *
 * A rejected entry is skipped silently and individually. A path that escapes
 * its project, or names another root, is not an error worth failing an
 * otherwise good observation over: agents read files outside their projects
 * all the time, and those simply are not project work.
 */
function applyArtifacts(
  state: AgentState,
  runId: string,
  observation: AgentAdapterObservation,
  now: number
): AgentState {
  if (!observation.artifacts?.length) return state;

  let next = state;
  const seen = new Set<string>();

  for (const entry of observation.artifacts) {
    const projectPath = entry.projectPath?.trim();
    const relativePath = entry.relativePath?.trim();
    if (!projectPath || !relativePath) continue;

    // One tool call naming the same file twice costs one resolution, not two.
    const key = `${projectPath}::${relativePath}::${entry.role}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const recorded = recordArtifactWork(
      next,
      { runId, projectPath, path: relativePath, role: entry.role },
      now
    );
    if (recorded.ok) next = recorded.state;
  }

  return next;
}

/**
 * Records an activity line as an event, if the observation carried one.
 *
 * Separate from the status handling above because it runs on both the create
 * and update paths. `sourceId` is passed straight through, which is what
 * makes re-observing the same source record idempotent.
 */
function applyActivity(
  state: AgentState,
  runId: string,
  observation: AgentAdapterObservation,
  observedAt: number,
  now: number
): AgentState {
  const activity = observation.activity ? normalizeSummary(observation.activity) : "";
  if (!activity) return state;

  let next = state;
  const appended = appendRunEvent(next, {
    runId,
    kind: "activity",
    summary: activity,
    sourceId: observation.sourceId,
    timestamp: observedAt,
  });
  if (appended.ok) next = appended.state;

  const patched = updateRun(next, runId, { currentActivity: activity }, now);
  if (patched.ok) next = patched.state;

  return next;
}

/** Local re-lookup, so the result carries the run as it stands after every fold above. */
function findRun(state: AgentState, runId: string): AgentRun | undefined {
  return state.runs.find((run) => run.id === runId);
}
