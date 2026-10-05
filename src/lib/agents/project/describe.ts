import { projectCapabilitiesOf } from "./capabilities";
import { isSecretLikePath } from "./secrets";
import { scrubSecretShapes } from "@/lib/secret-shapes";
import type { ProjectCapability } from "./capabilities";
import type { ProjectAccessState, ProjectFileState, ProjectInspection, ProjectRepository, ProjectTypeId } from "./inspection";
import type { AgentCapability } from "@/lib/agents/control/capabilities";
import type { AgentProject } from "@/lib/agents/control/projects";

/**
 * A project as everything outside the runtime may know it (Hubble 1.6): the
 * one shape the Context Pack, the Context Inspector, the handoff and the
 * landing demo read. Built from the project grant plus what the runtime found
 * when it looked — and with no field a path could travel in.
 *
 * `location` is the distinction the brief insists on: a local project is a
 * folder on this machine that a local runtime reaches; a remote one is a
 * sandbox Hubble created. A local project's path never leaves this device,
 * and a remote agent is never told one.
 */
export type ProjectDescriptor = {
  id: string;
  name: string;
  location: "local" | "remote";
  /** Whether the folder could be reached, as last inspected. Absent: not inspected. */
  state?: ProjectAccessState;
  type?: ProjectTypeId;
  repository?: ProjectRepository;
  /** What the agent may do there, every one enforced. */
  capabilities: readonly ProjectCapability[];
  /** The named files as they are now — never contents. */
  files: readonly ProjectFileState[];
};

export const MAX_PROJECT_NAME = 120;

function cleanName(name: string): string {
  const text = scrubSecretShapes(name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());
  return (text.length > MAX_PROJECT_NAME ? text.slice(0, MAX_PROJECT_NAME) : text) || "Untitled project";
}

export function describeProject(input: {
  project: Pick<AgentProject, "id" | "name" | "source" | "permissions">;
  inspection?: ProjectInspection | null;
  /** The agent's own abilities; absent describes the grant. */
  providerCapabilities?: readonly AgentCapability[];
  /** Whether a local runtime with project access is reachable. */
  local: boolean;
}): ProjectDescriptor {
  const { project } = input;
  const location = project.source === "local" ? "local" : "remote";
  const inspection = input.inspection && input.inspection.projectId === project.id ? input.inspection : undefined;
  const local = location === "local" && input.local;
  return {
    id: project.id,
    name: cleanName(project.name),
    location,
    ...(inspection ? { state: inspection.state } : {}),
    ...(inspection?.type ? { type: inspection.type } : {}),
    ...(inspection?.repository ? { repository: { ...inspection.repository } } : {}),
    capabilities: projectCapabilitiesOf({
      grant: project.permissions,
      projectId: project.id,
      local,
      checks: Boolean(inspection && inspection.checks.length > 0),
      ...(input.providerCapabilities ? { providerCapabilities: input.providerCapabilities } : {}),
    }),
    files: (inspection?.files ?? []).map((file) => (isSecretLikePath(file.path) ? { path: file.path, state: "sensitive" as const } : { ...file })),
  };
}
