import { isLocalEffectCapability } from "./capabilities";
import type { AgentCapability } from "./capabilities";

/**
 * What an agent is allowed to do, and where.
 *
 * ## The one rule
 *
 * **Nothing is granted by default.** Every function in this module answers
 * "was this explicitly allowed", never "was this explicitly forbidden". A
 * missing grant, an unknown scope, an absent project, a malformed record —
 * all deny. There is no code path here that returns `true` because it ran out
 * of reasons to say no, and `permissions.test.ts` enumerates the denial cases
 * precisely because a permission check that fails open is indistinguishable
 * from one that works until the day it matters.
 */

/**
 * The closed set of permission scopes.
 *
 * Deliberately coarse. A finer model ("write only these globs") reads as more
 * secure and is less so in practice: it produces a dialog nobody can evaluate,
 * and the user clicks yes. Six scopes are few enough that a person can hold
 * the whole grant in their head when they authorize it.
 */
export type AgentPermissionScope =
  /** Read Hubble workspace content — tabs, collections, relationships, notes. */
  | "read_workspace"
  /** Read files inside one authorized project. */
  | "read_project"
  /** Create, modify or delete files inside one authorized project. */
  | "write_project"
  /** Execute commands inside one authorized project. */
  | "run_commands"
  /** Reach the network from inside a run. */
  | "network_access"
  /** Use MCP-connected tools. */
  | "mcp_tools"
  /**
   * Change Hubble workspace content — create a collection, for now (Phase
   * J.3). Scoped to the one workspace a session was started from, and every
   * single use asks. Reading never implies it.
   */
  | "write_workspace";

export const AGENT_PERMISSION_SCOPES: readonly AgentPermissionScope[] = [
  "read_workspace",
  "read_project",
  "write_project",
  "run_commands",
  "network_access",
  "mcp_tools",
  "write_workspace",
] as const;

export function isAgentPermissionScope(value: unknown): value is AgentPermissionScope {
  return (
    typeof value === "string" && (AGENT_PERMISSION_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Scopes that are meaningless without a project to be scoped *to*.
 *
 * A grant of `write_project` that names no project is not a broad grant — it
 * is an invalid one, and `isGranted` rejects it. This is the structural reason
 * an agent cannot end up authorized against the whole filesystem by omission.
 */
export const PROJECT_SCOPED_PERMISSIONS: readonly AgentPermissionScope[] = [
  "read_project",
  "write_project",
  "run_commands",
] as const;

export function isProjectScoped(scope: AgentPermissionScope): boolean {
  return (PROJECT_SCOPED_PERMISSIONS as readonly string[]).includes(scope);
}

/**
 * Scopes that always require an explicit approval at the moment of use, even
 * when the scope itself has been granted.
 *
 * The grant says "this agent may write in this project at all". The approval
 * says "this agent may write *these four files* right now". Both are required
 * for a write, and that is the difference between authorizing a tool and
 * authorizing an action.
 */
export const APPROVAL_REQUIRED_PERMISSIONS: readonly AgentPermissionScope[] = [
  "write_project",
  "run_commands",
  "write_workspace",
] as const;

export function requiresApproval(scope: AgentPermissionScope): boolean {
  return (APPROVAL_REQUIRED_PERMISSIONS as readonly string[]).includes(scope);
}

/** Human labels. Phrased as what the agent gains, because that is what is being authorized. */
export const PERMISSION_LABELS: Record<AgentPermissionScope, string> = {
  read_workspace: "Read workspace content",
  read_project: "Read project files",
  write_project: "Modify project files",
  run_commands: "Run commands",
  network_access: "Access the network",
  mcp_tools: "Use MCP tools",
  write_workspace: "Change workspace content",
};

/**
 * A set of granted scopes.
 *
 * A grant is always attached to something — a project, or a session — and is
 * never global. There is deliberately no "grant everything" constructor.
 */
export type AgentPermissionGrant = {
  /** The scopes explicitly allowed. Anything absent is denied. */
  scopes: readonly AgentPermissionScope[];
  /**
   * The project these scopes apply within.
   *
   * Required whenever any granted scope is project-scoped. A grant that
   * includes `write_project` with no `projectId` is invalid and denies
   * everything, rather than applying broadly.
   */
  projectId?: string;
  grantedAt: number;
};

export const NO_PERMISSIONS: AgentPermissionGrant = { scopes: [], grantedAt: 0 };

/**
 * Whether a grant is internally coherent.
 *
 * Checked before it is consulted rather than trusted, because a grant can
 * come back from persistence, where it may have been written by an older
 * build or edited by hand in devtools.
 */
export function isValidGrant(grant: AgentPermissionGrant): boolean {
  if (!Array.isArray(grant.scopes)) return false;
  if (!grant.scopes.every(isAgentPermissionScope)) return false;
  if (new Set(grant.scopes).size !== grant.scopes.length) return false;
  if (!Number.isFinite(grant.grantedAt)) return false;

  const needsProject = grant.scopes.some(isProjectScoped);
  if (needsProject && !grant.projectId) return false;

  return true;
}

/**
 * Whether `scope` is allowed by `grant`, within `projectId`.
 *
 * Every argument is required to be right, and any doubt denies:
 *
 *   - an invalid grant denies everything;
 *   - a project-scoped request against a different project denies;
 *   - a project-scoped request with no project named denies;
 *   - a scope not in the list denies.
 */
export function isGranted(
  grant: AgentPermissionGrant,
  scope: AgentPermissionScope,
  projectId?: string
): boolean {
  if (!isAgentPermissionScope(scope)) return false;
  if (!isValidGrant(grant)) return false;
  if (!grant.scopes.includes(scope)) return false;

  if (isProjectScoped(scope)) {
    if (!projectId) return false;
    if (grant.projectId !== projectId) return false;
  }

  return true;
}

/**
 * The scope a capability needs before it may be exercised, or `null` when it
 * needs none.
 *
 * This is the join between "what the provider can do" and "what the user
 * allowed". A capability with no scope requirement is one whose use cannot
 * touch the user's machine or content — starting a session, cancelling a run,
 * streaming events.
 */
export function requiredScopeFor(capability: AgentCapability): AgentPermissionScope | null {
  switch (capability) {
    case "read_files":
      return "read_project";
    case "write_files":
      return "write_project";
    case "run_commands":
      return "run_commands";
    case "mcp":
      return "mcp_tools";
    case "observe":
    case "message":
    case "create_session":
    case "resume_session":
    case "cancel_run":
    case "stream_events":
    case "approvals":
    case "working_directory":
    case "additional_directories":
    // What a session may do with its workspace is derived from the grant by
    // the runtime when it binds the context (read_workspace, write_workspace),
    // and every write asks. Carrying the server needs no scope of its own.
    case "workspace_context":
      return null;
  }
}

/**
 * Whether a capability may be exercised under a grant.
 *
 * The belt-and-braces check the service calls before dispatching anything to
 * an adapter. A capability whose effects are local (see
 * `LOCAL_EFFECT_CAPABILITIES`) additionally requires a project, so a local
 * effect can never be authorized "in general".
 */
export function isCapabilityPermitted(
  capability: AgentCapability,
  grant: AgentPermissionGrant,
  projectId?: string
): boolean {
  const scope = requiredScopeFor(capability);
  if (scope === null) return true;

  if (isLocalEffectCapability(capability) && !projectId) return false;

  return isGranted(grant, scope, projectId);
}

/** Builds a grant. Rejects an incoherent one by returning `null` rather than a grant that denies silently. */
export function createGrant(
  scopes: readonly AgentPermissionScope[],
  now: number,
  projectId?: string
): AgentPermissionGrant | null {
  const unique = [...new Set(scopes)];
  const grant: AgentPermissionGrant = projectId
    ? { scopes: unique, projectId, grantedAt: now }
    : { scopes: unique, grantedAt: now };

  return isValidGrant(grant) ? grant : null;
}
