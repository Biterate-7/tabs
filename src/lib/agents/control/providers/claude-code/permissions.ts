import { isGranted } from "../../permissions";
import type { AgentPermissionGrant, AgentPermissionScope } from "../../permissions";
import type { ClaudePermissionMode } from "./runtime";

/**
 * TabDump's permission model, expressed in Claude Code's.
 *
 * ## These are not the same system, and the mapping says so
 *
 * TabDump's model is **scope over a directory**: six coarse scopes, granted
 * per project, evaluated before anything reaches a provider. Claude Code's is
 * **a mode plus tool rules**: how to behave when a tool wants to run, and
 * which tools may run at all.
 *
 * Neither subsumes the other, so this module does not pretend one is a
 * translation of the other. It answers one narrow question — *given this
 * grant, what is the most restrictive Claude configuration that still lets
 * the granted things happen?* — and everything ungranted is denied twice:
 * once by TabDump refusing to dispatch, and once by the tool list Claude is
 * started with.
 *
 * ## Both boundaries must agree
 *
 *     TabDump project scope   →  outer boundary: is this even dispatchable?
 *     Claude tools + mode     →  provider boundary: may this tool run?
 *
 * An action happens only if both allow it. That redundancy is deliberate: a
 * bug in TabDump's gate is caught by Claude's tool list, and a
 * misunderstanding of Claude's mode is caught by TabDump refusing to
 * dispatch the capability in the first place.
 *
 * ## Why `bypassPermissions` can never be produced
 *
 * It is absent from `ClaudePermissionMode` entirely, so there is no value
 * this function could return that skips Claude's own checks. The most
 * permissive thing TabDump can ask for is `acceptEdits`, and only when the
 * user has granted `write_project` — and even then every write still passes
 * through `canUseTool`, because TabDump wants the approval regardless of what
 * the mode would allow on its own.
 */

/**
 * Claude tools, grouped by the TabDump scope that authorizes them.
 *
 * An explicit allowlist rather than a denylist. A tool Claude adds in a
 * future version is therefore **not** granted until someone classifies it
 * here — which is the correct default, and the opposite of what a denylist
 * would do.
 */
export const TOOLS_BY_SCOPE: Readonly<Record<AgentPermissionScope, readonly string[]>> = {
  // Reading the project. `Glob` and `Grep` are reads that return paths and
  // matched lines; they belong with `Read` rather than with anything that
  // changes state.
  read_project: ["Read", "Glob", "Grep", "NotebookRead"],
  // Changing the project.
  write_project: ["Edit", "Write", "NotebookEdit"],
  // Executing. `Bash` is the whole category, and it is the one tool whose
  // approval is never skipped.
  run_commands: ["Bash", "BashOutput", "KillShell"],
  // Reaching the network from inside a run.
  network_access: ["WebFetch", "WebSearch"],
  // MCP-connected tools. See the note on MCP below — TabDump configures no
  // servers in this phase, so this list authorizes nothing that exists.
  mcp_tools: [],
  // TabDump's own content never travels as a Claude tool. Workspace context
  // is resolved by TabDump and sent as message text, so there is no Claude
  // tool that reads a workspace and nothing here to allow.
  read_workspace: [],
};

/**
 * Tools always available, whatever the grant.
 *
 * `TodoWrite` maintains the agent's own task list and touches nothing outside
 * the process. Without it Claude cannot plan, and refusing it buys no safety
 * because it has no effect on the machine.
 */
export const ALWAYS_ALLOWED_TOOLS: readonly string[] = ["TodoWrite"];

/**
 * Tools TabDump never allows, in any configuration.
 *
 * `Task` spawns a subagent whose own tool use TabDump cannot see or gate at
 * the point of use — the parent's grant would silently become the child's.
 * Until the control plane can attribute subagent activity and route its
 * approvals, allowing it would mean an agent could do through a subagent what
 * it may not do directly.
 */
export const NEVER_ALLOWED_TOOLS: readonly string[] = ["Task"];

/** Every scope whose tools this mapping knows about. */
export const MAPPED_SCOPES: readonly AgentPermissionScope[] = [
  "read_project",
  "write_project",
  "run_commands",
  "network_access",
  "mcp_tools",
  "read_workspace",
] as const;

export type ClaudePermissionPlan = {
  mode: ClaudePermissionMode;
  /**
   * Tools the provider may run **without asking**.
   *
   * Deliberately tiny, and it is not "the tools the grant authorizes".
   *
   * A bare tool name in Claude's `allowedTools` **auto-approves that tool
   * before `canUseTool` is consulted** — the SDK emits a
   * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning saying exactly this. Listing
   * every granted tool here, which is the obvious reading of the option,
   * would therefore silently suppress the approval prompt for all of them:
   * TabDump would show nothing and Claude would edit the file. It is the same
   * trap as `acceptEdits`, one layer down.
   *
   * So only `ALWAYS_ALLOWED_TOOLS` goes here — tools with no effect on the
   * machine, which nobody should be asked about. Everything the grant
   * authorizes is left out of **both** lists on purpose, so it falls through
   * to `canUseTool`, where TabDump checks the scope and the user decides.
   */
  allowedTools: readonly string[];
  /**
   * Tools the provider may never run, whatever the mode.
   *
   * Everything this mapping knows about that the grant did not authorize,
   * plus `NEVER_ALLOWED_TOOLS`. A hard floor beneath the callback rather than
   * a substitute for it.
   */
  disallowedTools: readonly string[];
};

/**
 * Every tool this mapping knows about, in any scope.
 *
 * Used to build `disallowedTools`: everything classified and not granted is
 * named explicitly, rather than relying on absence from `allowedTools`.
 */
function allKnownTools(): string[] {
  const tools = new Set<string>(NEVER_ALLOWED_TOOLS);
  for (const scope of MAPPED_SCOPES) {
    for (const tool of TOOLS_BY_SCOPE[scope]) tools.add(tool);
  }
  return [...tools];
}

/**
 * The mode a grant implies.
 *
 * Two outcomes, and the reasoning is about **where the decision happens**
 * rather than about how permissive to be:
 *
 *   - A grant that permits something gets `default`, which prompts for
 *     dangerous operations — and a prompt is what invokes the host's
 *     `canUseTool`. That is how TabDump gets to decide.
 *   - A grant that permits nothing gets `dontAsk`, which denies anything not
 *     pre-approved without prompting. There is nothing to ask about.
 *
 * Scoping is done by the **tool list**, not by the mode. That separation is
 * deliberate: a mode that narrowed access by auto-answering (`acceptEdits`)
 * would take the decision away from the user, and a mode that narrowed it by
 * refusing to execute (`plan`) would change what the product is. The tool
 * list restricts *what exists*; the mode keeps *who decides* with TabDump.
 */
export function modeForGrant(grant: AgentPermissionGrant, projectId?: string): ClaudePermissionMode {
  const permitsSomething = MAPPED_SCOPES.some((scope) => isGranted(grant, scope, projectId));
  return permitsSomething ? "default" : "dontAsk";
}

/**
 * The full Claude configuration for a grant.
 *
 * Pure, and the single place the two permission systems meet. A scope that
 * was not granted contributes no tools; a tool that is never allowed is named
 * in `disallowedTools` whatever the grant says.
 */
export function planForGrant(
  grant: AgentPermissionGrant,
  projectId?: string
): ClaudePermissionPlan {
  /** What the grant authorizes — used to decide what is *denied*, not what is auto-allowed. */
  const granted = new Set<string>();

  for (const scope of MAPPED_SCOPES) {
    if (!isGranted(grant, scope, projectId)) continue;
    for (const tool of TOOLS_BY_SCOPE[scope]) granted.add(tool);
  }

  // Never-allowed wins over any grant that would have included it.
  for (const tool of NEVER_ALLOWED_TOOLS) granted.delete(tool);

  // Everything known and ungranted is denied outright. Everything granted is
  // in NEITHER list, so it reaches `canUseTool`. See the note on
  // `allowedTools` above for why that is the whole point.
  const disallowed = allKnownTools().filter((tool) => !granted.has(tool));

  return {
    mode: modeForGrant(grant, projectId),
    allowedTools: [...ALWAYS_ALLOWED_TOOLS].sort(),
    disallowedTools: disallowed.sort(),
  };
}

/** The tools a grant authorizes, each still subject to `canUseTool`. */
export function grantedTools(
  grant: AgentPermissionGrant,
  projectId?: string
): readonly string[] {
  const granted = new Set<string>();
  for (const scope of MAPPED_SCOPES) {
    if (!isGranted(grant, scope, projectId)) continue;
    for (const tool of TOOLS_BY_SCOPE[scope]) granted.add(tool);
  }
  for (const tool of NEVER_ALLOWED_TOOLS) granted.delete(tool);
  return [...granted].sort();
}

/**
 * Which TabDump scope a Claude tool falls under, or `null` for one this
 * mapping does not know.
 *
 * `null` is the important case: it is what an unclassified tool returns, and
 * every caller treats it as "not authorized" rather than "no scope needed".
 * That is how a tool added by a future Claude version fails closed.
 */
export function scopeForTool(toolName: string): AgentPermissionScope | null {
  for (const scope of MAPPED_SCOPES) {
    if (TOOLS_BY_SCOPE[scope].includes(toolName)) return scope;
  }
  return null;
}

/**
 * Whether a tool may run under a grant.
 *
 * The check applied to a live permission request, *after* Claude has already
 * decided to ask. Both boundaries must agree, and this is TabDump's side of
 * that agreement: a tool whose scope was never granted is denied even if
 * Claude's own configuration would have allowed it.
 *
 * An unknown tool is denied. An MCP tool — which arrives with an `mcp__`
 * prefix and is not in any list — is therefore denied, which is correct while
 * TabDump configures no MCP servers.
 */
export function isToolPermitted(
  toolName: string,
  grant: AgentPermissionGrant,
  projectId?: string
): boolean {
  if (NEVER_ALLOWED_TOOLS.includes(toolName)) return false;
  if (ALWAYS_ALLOWED_TOOLS.includes(toolName)) return true;

  const scope = scopeForTool(toolName);
  if (scope === null) return false;

  return isGranted(grant, scope, projectId);
}
