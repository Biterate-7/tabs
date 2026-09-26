/**
 * What a provider's control adapter can actually do.
 *
 * ## The rule this file exists to enforce
 *
 * A capability declares what an adapter **implements today**, never what it
 * is expected to implement. There is deliberately no `planned`, `roadmap` or
 * `comingSoon` field anywhere in this module: the moment one exists, a UI
 * renders it, a user reads it as a promise, and the product has started
 * lying about what it can do. The roadmap lives in
 * `docs/agent-control-architecture.md`, where nothing can render it as a
 * feature.
 *
 * Every set therefore starts from `NO_CAPABILITIES` and adds only what has
 * been built and tested. An adapter that has not been written declares the
 * empty set, and every operation on it returns `unsupported` — which is the
 * honest state, and is what `providers/` ships for Phase B.
 */

/**
 * The closed set of things a control adapter may be able to do.
 *
 * A union rather than an open string, for the same reason `AgentProviderId`
 * is one: adding a capability should be a deliberate edit that produces a
 * type error everywhere that has to care, rather than a new string appearing
 * in a declaration and silently meaning nothing.
 *
 * `observe` is here even though observation has its own plane, because a
 * consumer asking "what can this provider do" wants one answer. It is the
 * only capability that is satisfied by the *observation* adapter rather than
 * the control adapter, and `providerCapabilities` in ../registry.ts is what
 * unions the two.
 */
export type AgentCapability =
  /** Can report sessions/runs it did not start. Satisfied by the observation plane. */
  | "observe"
  /** Can send a message into a live session and have the agent act on it. */
  | "message"
  /** Can start a new agent session. */
  | "create_session"
  /** Can reattach to a session that already exists, by the provider's own id. */
  | "resume_session"
  /** Can stop an in-flight run without killing the session. */
  | "cancel_run"
  /** Can deliver events while a run is ongoing, rather than only after it ends. */
  | "stream_events"
  /** The agent can read files inside an authorized project scope. */
  | "read_files"
  /** The agent can modify files inside an authorized project scope. */
  | "write_files"
  /** The agent can execute commands inside an authorized project scope. */
  | "run_commands"
  /** The agent can reach MCP-connected tools. */
  | "mcp"
  /** The provider can pause on a permission decision and wait for an answer. */
  | "approvals"
  /** A session can be given one working directory. */
  | "working_directory"
  /** A session can be given further authorized directories beyond the working one. */
  | "additional_directories"
  /**
   * A session can be handed its Hubble workspace context server (Phase J.4),
   * and the adapter can prove — from the agent's own structure, never from a
   * name or a title — which of the agent's tool calls are that server's.
   * An adapter that cannot prove it does not declare this, and its sessions
   * start without workspace context rather than with context they cannot
   * safely use.
   */
  | "workspace_context";

export const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "observe",
  "message",
  "create_session",
  "resume_session",
  "cancel_run",
  "stream_events",
  "read_files",
  "write_files",
  "run_commands",
  "mcp",
  "approvals",
  "working_directory",
  "additional_directories",
  "workspace_context",
] as const;

export function isAgentCapability(value: unknown): value is AgentCapability {
  return typeof value === "string" && (AGENT_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * A declared capability set.
 *
 * `ReadonlySet` rather than an array so that membership is the only question
 * it can answer — order and duplicates are not meaningful here, and an array
 * invites both.
 */
export type AgentCapabilitySet = ReadonlySet<AgentCapability>;

/** Nothing claimed. The base every declaration starts from. */
export const NO_CAPABILITIES: AgentCapabilitySet = new Set<AgentCapability>();

/**
 * Builds a capability set.
 *
 * Takes the capabilities explicitly, so a declaration reads as a list of
 * things that work. There is no "all" helper and no spread-from-another-set
 * helper, because both make it easy to claim a capability without having
 * thought about whether it is true.
 */
export function capabilitySet(...capabilities: AgentCapability[]): AgentCapabilitySet {
  return new Set(capabilities);
}

export function hasCapability(set: AgentCapabilitySet, capability: AgentCapability): boolean {
  return set.has(capability);
}

/** Every declared capability, in the canonical order above rather than insertion order. */
export function listCapabilities(set: AgentCapabilitySet): AgentCapability[] {
  return AGENT_CAPABILITIES.filter((capability) => set.has(capability));
}

/**
 * Human labels, provider-neutral by construction.
 *
 * Phrased as what the *agent* can do rather than what Hubble supports, because
 * that is the question a user is asking when they read this list before
 * authorizing a project.
 */
export const CAPABILITY_LABELS: Record<AgentCapability, string> = {
  observe: "Observe sessions",
  message: "Send messages",
  create_session: "Start sessions",
  resume_session: "Resume sessions",
  cancel_run: "Cancel runs",
  stream_events: "Stream activity",
  read_files: "Read project files",
  write_files: "Modify project files",
  run_commands: "Run commands",
  mcp: "MCP tools",
  approvals: "Ask for approval",
  working_directory: "Working directory",
  additional_directories: "Additional directories",
  workspace_context: "Hubble workspace context",
};

/**
 * Capabilities whose use touches the user's machine rather than only the
 * provider's service.
 *
 * Used by the permission layer to decide which operations need a project
 * scope at all. Keeping the list here rather than in `permissions.ts` means
 * a capability added above has exactly one place to be classified, and
 * `capabilities.test.ts` fails if a new one is left unclassified.
 */
export const LOCAL_EFFECT_CAPABILITIES: readonly AgentCapability[] = [
  "read_files",
  "write_files",
  "run_commands",
] as const;

export function isLocalEffectCapability(capability: AgentCapability): boolean {
  return (LOCAL_EFFECT_CAPABILITIES as readonly string[]).includes(capability);
}
