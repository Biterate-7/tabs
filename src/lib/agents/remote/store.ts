import { isDeadStatus, REMOTE_LIMITS } from "./types";
import type { RemoteProject, RemoteSandboxStatus, RemoteSession } from "./types";

/**
 * Durable state for the remote execution plane.
 *
 * ## Why a store exists at all, when the rest of TabDump is local-first
 *
 * Because remote execution is the one part of this product that genuinely
 * cannot be. A local runtime is a process that outlives the requests made to
 * it, so the host can hold its sessions in memory and mean it. A serverless
 * control plane is the opposite: the function that created a sandbox is gone
 * before the user's next keystroke, and an in-memory map of sandbox handles
 * would be an empty map on the very next request.
 *
 * So exactly two things are persisted — which sandbox backs which project,
 * and which sandbox backs which session — and nothing else migrates. Tabs,
 * collections, workspaces, graph layout and local projects stay exactly where
 * they are, in the browser. The brief's "do not blindly convert the whole
 * application into a server database" is honoured by this interface being
 * this small.
 *
 * ## Ownership is a query predicate, not a check
 *
 * Every method that reads takes an `ownerId` and folds it into the lookup.
 * There is deliberately **no** `getProject(id)` that returns a row for the
 * caller to inspect an owner on, because that shape is how cross-account
 * reads happen: somebody adds an early return, or logs the row before the
 * check, or forgets the check in the one new call site. A row that is not
 * yours does not come back at all, and `store.test.ts` drives every method
 * with a mismatched owner to prove it.
 */

export type RemoteStore = {
  /* -------------------------------------------------------------- *
   * Projects
   * -------------------------------------------------------------- */

  createProject(project: RemoteProject): Promise<void>;

  /** The caller's project, or nothing. Another owner's row is indistinguishable from a missing one. */
  findProject(ownerId: string, projectId: string): Promise<RemoteProject | undefined>;

  /** Every project this owner has, newest first. */
  listProjects(ownerId: string): Promise<RemoteProject[]>;

  updateProject(
    ownerId: string,
    projectId: string,
    patch: Partial<Pick<RemoteProject, "status" | "expiresAt" | "sandboxName">>,
    now: number
  ): Promise<RemoteProject | undefined>;

  deleteProject(ownerId: string, projectId: string): Promise<boolean>;

  /** Live sandboxes for this owner, for the concurrency limit. Counts rows, never returns them. */
  countLiveSandboxes(ownerId: string): Promise<number>;

  /* -------------------------------------------------------------- *
   * Sessions
   * -------------------------------------------------------------- */

  createSession(session: RemoteSession): Promise<void>;

  findSession(ownerId: string, sessionId: string): Promise<RemoteSession | undefined>;

  listSessions(ownerId: string): Promise<RemoteSession[]>;

  updateSession(
    ownerId: string,
    sessionId: string,
    patch: Partial<Pick<RemoteSession, "commandId" | "providerSessionId">>,
    now: number
  ): Promise<RemoteSession | undefined>;

  deleteSession(ownerId: string, sessionId: string): Promise<boolean>;

  countLiveSessions(ownerId: string): Promise<number>;

  /**
   * Projects whose sandbox deadline has passed, across every owner.
   *
   * The one method with no `ownerId`, and it is not an exception to the rule
   * above — it is the sweep, which belongs to nobody and returns only what is
   * needed to reclaim: an id, an owner and a sandbox name. A caller cannot
   * use it to read a project, because it does not return one.
   */
  findExpired(before: number, limit: number): Promise<ExpiredSandbox[]>;
};

export type ExpiredSandbox = {
  projectId: string;
  ownerId: string;
  sandboxName: string;
};

/* ------------------------------------------------------------------ *
 * In-memory
 * ------------------------------------------------------------------ */

/**
 * The store a test drives, and the store a single-process TabDump uses.
 *
 * Genuinely usable, and genuinely **not** usable on serverless — which is why
 * `server.ts` refuses to build a remote runtime on one. A memory store behind
 * a Vercel Function would hand out a sandbox on one instance and deny all
 * knowledge of it on the next, producing exactly the intermittent,
 * near-undebuggable failure the auth store already refuses to ship for the
 * same reason.
 */
export function createMemoryRemoteStore(): RemoteStore {
  const projects = new Map<string, RemoteProject>();
  const sessions = new Map<string, RemoteSession>();

  /** Owner-scoped lookup. Returns nothing for a row belonging to someone else. */
  function ownedProject(ownerId: string, projectId: string): RemoteProject | undefined {
    const project = projects.get(projectId);
    return project && project.ownerId === ownerId ? project : undefined;
  }

  function ownedSession(ownerId: string, sessionId: string): RemoteSession | undefined {
    const session = sessions.get(sessionId);
    return session && session.ownerId === ownerId ? session : undefined;
  }

  return {
    async createProject(project) {
      projects.set(project.id, { ...project });
    },

    async findProject(ownerId, projectId) {
      const project = ownedProject(ownerId, projectId);
      return project ? { ...project } : undefined;
    },

    async listProjects(ownerId) {
      return [...projects.values()]
        .filter((project) => project.ownerId === ownerId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((project) => ({ ...project }));
    },

    async updateProject(ownerId, projectId, patch, now) {
      const project = ownedProject(ownerId, projectId);
      if (!project) return undefined;

      const next: RemoteProject = { ...project, ...strip(patch), updatedAt: now };
      projects.set(projectId, next);
      return { ...next };
    },

    async deleteProject(ownerId, projectId) {
      if (!ownedProject(ownerId, projectId)) return false;
      projects.delete(projectId);
      // Sessions of a deleted project go with it. Leaving them would leave
      // rows pointing at a sandbox nothing can resolve any more.
      for (const [id, session] of sessions) {
        if (session.projectId === projectId) sessions.delete(id);
      }
      return true;
    },

    async countLiveSandboxes(ownerId) {
      return [...projects.values()].filter(
        (project) => project.ownerId === ownerId && !isDeadStatus(project.status)
      ).length;
    },

    async createSession(session) {
      sessions.set(session.id, { ...session });
    },

    async findSession(ownerId, sessionId) {
      const session = ownedSession(ownerId, sessionId);
      return session ? { ...session } : undefined;
    },

    async listSessions(ownerId) {
      return [...sessions.values()]
        .filter((session) => session.ownerId === ownerId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((session) => ({ ...session }));
    },

    async updateSession(ownerId, sessionId, patch, now) {
      const session = ownedSession(ownerId, sessionId);
      if (!session) return undefined;

      const next: RemoteSession = { ...session, ...strip(patch), updatedAt: now };
      sessions.set(sessionId, next);
      return { ...next };
    },

    async deleteSession(ownerId, sessionId) {
      if (!ownedSession(ownerId, sessionId)) return false;
      sessions.delete(sessionId);
      return true;
    },

    async countLiveSessions(ownerId) {
      return [...sessions.values()].filter((session) => session.ownerId === ownerId).length;
    },

    async findExpired(before, limit) {
      return [...projects.values()]
        .filter(
          (project) =>
            !isDeadStatus(project.status) &&
            project.expiresAt !== undefined &&
            project.expiresAt <= before
        )
        .slice(0, limit)
        .map((project) => ({
          projectId: project.id,
          ownerId: project.ownerId,
          sandboxName: project.sandboxName,
        }));
    },
  };
}

/**
 * Drops `undefined` values from a patch.
 *
 * Without this, `{ ...row, ...{ commandId: undefined } }` *clears* a field the
 * caller never meant to mention — the classic spread-with-optionals bug, and a
 * particularly bad one here because the field it would clear is the handle on
 * a running agent.
 */
function strip<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export type LimitRefusal = "too-many-sandboxes" | "too-many-sessions";

/**
 * Whether this owner may start one more of something.
 *
 * Checked against the store rather than a counter held anywhere, because two
 * concurrent requests on two serverless instances share no counter. This is
 * not a lock and does not pretend to be one — two simultaneous creates can
 * both pass — but it bounds the steady state, which is what stops an account
 * from accumulating sandboxes it forgot about. The hard stop is the platform's
 * own quota, and the deadline sweep is what actually reclaims.
 */
export async function checkSandboxLimit(
  store: RemoteStore,
  ownerId: string
): Promise<LimitRefusal | null> {
  const live = await store.countLiveSandboxes(ownerId);
  return live >= REMOTE_LIMITS.maxSandboxesPerOwner ? "too-many-sandboxes" : null;
}

export async function checkSessionLimit(
  store: RemoteStore,
  ownerId: string
): Promise<LimitRefusal | null> {
  const live = await store.countLiveSessions(ownerId);
  return live >= REMOTE_LIMITS.maxSessionsPerOwner ? "too-many-sessions" : null;
}

/** Statuses that mean a project's sandbox is still worth money. Exported for the sweep's query. */
export function liveStatuses(): readonly RemoteSandboxStatus[] {
  return ["creating", "ready", "running", "stopping"];
}
