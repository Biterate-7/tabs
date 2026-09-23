import { toProjectRelative } from "@/lib/agents/paths";
import type { ApprovalAction } from "../../approval-details";
import type { AgentControlEventKind } from "../../events";
import type { AgentPermissionScope } from "../../permissions";
import type { AcpToolKind } from "./protocol";

/**
 * What each ACP tool kind means in TabDump's permission model.
 *
 * ## One table, read by three decisions
 *
 *   1. **Whether to even ask.** A kind whose scope the grant does not include
 *      is refused at once, before the user sees anything — exactly as the
 *      Claude adapter refuses an ungranted tool.
 *   2. **What to ask.** `action` is the approval the broker records. A kind
 *      with no action is settled by the grant alone (a read inside the
 *      authorized project), which is the broker's `scope-needs-no-approval`.
 *   3. **What to enforce afterwards.** A `privileged` kind that starts
 *      running without an approval TabDump granted is an agent acting on its
 *      own authority — typically because the user configured it to
 *      auto-accept. The adapter stops that run. See `enforce` in ./adapter.ts.
 *
 * ## Unknown means most restrictive
 *
 * `other`, and any kind a newer agent invents, is treated as a connected tool
 * (`mcp_tools`, approval required). `switch_mode` is never allowed: a mode
 * switch is how an agent moves itself into "accept everything", and that is a
 * decision TabDump keeps.
 */
export type ToolPolicy = {
  scope: AgentPermissionScope;
  action?: ApprovalAction;
  privileged: boolean;
  /** The label a tool row carries. A category, never the agent's own title. */
  label: string;
  /** A fixed, safe description of what the tool is doing. */
  description: string;
  started: AgentControlEventKind;
  finished: AgentControlEventKind;
  /** The file event a completed call produces per location, if any. */
  fileKind?: AgentControlEventKind;
  /** Never permitted, whatever the grant says. */
  forbidden?: boolean;
};

const TOOL: Pick<ToolPolicy, "started" | "finished"> = {
  started: "tool_started",
  finished: "tool_finished",
};

export const TOOL_POLICIES: Record<AcpToolKind, ToolPolicy> = {
  read: { ...TOOL, scope: "read_project", privileged: false, label: "Read", description: "Reading files", fileKind: "file_read" },
  search: { ...TOOL, scope: "read_project", privileged: false, label: "Search", description: "Searching the project" },
  think: { ...TOOL, scope: "read_project", privileged: false, label: "Think", description: "Working it out" },
  edit: {
    ...TOOL,
    scope: "write_project",
    action: "modify_files",
    privileged: true,
    label: "Edit",
    description: "Editing files",
    fileKind: "file_modified",
  },
  move: { ...TOOL, scope: "write_project", action: "modify_files", privileged: true, label: "Move", description: "Moving files" },
  delete: { ...TOOL, scope: "write_project", action: "delete_files", privileged: true, label: "Delete", description: "Deleting files" },
  // The title of an execute call is usually the command line itself, which
  // is exactly the string the event model refuses to carry. The description
  // is therefore fixed; what command it was is the approval's business.
  execute: {
    scope: "run_commands",
    action: "run_command",
    privileged: true,
    label: "Command",
    description: "Running a command",
    started: "command_started",
    finished: "command_finished",
  },
  fetch: { ...TOOL, scope: "network_access", action: "network_request", privileged: true, label: "Fetch", description: "Reaching the network" },
  other: { ...TOOL, scope: "mcp_tools", action: "use_mcp_tool", privileged: true, label: "Tool", description: "Using a connected tool" },
  switch_mode: {
    ...TOOL,
    scope: "mcp_tools",
    privileged: true,
    label: "Mode",
    description: "Changing how it asks for approval",
    forbidden: true,
  },
};

export function policyFor(kind: AcpToolKind | undefined): ToolPolicy {
  return TOOL_POLICIES[kind ?? "other"];
}

/**
 * Agent-reported locations, reduced to project-relative paths.
 *
 * Anything outside the project — or any path when there is no project — is
 * dropped rather than shown: an absolute path would leak the user's directory
 * layout into the stream, and a path outside the root is not something this
 * session was authorized to touch in the first place.
 */
export function relativeLocations(
  projectPath: string | undefined,
  locations: readonly string[]
): string[] {
  if (!projectPath) return [];
  const out: string[] = [];
  for (const location of locations) {
    const reduced = toProjectRelative(projectPath, location);
    if (reduced.ok && reduced.relativePath && !out.includes(reduced.relativePath)) {
      out.push(reduced.relativePath);
    }
  }
  return out;
}
