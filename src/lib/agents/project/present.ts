import { PROJECT_CAPABILITY_LABELS } from "./capabilities";
import { PROJECT_TYPE_LABELS } from "./inspection";
import type { ProjectCapability } from "./capabilities";
import type { ProjectAccessState, ProjectRepository, ProjectTypeId } from "./inspection";

/**
 * Every sentence Hubble says about a workspace's project (Hubble 1.6), in one
 * place — the context panel, the Context Inspector, New session, the handoff
 * and the landing demo all read these. No error code, provider id, path or
 * exception text ever reaches a person through here.
 */

/**
 * Where a workspace's project stands, as one state.
 *
 *   - `connected` — attached, reachable, ready for agent work;
 *   - `none` — no project attached;
 *   - `unsupported` — this environment cannot reach local files (a browser,
 *     a hosted deployment, a sandbox runtime);
 *   - `checking` — attached, not yet inspected;
 *   - `runtime_disconnected` — the runtime that would reach it is gone;
 *   - `removed` — the workspace points at a project this device no longer has;
 *   - the four access failures the runtime reports.
 */
export type WorkspaceProjectState =
  | "connected"
  | "none"
  | "unsupported"
  | "checking"
  | "runtime_disconnected"
  | "removed"
  | Exclude<ProjectAccessState, "ready">;

export type ProjectStateCopy = { label: string; title: string; detail: string; tone: "good" | "muted" | "warn" | "bad" };

export const PROJECT_STATE_COPY: Record<WorkspaceProjectState, ProjectStateCopy> = {
  connected: { label: "Connected", title: "Ready for agent work", detail: "Agents working here can use this project.", tone: "good" },
  none: { label: "Not connected", title: "No folder connected", detail: "Connect a folder so agents can work on its files.", tone: "muted" },
  unsupported: {
    label: "Unsupported",
    title: "Project work is available in the Hubble desktop app.",
    detail: "This version of Hubble can't reach files on your computer.",
    tone: "muted",
  },
  checking: { label: "Checking", title: "Checking the project…", detail: "Hubble is making sure it can reach the folder.", tone: "muted" },
  runtime_disconnected: {
    label: "Runtime disconnected",
    title: "Runtime unavailable",
    detail: "The agent runtime can't execute project actions right now.",
    tone: "warn",
  },
  removed: {
    label: "Removed",
    title: "Project removed",
    detail: "This workspace points at a project that is no longer authorized on this device.",
    tone: "warn",
  },
  missing: { label: "Moved or deleted", title: "Project changed", detail: "This project has moved or been deleted since it was connected.", tone: "bad" },
  permission_denied: { label: "Permission denied", title: "Permission denied", detail: "Hubble doesn't have permission to access this project.", tone: "bad" },
  not_a_directory: { label: "Not a folder", title: "Project unavailable", detail: "The project's location is no longer a folder.", tone: "bad" },
  unavailable: { label: "Unavailable", title: "Project unavailable", detail: "Hubble can't access this project.", tone: "bad" },
};

/** "Next.js · Git main", or as much as is known. */
export function projectKindLine(input: { type?: ProjectTypeId; repository?: Pick<ProjectRepository, "branch" | "head" | "detached"> }): string | undefined {
  const parts: string[] = [];
  if (input.type) parts.push(PROJECT_TYPE_LABELS[input.type]);
  if (input.repository) {
    if (input.repository.branch) parts.push(`Git ${input.repository.branch}`);
    else if (input.repository.detached && input.repository.head) parts.push(`Git ${input.repository.head.slice(0, 7)}`);
    else parts.push("Git repository");
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Capabilities as the person reads them, canonical order. */
export function projectCapabilityLabels(capabilities: readonly ProjectCapability[]): string[] {
  return capabilities.map((capability) => PROJECT_CAPABILITY_LABELS[capability]);
}

/** A project state from what is known, in the order the questions are asked. */
export function workspaceProjectState(input: {
  /** The workspace names a project. */
  attached: boolean;
  /** This device still holds that project's grant. */
  known: boolean;
  /** A runtime that can reach local projects answered. `undefined` while it is being asked. */
  supported: boolean | undefined;
  runtimeConnected: boolean;
  access?: ProjectAccessState;
}): WorkspaceProjectState {
  if (!input.attached) return input.supported === false ? "unsupported" : "none";
  if (!input.known) return "removed";
  if (input.supported === false) return "unsupported";
  if (!input.runtimeConnected) return "runtime_disconnected";
  if (!input.access) return "checking";
  return input.access === "ready" ? "connected" : input.access;
}

/** Whether a session may be started in a workspace's project in this state. */
export function projectReadyForSession(state: WorkspaceProjectState): boolean {
  return state === "connected";
}

/** One short line for what an agent may do — "Read, edit, run" — and whether it asks. */
export function projectCapabilitySummary(capabilities: readonly ProjectCapability[]): { value: string; detail?: string } {
  const verbs: string[] = []
  if (capabilities.includes("read_files")) verbs.push("read")
  if (capabilities.includes("write_files")) verbs.push("edit")
  if (capabilities.includes("run_commands")) verbs.push("run")
  if (verbs.length === 0) return { value: capabilities.includes("run_checks") ? "Checks only" : "Nothing in the project" }
  const line = verbs.join(", ")
  const asks = capabilities.includes("write_files") || capabilities.includes("run_commands")
  return { value: `${line[0]!.toUpperCase()}${line.slice(1)}`, ...(asks ? { detail: "Edits and commands ask you first" } : {}) }
}
