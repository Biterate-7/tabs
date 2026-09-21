import { scopedKey } from "@/lib/storage/namespace";
import { isValidTimestamp } from "@/lib/timestamps";
import { isAgentPermissionScope } from "./permissions";
import { isAgentSessionStatus, isTerminalSessionStatus } from "./session";
import { validateProjectPath } from "./projects";
import { isAgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentPermissionGrant } from "./permissions";
import type { AgentProject } from "./projects";
import type { AgentSession } from "./session";

/**
 * Local-first persistence for the control plane.
 *
 * Two keys, account-scoped through the same mechanism every other TabDump
 * domain uses, so one account's projects and sessions are invisible to
 * another signed into the same browser.
 *
 * ## What is deliberately not stored
 *
 * **No credential, of any kind.** Not an API key, not a token, not an OAuth
 * refresh token, not a session cookie. localStorage is readable by any script
 * on the origin and survives indefinitely, so a secret written there is a
 * secret given away — the connector layer already established this, and
 * `session-credentials.ts` keeps its secrets in memory for the lifetime of
 * one page for exactly that reason.
 *
 * Phase B needs no credential: no adapter authenticates against anything.
 * When one does, it gets the in-memory mechanism that already exists, or a
 * new decision is made deliberately — **not** a field quietly added here.
 * `security.test.ts` fails the build if this module grows one.
 *
 * **No transcript.** No message bodies, no tool output, no file contents, no
 * events. A session record is a handle — who, where, what it was allowed to
 * touch, what it is doing. The live event stream is not persisted at all;
 * what survives for later reading is the domain's own bounded activity log,
 * which already has a retention cap and already gets written.
 *
 * ## Why sessions are restored as terminal
 *
 * A session that was `running` when the tab closed is not running now — the
 * process it was driving died with the page, or belongs to a machine this
 * browser cannot reach. Restoring it as `running` would show a spinner for
 * work that stopped, forever. Everything live is therefore restored as
 * `disconnected`, and reattaching is an explicit resume that mints a new
 * session carrying the same `providerSessionId`.
 */

export const CONTROL_SESSIONS_KEY = "tabdump:agent-sessions:v1";
export const CONTROL_PROJECTS_KEY = "tabdump:agent-projects:v1";

/**
 * Hard caps. Both structures are persisted, and anything persisted without a
 * bound eventually throws a quota error that takes the rest of the user's
 * state down with it.
 */
export const MAX_PERSISTED_SESSIONS = 200;
export const MAX_PERSISTED_PROJECTS = 100;

export type ControlSessionState = {
  version: 1;
  sessions: AgentSession[];
};

export type ControlProjectState = {
  version: 1;
  projects: AgentProject[];
};

export function defaultSessionState(): ControlSessionState {
  return { version: 1, sessions: [] };
}

export function defaultProjectState(): ControlProjectState {
  return { version: 1, projects: [] };
}

function readRaw(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(scopedKey(key));
    return raw === null ? null : JSON.parse(raw);
  } catch {
    // Unavailable storage and unparseable content are the same recoverable
    // situation: there is nothing to restore, which is a valid starting state.
    return null;
  }
}

function writeRaw(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(scopedKey(key), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a stored grant is coherent enough to restore.
 *
 * Revalidated rather than trusted, because a grant comes back from a place
 * the user can edit by hand. A grant that does not parse is replaced with no
 * permissions, never with the permissions it claimed.
 */
function reviveGrant(raw: unknown): AgentPermissionGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  if (!Array.isArray(record.scopes)) return null;
  if (!record.scopes.every(isAgentPermissionScope)) return null;
  if (!isValidTimestamp(record.grantedAt)) return null;

  const grant: AgentPermissionGrant = {
    scopes: record.scopes,
    grantedAt: record.grantedAt,
  };

  if (typeof record.projectId === "string" && record.projectId) {
    grant.projectId = record.projectId;
  }

  return grant;
}

function reviveSession(raw: unknown): AgentSession | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  if (typeof record.id !== "string" || !record.id) return null;
  if (!isAgentProviderId(record.provider)) return null;
  if (!isAgentSessionStatus(record.status)) return null;
  if (!isValidTimestamp(record.createdAt)) return null;
  if (!isValidTimestamp(record.updatedAt)) return null;

  // Whatever it was doing, it is not doing it now. See the note above.
  const status = isTerminalSessionStatus(record.status) ? record.status : "disconnected";

  const session: AgentSession = {
    id: record.id,
    provider: record.provider,
    status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    runIds: Array.isArray(record.runIds)
      ? record.runIds.filter((value): value is string => typeof value === "string")
      : [],
  };

  if (typeof record.providerSessionId === "string" && record.providerSessionId) {
    session.providerSessionId = record.providerSessionId;
  }
  if (typeof record.projectId === "string" && record.projectId) {
    session.projectId = record.projectId;
  }
  if (typeof record.workspaceId === "string" && record.workspaceId) {
    session.workspaceId = record.workspaceId;
  }
  if (typeof record.title === "string" && record.title) session.title = record.title;
  if (isValidTimestamp(record.endedAt)) session.endedAt = record.endedAt;

  return session;
}

/**
 * Revives a project, **revalidating its path**.
 *
 * The most security-sensitive function in this module. A project path is the
 * one persisted value that decides which directory an agent may touch, and it
 * comes back from a store the user can edit in devtools. Running it through
 * `validateProjectPath` again means a hand-edited `"C:/"` is dropped on load
 * rather than authorized, and the local runtime revalidates once more before
 * acting.
 */
function reviveProject(raw: unknown): AgentProject | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.name !== "string" || !record.name.trim()) return null;
  if (typeof record.path !== "string") return null;
  if (!isValidTimestamp(record.createdAt)) return null;
  if (!isValidTimestamp(record.updatedAt)) return null;

  const validated = validateProjectPath(record.path);
  if (!validated.ok) return null;

  const providers = Array.isArray(record.providers)
    ? record.providers.filter(isAgentProviderId)
    : [];

  // Revalidated one by one for the same reason the root is. A hand-edited
  // entry is *dropped* here rather than rejecting the whole project, because
  // losing one authorized directory is recoverable and losing the project
  // (and with it the user's permission grant) is not.
  const additionalDirectories: string[] = [];
  for (const candidate of Array.isArray(record.additionalDirectories)
    ? record.additionalDirectories
    : []) {
    if (typeof candidate !== "string") continue;
    const extra = validateProjectPath(candidate);
    if (extra.ok && !additionalDirectories.includes(extra.path)) {
      additionalDirectories.push(extra.path);
    }
  }

  const permissions = reviveGrant(record.permissions);

  return {
    id: record.id,
    name: record.name.trim(),
    path: validated.path,
    providers,
    additionalDirectories,
    // A grant that failed revival becomes no permissions. Never the reverse.
    permissions: permissions ?? { scopes: [], grantedAt: record.createdAt },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function loadControlSessions(): ControlSessionState {
  const raw = readRaw(CONTROL_SESSIONS_KEY);
  if (!raw || typeof raw !== "object") return defaultSessionState();

  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.sessions)) return defaultSessionState();

  const sessions = record.sessions
    .map(reviveSession)
    .filter((session): session is AgentSession => session !== null);

  return { version: 1, sessions };
}

export function saveControlSessions(state: ControlSessionState): boolean {
  // Newest first, then truncated — so the cap drops the oldest rather than
  // whichever happened to be last in the array.
  const sessions = [...state.sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PERSISTED_SESSIONS);

  return writeRaw(CONTROL_SESSIONS_KEY, { version: 1, sessions });
}

export function loadControlProjects(): ControlProjectState {
  const raw = readRaw(CONTROL_PROJECTS_KEY);
  if (!raw || typeof raw !== "object") return defaultProjectState();

  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.projects)) return defaultProjectState();

  const projects = record.projects
    .map(reviveProject)
    .filter((project): project is AgentProject => project !== null);

  return { version: 1, projects };
}

export function saveControlProjects(state: ControlProjectState): boolean {
  const projects = state.projects.slice(0, MAX_PERSISTED_PROJECTS);
  return writeRaw(CONTROL_PROJECTS_KEY, { version: 1, projects });
}
