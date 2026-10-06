import { isGranted } from "@/lib/agents/control/permissions";
import type { AgentCapability } from "@/lib/agents/control/capabilities";
import type { AgentPermissionGrant } from "@/lib/agents/control/permissions";

/**
 * What can be done in a workspace's project (Hubble 1.6) — the canonical list,
 * and only things something actually enforces.
 *
 *     ProjectCapabilities
 *     ├── read_files          the agent reads inside the project       grant: read_project · adapter policy
 *     ├── write_files         the agent edits, asking every time        grant: write_project · broker
 *     ├── run_commands        the agent runs commands, asking every time grant: run_commands · broker
 *     ├── inspect_repository  Hubble reads the project's type and Git    local runtime · filesystem seam
 *     └── run_checks          the person runs a project check           grant: run_commands · local runtime
 *
 * ## Why there is no "git diff" capability
 *
 * Hubble measures the change an agent made itself, from the copy it took
 * before approving it — it never asks Git. A capability named for something
 * Hubble does not do would be exactly the cosmetic permission the brief rules
 * out. Git *status* is one of the checks (`run_checks`), run when the person
 * asks for it.
 *
 * ## Agent capabilities are an intersection, never a union
 *
 * The three agent capabilities need the project's grant **and** the agent's
 * own ability: a grant of `write_project` to an agent whose adapter cannot
 * write is not a capability that agent has. Passing no provider capabilities
 * means "describe the grant" (the workspace view, before an agent is chosen).
 */

export type ProjectCapability = "read_files" | "write_files" | "run_commands" | "inspect_repository" | "run_checks";

export const PROJECT_CAPABILITIES: readonly ProjectCapability[] = [
  "read_files",
  "write_files",
  "run_commands",
  "inspect_repository",
  "run_checks",
] as const;

export function isProjectCapability(value: unknown): value is ProjectCapability {
  return typeof value === "string" && (PROJECT_CAPABILITIES as readonly string[]).includes(value);
}

/** What each means to the person. Writes and commands say that they ask, because they do. */
export const PROJECT_CAPABILITY_LABELS: Record<ProjectCapability, string> = {
  read_files: "Read files",
  write_files: "Modify files · asks first",
  run_commands: "Run commands · asks first",
  inspect_repository: "Inspect repository",
  run_checks: "Run checks",
};

/** The same, as the short phrase an agent reads in its context. */
export const PROJECT_CAPABILITY_AGENT_PHRASES: Record<ProjectCapability, string> = {
  read_files: "read files",
  write_files: "modify files (each change asks the person first)",
  run_commands: "run commands (each command asks the person first)",
  inspect_repository: "Hubble inspects the repository",
  run_checks: "the person can run project checks",
};

export type ProjectCapabilityInput = {
  /** The project's grant. */
  grant: AgentPermissionGrant;
  projectId: string;
  /** Whether the runtime holding the project runs on the machine the project is on. */
  local: boolean;
  /** Whether Hubble found at least one check it can run. */
  checks?: boolean;
  /**
   * The agent's own abilities, as the runtime reports them. Absent: no agent
   * chosen yet, so the grant alone is described.
   */
  providerCapabilities?: readonly AgentCapability[];
};

/** The capabilities, in canonical order. Every one is something the runtime enforces. */
export function projectCapabilitiesOf(input: ProjectCapabilityInput): ProjectCapability[] {
  const { grant, projectId, providerCapabilities } = input;
  const agentCan = (capability: AgentCapability) => !providerCapabilities || providerCapabilities.includes(capability);
  const out: ProjectCapability[] = [];
  if (isGranted(grant, "read_project", projectId) && agentCan("read_files")) out.push("read_files");
  if (isGranted(grant, "write_project", projectId) && agentCan("write_files")) out.push("write_files");
  if (isGranted(grant, "run_commands", projectId) && agentCan("run_commands")) out.push("run_commands");
  if (input.local) out.push("inspect_repository");
  if (input.local && input.checks && isGranted(grant, "run_commands", projectId)) out.push("run_checks");
  return out;
}

/** A capability list read back from somewhere untrusted: known values only, canonical order, no repeats. */
export function readProjectCapabilities(value: unknown): ProjectCapability[] {
  if (!Array.isArray(value)) return [];
  return PROJECT_CAPABILITIES.filter((capability) => value.includes(capability));
}
