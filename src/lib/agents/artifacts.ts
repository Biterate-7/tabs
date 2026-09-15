import { normalizeProjectPath, toProjectRelative } from "./paths";
import { findRun } from "./runs";
import { agentFailure } from "./types";
import type {
  AgentFailure,
  AgentRunArtifactLink,
  AgentRunArtifactRole,
  AgentState,
  WorkArtifact,
} from "./types";

/**
 * Work artifacts: the files an agent run worked on, and how.
 *
 * Pure reducers over AgentState with the clock injected, like every other
 * module here. Two invariants run through all of it:
 *
 *  - **identity is derived, never minted.** The same file observed on a
 *    hundred polls resolves to one artifact, because its id is a function of
 *    what it is rather than of when it was first seen.
 *  - **workspaces do not leak.** An artifact belongs to one workspace, a run
 *    belongs to one workspace, and a link between them requires those to be
 *    the same one.
 */

/**
 * Deterministic identity for a file within a project within a workspace.
 *
 * All three parts are load-bearing. `src/lib/foo.ts` is a different file in a
 * different project, and a workspace may contain several projects — so
 * neither the relative path nor the project alone identifies anything.
 *
 * The project is case-folded (see normalizeProjectPath) so that the same
 * directory spelled two ways is one project; the relative path keeps its case,
 * because it is also what gets displayed.
 */
export function workArtifactId(
  workspaceId: string,
  projectPath: string,
  relativePath: string
): string {
  return `wa-${workspaceId}::${normalizeProjectPath(projectPath)}::${relativePath}`;
}

export function findWorkArtifact(state: AgentState, artifactId: string): WorkArtifact | undefined {
  return state.artifacts.find((artifact) => artifact.id === artifactId);
}

/** Looks an artifact up by what it is, rather than by an id the caller would have to have kept. */
export function findArtifactByIdentity(
  state: AgentState,
  workspaceId: string,
  projectPath: string,
  relativePath: string
): WorkArtifact | undefined {
  return findWorkArtifact(state, workArtifactId(workspaceId, projectPath, relativePath));
}

export type ResolveArtifactInput = {
  workspaceId: string;
  projectPath: string;
  /**
   * A path to place inside the project. May be absolute or already relative;
   * it is normalised here, and refused if it does not belong.
   */
  path: string;
};

export type ResolveArtifactResult =
  | { ok: true; state: AgentState; artifact: WorkArtifact; created: boolean }
  | AgentFailure;

/**
 * Finds or creates the artifact for a file.
 *
 * The normalisation is the security boundary as much as the tidiness one: a
 * path that escapes the project root, names another root, or takes a form
 * that cannot be resolved is refused with `invalid-path` rather than stored.
 * Nothing downstream ever sees an artifact for a file outside its project.
 *
 * Re-resolving an existing artifact bumps `updatedAt` — "last worked on" is
 * the useful thing to know about a file — but leaves identity and `createdAt`
 * alone.
 */
export function resolveWorkArtifact(
  state: AgentState,
  input: ResolveArtifactInput,
  now: number
): ResolveArtifactResult {
  const workspaceId = input.workspaceId.trim();
  const projectPath = input.projectPath.trim();
  if (!workspaceId || !projectPath) return agentFailure("invalid-input");

  const relative = toProjectRelative(projectPath, input.path);
  if (!relative.ok) return agentFailure("invalid-path");

  const id = workArtifactId(workspaceId, projectPath, relative.relativePath);
  const existing = findWorkArtifact(state, id);

  if (existing) {
    if (existing.updatedAt === now) return { ok: true, state, artifact: existing, created: false };
    const touched: WorkArtifact = { ...existing, updatedAt: now };
    return {
      ok: true,
      state: {
        ...state,
        artifacts: state.artifacts.map((artifact) => (artifact.id === id ? touched : artifact)),
      },
      artifact: touched,
      created: false,
    };
  }

  const artifact: WorkArtifact = {
    id,
    workspaceId,
    projectPath,
    relativePath: relative.relativePath,
    kind: "file",
    createdAt: now,
    updatedAt: now,
  };

  return {
    ok: true,
    state: { ...state, artifacts: [...state.artifacts, artifact] },
    artifact,
    created: true,
  };
}

/**
 * Deterministic, from the relationship itself — the same approach
 * agentRunLinkId takes, and for the same reason: observing the same
 * interaction again must not mint a second row.
 *
 * Role is part of the identity, so one run may have both `inspected` and
 * `edited` on one file. That is a real sequence (it read the file, then
 * changed it), not a duplicate.
 */
export function agentRunArtifactLinkId(
  runId: string,
  artifactId: string,
  role: AgentRunArtifactRole
): string {
  return `ara-${runId}::${artifactId}::${role}`;
}

export type LinkArtifactInput = {
  runId: string;
  artifactId: string;
  role: AgentRunArtifactRole;
};

export type LinkArtifactResult =
  | { ok: true; state: AgentState; link: AgentRunArtifactLink; created: boolean }
  | AgentFailure;

/**
 * Records that a run interacted with an artifact.
 *
 * Both ends must exist, and both must live in the same workspace. The
 * workspace check is the reason this cannot be a simple array push: a run in
 * one workspace linking a file in another would quietly punch through the
 * boundary that keeps unrelated work apart.
 *
 * Idempotent — re-linking returns `created: false` and untouched state.
 */
export function linkRunArtifact(
  state: AgentState,
  input: LinkArtifactInput,
  now: number
): LinkArtifactResult {
  const run = findRun(state, input.runId);
  if (!run) return agentFailure("run-not-found");

  const artifact = findWorkArtifact(state, input.artifactId);
  if (!artifact) return agentFailure("artifact-not-found");
  if (artifact.workspaceId !== run.workspaceId) return agentFailure("cross-workspace");

  const id = agentRunArtifactLinkId(run.id, artifact.id, input.role);
  const existing = state.artifactLinks.find((link) => link.id === id);
  if (existing) return { ok: true, state, link: existing, created: false };

  const link: AgentRunArtifactLink = {
    id,
    runId: run.id,
    artifactId: artifact.id,
    role: input.role,
    createdAt: now,
  };

  return {
    ok: true,
    state: { ...state, artifactLinks: [...state.artifactLinks, link] },
    link,
    created: true,
  };
}

export type RecordArtifactWorkInput = {
  runId: string;
  projectPath: string;
  path: string;
  role: AgentRunArtifactRole;
};

export type RecordArtifactWorkResult =
  | {
      ok: true;
      state: AgentState;
      artifact: WorkArtifact;
      link: AgentRunArtifactLink;
      created: boolean;
    }
  | AgentFailure;

/**
 * The whole "a run worked on a file" operation, in one call.
 *
 * Resolves the artifact into the *run's own* workspace — taken from the run
 * rather than supplied by the caller, so there is no argument that could ask
 * for a cross-workspace artifact in the first place — then links it.
 *
 * This is what provider ingestion calls; the two steps above remain separate
 * for callers that already hold an artifact.
 */
export function recordArtifactWork(
  state: AgentState,
  input: RecordArtifactWorkInput,
  now: number
): RecordArtifactWorkResult {
  const run = findRun(state, input.runId);
  if (!run) return agentFailure("run-not-found");

  const resolved = resolveWorkArtifact(
    state,
    { workspaceId: run.workspaceId, projectPath: input.projectPath, path: input.path },
    now
  );
  if (!resolved.ok) return resolved;

  const linked = linkRunArtifact(
    resolved.state,
    { runId: run.id, artifactId: resolved.artifact.id, role: input.role },
    now
  );
  if (!linked.ok) return linked;

  return {
    ok: true,
    state: linked.state,
    artifact: resolved.artifact,
    link: linked.link,
    created: resolved.created || linked.created,
  };
}

/** Drops every artifact link belonging to a run, leaving the artifacts themselves in place. */
export function removeArtifactLinksForRun(state: AgentState, runId: string): AgentState {
  const kept = state.artifactLinks.filter((link) => link.runId !== runId);
  return kept.length === state.artifactLinks.length ? state : { ...state, artifactLinks: kept };
}

/**
 * Removes artifacts that no run refers to any more.
 *
 * Artifacts are durable in a way events are not — they record what a project
 * contains that has been worked on, so they are deliberately NOT capped or
 * aged out. The one thing that would grow without bound is an artifact whose
 * every run has been deleted, which nothing can reach and nothing can
 * display; those are collected here.
 *
 * Explicit rather than automatic on every write: pruning is a decision about
 * data the user may still care about, and it belongs at a call site that
 * means it (deleteRun, and the store's hydration path).
 */
export function pruneOrphanedArtifacts(state: AgentState): AgentState {
  const referenced = new Set(state.artifactLinks.map((link) => link.artifactId));
  const kept = state.artifacts.filter((artifact) => referenced.has(artifact.id));
  return kept.length === state.artifacts.length ? state : { ...state, artifacts: kept };
}
