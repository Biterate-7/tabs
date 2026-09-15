import { scopedKey } from "@/lib/storage/namespace";
import { isValidTimestamp } from "@/lib/timestamps";
import { workArtifactId } from "./artifacts";
import { toProjectRelative } from "./paths";
import {
  AGENT_STATE_VERSION,
  MAX_EVENTS_PER_RUN,
  emptyAgentState,
  isAgentEventKind,
  isAgentRunArtifactRole,
  isAgentRunLinkRole,
  isAgentRunStatus,
  isTerminalRunStatus,
  isWorkArtifactKind,
  normalizeSummary,
} from "./types";
import type {
  Agent,
  AgentEvent,
  AgentRun,
  AgentRunArtifactLink,
  AgentRunLink,
  AgentState,
  WorkArtifact,
} from "./types";

/**
 * Local, account-scoped persistence for the agent domain.
 *
 * Local only, by design for this phase: no server, no sync, no Postgres. The
 * base key below is the literal key when signed out and gets an account
 * prefix when signed in — see src/lib/storage/namespace.ts, which is also
 * where this key is registered so that signing in carries anonymous agent
 * state into the account alongside workspaces and collections.
 *
 * Loading never throws. Corrupt, truncated or hand-edited state degrades to
 * an empty domain rather than taking the app down, on the same principle as
 * loadDependencyState.
 */

const STORAGE_KEY = "tabdump:agents:v1";

function sanitizeAgents(value: unknown): Agent[] {
  if (!Array.isArray(value)) return [];
  const out: Agent[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, provider, name, createdAt, updatedAt } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (typeof provider !== "string" || !provider) continue;
    if (typeof name !== "string" || !name) continue;
    if (!isValidTimestamp(createdAt)) continue;

    seen.add(id);
    out.push({
      id,
      provider,
      name,
      createdAt,
      // An agent written before it was ever updated, or by a build that
      // omitted the field, is not "changed at epoch zero" — it is unchanged
      // since creation, which is what createdAt already says.
      updatedAt: isValidTimestamp(updatedAt) ? updatedAt : createdAt,
    });
  }

  return out;
}

function sanitizeRuns(value: unknown, agentIds: Set<string>): AgentRun[] {
  if (!Array.isArray(value)) return [];
  const out: AgentRun[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const { id, agentId, workspaceId, status, createdAt, updatedAt, endedAt } = raw;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    // A run whose agent is gone cannot be rendered, attributed or deleted
    // through any normal path, so it is dropped rather than kept as a ghost.
    if (typeof agentId !== "string" || !agentIds.has(agentId)) continue;
    if (typeof workspaceId !== "string" || !workspaceId) continue;
    if (!isAgentRunStatus(status)) continue;
    if (!isValidTimestamp(createdAt)) continue;

    seen.add(id);
    const run: AgentRun = {
      id,
      agentId,
      workspaceId,
      status,
      createdAt,
      updatedAt: isValidTimestamp(updatedAt) ? updatedAt : createdAt,
    };

    if (typeof raw.externalId === "string" && raw.externalId) run.externalId = raw.externalId;
    if (typeof raw.title === "string" && raw.title) run.title = raw.title;
    if (typeof raw.currentActivity === "string" && raw.currentActivity) {
      run.currentActivity = normalizeSummary(raw.currentActivity);
    }

    // endedAt and terminality are two spellings of the same fact, so they are
    // reconciled rather than trusted independently: a terminal run always has
    // a timestamp, and a live one never does.
    if (isTerminalRunStatus(status)) {
      run.endedAt = isValidTimestamp(endedAt) ? endedAt : run.updatedAt;
    }

    out.push(run);
  }

  return out;
}

function sanitizeLinks(value: unknown, runsById: Map<string, AgentRun>): AgentRunLink[] {
  if (!Array.isArray(value)) return [];
  const out: AgentRunLink[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, runId, tabId, role, createdAt } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (typeof runId !== "string" || !runsById.has(runId)) continue;
    if (typeof tabId !== "string" || !tabId) continue;
    if (!isAgentRunLinkRole(role)) continue;
    if (!isValidTimestamp(createdAt)) continue;

    seen.add(id);
    out.push({ id, runId, tabId, role, createdAt });
  }

  return out;
}

function sanitizeEvents(value: unknown, runIds: Set<string>): AgentEvent[] {
  if (!Array.isArray(value)) return [];
  const out: AgentEvent[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, runId, timestamp, kind, summary, sourceId } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (typeof runId !== "string" || !runIds.has(runId)) continue;
    if (!isValidTimestamp(timestamp)) continue;
    if (!isAgentEventKind(kind)) continue;
    if (typeof summary !== "string") continue;

    const normalized = normalizeSummary(summary);
    if (!normalized) continue;

    seen.add(id);
    const event: AgentEvent = { id, runId, timestamp, kind, summary: normalized };
    if (typeof sourceId === "string" && sourceId) event.sourceId = sourceId;
    out.push(event);
  }

  return capEventsPerRun(out);
}

/**
 * Re-applies the per-run event cap to state read from storage.
 *
 * The write path already caps, so this only ever matters for state this build
 * did not write — an older build with a different limit, a restored backup, a
 * hand-edited file. Without it, a single oversized array read once would keep
 * being written back out at full length.
 */
/**
 * Artifacts, validated against the workspaces their runs actually use.
 *
 * An artifact whose id does not match its own contents is dropped: identity
 * here is derived (see workArtifactId), so a mismatch means the record was
 * hand-edited or written by something that did not understand the scheme, and
 * trusting it would put a file in a project it does not belong to.
 */
function sanitizeArtifacts(value: unknown): WorkArtifact[] {
  if (!Array.isArray(value)) return [];
  const out: WorkArtifact[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, workspaceId, projectPath, relativePath, kind, createdAt, updatedAt } =
      entry as Record<string, unknown>;

    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (typeof workspaceId !== "string" || !workspaceId) continue;
    if (typeof projectPath !== "string" || !projectPath) continue;
    if (typeof relativePath !== "string" || !relativePath) continue;
    if (!isWorkArtifactKind(kind)) continue;
    if (!isValidTimestamp(createdAt)) continue;

    // A stored relative path must still be relative and still be inside its
    // project — the check that was made when it was written, re-made on the
    // way back in, because storage is not a trust boundary.
    const relative = toProjectRelative(projectPath, relativePath);
    if (!relative.ok || relative.relativePath !== relativePath) continue;
    if (workArtifactId(workspaceId, projectPath, relativePath) !== id) continue;

    seen.add(id);
    out.push({
      id,
      workspaceId,
      projectPath,
      relativePath,
      kind,
      createdAt,
      updatedAt: isValidTimestamp(updatedAt) ? updatedAt : createdAt,
    });
  }

  return out;
}

function sanitizeArtifactLinks(
  value: unknown,
  runsById: Map<string, AgentRun>,
  artifactsById: Map<string, WorkArtifact>
): AgentRunArtifactLink[] {
  if (!Array.isArray(value)) return [];
  const out: AgentRunArtifactLink[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, runId, artifactId, role, createdAt } = entry as Record<string, unknown>;

    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (typeof runId !== "string" || typeof artifactId !== "string") continue;
    if (!isAgentRunArtifactRole(role)) continue;
    if (!isValidTimestamp(createdAt)) continue;

    const run = runsById.get(runId);
    const artifact = artifactsById.get(artifactId);
    if (!run || !artifact) continue;
    // The workspace invariant, re-enforced on read. A link that crosses one
    // could only have got there by editing the file.
    if (run.workspaceId !== artifact.workspaceId) continue;

    seen.add(id);
    out.push({ id, runId, artifactId, role, createdAt });
  }

  return out;
}

function capEventsPerRun(events: AgentEvent[]): AgentEvent[] {
  const byRun = new Map<string, AgentEvent[]>();
  for (const event of events) {
    const bucket = byRun.get(event.runId);
    if (bucket) bucket.push(event);
    else byRun.set(event.runId, [event]);
  }

  const doomed = new Set<string>();
  for (const bucket of byRun.values()) {
    if (bucket.length <= MAX_EVENTS_PER_RUN) continue;
    bucket
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, bucket.length - MAX_EVENTS_PER_RUN)
      .forEach((event) => doomed.add(event.id));
  }

  return doomed.size === 0 ? events : events.filter((event) => !doomed.has(event.id));
}

export function defaultAgentState(): AgentState {
  return emptyAgentState();
}

/**
 * How a load turned out.
 *
 * `unsupported` is the interesting case: state written by a *newer* build
 * than this one. The state cannot be trusted to have the shape this build
 * expects, so an empty domain is handed back — but the caller is told, so it
 * can decline to save over data it does not understand. A newer TabDump in
 * another tab, or a downgrade, must not cost the user their agent history
 * simply because an older build opened the key once.
 */
export type AgentStateLoad = {
  status: "empty" | "loaded" | "unsupported";
  state: AgentState;
};

/** Never throws — unreadable agent state degrades to an empty domain rather than blocking the app. */
export function loadAgentState(): AgentStateLoad {
  try {
    const raw = window.localStorage.getItem(scopedKey(STORAGE_KEY));
    if (!raw) return { status: "empty", state: defaultAgentState() };

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { status: "empty", state: defaultAgentState() };
    }

    const record = parsed as Record<string, unknown>;
    if (record.version !== AGENT_STATE_VERSION) {
      const knownFuture =
        typeof record.version === "number" && record.version > AGENT_STATE_VERSION;
      return {
        status: knownFuture ? "unsupported" : "empty",
        state: defaultAgentState(),
      };
    }

    // Order matters: each layer is validated against the one above it, so a
    // dangling reference is dropped rather than persisted back out.
    const agents = sanitizeAgents(record.agents);
    const runs = sanitizeRuns(record.runs, new Set(agents.map((a) => a.id)));
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const links = sanitizeLinks(record.links, runsById);
    const events = sanitizeEvents(record.events, new Set(runsById.keys()));

    // Absent in state written before artifacts existed, which is why these
    // sanitize to empty rather than failing the load: the upgrade is additive
    // and must not cost anyone their agent history.
    const artifacts = sanitizeArtifacts(record.artifacts);
    const artifactLinks = sanitizeArtifactLinks(
      record.artifactLinks,
      runsById,
      new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    );

    return {
      status: "loaded",
      state: { version: AGENT_STATE_VERSION, agents, runs, links, events, artifacts, artifactLinks },
    };
  } catch {
    return { status: "empty", state: defaultAgentState() };
  }
}

export function saveAgentState(state: AgentState): boolean {
  try {
    window.localStorage.setItem(scopedKey(STORAGE_KEY), JSON.stringify(state));
    return true;
  } catch {
    // Quota, or storage disabled mid-session. Reported rather than thrown, so
    // a failed save degrades to "this session is not persisted" instead of
    // breaking the mutation that triggered it.
    return false;
  }
}

/** Exported for tests and for callers that need to reason about the raw key. */
export const AGENT_STORAGE_KEY = STORAGE_KEY;
