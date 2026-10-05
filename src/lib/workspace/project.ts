import type { Workspace, WorkspaceProjectLink, WorkspaceStore } from "./types";

/**
 * The project a workspace is about (Hubble 1.6).
 *
 *     Workspace
 *     ├── Brief
 *     ├── Context
 *     ├── Project ── projectId ──► AgentProject (control/projects.ts)
 *     └── Agents
 *
 * ## A reference, not a second project model
 *
 * The project itself already exists: `AgentProject` is the grant of scope
 * over one directory that a person chose, with the agents allowed in it and
 * what they may do — kept on this device and re-validated by the runtime
 * whenever it is synced. A workspace only *points* at one, by id. So there is
 * one place a path lives, one place permissions live, and detaching a project
 * from a workspace revokes nothing the person did not ask to revoke.
 *
 * ## Binding
 *
 * Attaching binds the project to the workspace: the runtime is told which
 * workspaces each project belongs to (`workspaceProjectBindings`), and refuses
 * a session in any other workspace the use of it. A project attached to no
 * workspace keeps its pre-1.6 meaning — usable by the agents it was authorized
 * for, from wherever.
 */

const ID_LIMIT = 200;

/** A stored link, re-read strictly. Anything malformed is dropped by the persistence repair pass. */
export function readWorkspaceProjectLink(raw: unknown): WorkspaceProjectLink | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const projectId = source.projectId;
  if (typeof projectId !== "string" || !projectId || projectId.length > ID_LIMIT || /[\u0000-\u001f]/.test(projectId)) return undefined;
  const attachedAt = source.attachedAt;
  if (typeof attachedAt !== "number" || !Number.isFinite(attachedAt) || attachedAt < 0) return undefined;
  return { projectId, attachedAt };
}

/**
 * Attaches `projectId` to the workspace, or detaches with `null`. Returns the
 * same store when nothing changes, so a re-render does not write.
 */
export function setWorkspaceProject(
  store: WorkspaceStore,
  workspaceId: string,
  projectId: string | null,
  now: number = Date.now()
): WorkspaceStore {
  let changed = false;
  const workspaces = store.workspaces.map((workspace): Workspace => {
    if (workspace.id !== workspaceId) return workspace;
    if (projectId === null) {
      if (!workspace.project) return workspace;
      changed = true;
      const copy = { ...workspace };
      delete copy.project;
      return copy;
    }
    if (workspace.project?.projectId === projectId) return workspace;
    const link = readWorkspaceProjectLink({ projectId, attachedAt: now });
    if (!link) return workspace;
    changed = true;
    return { ...workspace, project: link };
  });
  return changed ? { ...store, workspaces } : store;
}

/** The project id a workspace is attached to, if any. */
export function workspaceProjectId(workspace: Pick<Workspace, "project"> | undefined | null): string | undefined {
  return workspace?.project ? readWorkspaceProjectLink(workspace.project)?.projectId : undefined;
}

/**
 * Which workspaces each project is attached to — what the runtime is told so
 * it can refuse a project to a session in any other workspace.
 */
export function workspaceProjectBindings(workspaces: readonly Pick<Workspace, "id" | "project">[]): ReadonlyMap<string, readonly string[]> {
  const bindings = new Map<string, string[]>();
  for (const workspace of workspaces) {
    const projectId = workspaceProjectId(workspace);
    if (!projectId) continue;
    const list = bindings.get(projectId) ?? [];
    if (!list.includes(workspace.id)) list.push(workspace.id);
    bindings.set(projectId, list);
  }
  for (const list of bindings.values()) list.sort();
  return bindings;
}
