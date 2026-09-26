import { createProject } from "@/lib/agents/control/projects";
import { REMOTE_WORKSPACE_ROOT } from "./types";
import type { AgentProject } from "@/lib/agents/control/projects";
import type { RemoteHostBindings, RemoteSessionRef } from "@/lib/agents/runtime/host";
import type { RemoteStore } from "./store";
import type { RemoteProject } from "./types";

/**
 * Durable remote state, in the runtime host's vocabulary.
 *
 * The adapter between two deliberately separate worlds: `RemoteStore` speaks
 * rows and sandbox names, the host speaks `AgentProject` and session ids, and
 * neither should have to learn the other's. Keeping the translation in one
 * small module is what lets the host stay pure — it never imports a store, a
 * database driver or a cloud SDK — and what makes the one genuinely
 * interesting question here answerable in one place: what does a remote
 * project look like as a project?
 */

/**
 * A remote project, as the control plane sees it.
 *
 * ## The three fields that are not stored, and why
 *
 * **`path`** is the constant workspace root, not a stored value. There is
 * nothing to store: every remote project sits at the same place inside its
 * own private microVM. A column here would be a filesystem path that somebody
 * could eventually write to, which is the thing the remote design exists to
 * make impossible.
 *
 * **`providers`** is Claude Code alone. Not because the architecture assumes
 * one provider — the seam below the adapter is provider-neutral and always
 * has been — but because declaring a provider that has no remote runtime
 * would let a session be started that could never run. A provider joins this
 * list when it has a runtime, not when it has a name.
 *
 * **`additionalDirectories`** is empty and stays empty. On the local plane it
 * is how a user reaches a sibling repository they explicitly named. There is
 * no sibling here: the sandbox contains this project and nothing else, so an
 * additional directory could only widen scope toward the bridge and the
 * credential in its environment.
 *
 * The grant, by contrast, *is* stored, and is read back here unchanged. See
 * `RemoteProject.scopes` on why a disposable microVM is not a reason to skip
 * asking.
 */
export function toAgentProject(project: RemoteProject, now: number): AgentProject | null {
  const made = createProject(
    {
      id: project.id,
      name: project.name,
      source: project.source,
      path: REMOTE_WORKSPACE_ROOT,
      providers: ["claude-code"],
      additionalDirectories: [],
      permissions: {
        scopes: [...project.scopes],
        // Scoped to this project by construction. A grant that named a
        // different project would be refused by `createProject`, which is the
        // check that stops one project's permissions applying to another.
        projectId: project.id,
        grantedAt: project.createdAt,
      },
    },
    now
  );

  // A row that will not validate is dropped rather than repaired. The only
  // way to get one is a hand-edited database, and a project that cannot be
  // rebuilt honestly should not be rebuilt at all.
  return made.ok ? made.project : null;
}

export type RemoteBindingsOptions = {
  store: RemoteStore;
  now?: () => number;
};

/**
 * The host's window onto durable remote state.
 *
 * Every function is owner-scoped in its signature and owner-scoped again in
 * the store's query. A caller cannot ask for somebody else's projects here,
 * because there is no argument that would express the request.
 */
export function createRemoteBindings(options: RemoteBindingsOptions): RemoteHostBindings {
  const now = options.now ?? (() => Date.now());

  return {
    async projects(actorId: string): Promise<readonly AgentProject[]> {
      const rows = await options.store.listProjects(actorId);
      const at = now();
      return rows
        .map((row) => toAgentProject(row, at))
        .filter((project): project is AgentProject => project !== null);
    },

    async sessions(actorId: string): Promise<readonly RemoteSessionRef[]> {
      const rows = await options.store.listSessions(actorId);
      return rows.map((row) => ({
        sessionId: row.id,
        provider: row.provider,
        projectId: row.projectId,
        ...(row.providerSessionId ? { providerSessionId: row.providerSessionId } : {}),
        createdAt: row.createdAt,
      }));
    },

    async forget(actorId: string, sessionId: string): Promise<void> {
      await options.store.deleteSession(actorId, sessionId);
    },
  };
}
