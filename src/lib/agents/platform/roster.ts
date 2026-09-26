import { scopedKey } from "@/lib/storage/namespace";
import { isValidTimestamp } from "@/lib/timestamps";
import { isAgentProviderId } from "@/lib/agents/connectors/types";
import { isAgentPermissionScope } from "@/lib/agents/control/permissions";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentPermissionScope } from "@/lib/agents/control/permissions";

/**
 * The agents a user has connected: persistent identities (Phase J).
 *
 * ## What an identity is
 *
 * A connected agent is a *someone* in Hubble: it has a name, a provider (and
 * so a mark and an accent — see lib/agents/visual/), the moment it was
 * connected, what the user approved it for, the workspace it was last working
 * in and its most recent session. The command centre's roster renders these,
 * with live state layered on from the runtime.
 *
 * ## What an identity is not
 *
 * A credential. There is no token, key, login, account id or path here, and
 * `platform/security.test.ts` fails the build if a field named like one
 * appears. The agent's own login stays in the agent; a provider key stays
 * encrypted server-side; an MCP token is shown once and never stored in the
 * browser. An identity says *that* the user connected something, never *how
 * to be* it.
 *
 * Nor is it a status. "Connected" is derived on every render from what the
 * runtime reports (./lifecycle.ts); an identity outlives a restart, a signed-
 * out agent and an uninstall, and the roster then says so rather than
 * claiming a connection it no longer has.
 *
 * ## Storage
 *
 * `tabdump:agent-roster:v1`, account-scoped like every agent key: which agents
 * one person connected is theirs, and another account signed into the same
 * browser must not inherit them. Revalidated field by field on load — an
 * entry edited in devtools into something incoherent is dropped, and a scope
 * that does not exist is removed rather than trusted.
 */

export const AGENT_ROSTER_KEY = "tabdump:agent-roster:v1";

/** One agent per provider. A second Codex identity would be the same agent twice. */
export const MAX_ROSTER_ENTRIES = 16;

export const MAX_AGENT_NAME_LENGTH = 60;

export type AgentIdentity = {
  /** Stable, derived from the provider — see `agentIdFor`. */
  id: string;
  provider: AgentProviderId;
  /** What the user calls it. Defaults to the provider's name. */
  name: string;
  connectedAt: number;
  /** What the user approved, at the moment they approved it. */
  approvedScopes: readonly AgentPermissionScope[];
  approvedAt: number;
  /** The Hubble workspace this agent last worked in, by id. */
  workspaceId?: string;
  /** The runtime session it last had, by id. May no longer exist. */
  lastSessionId?: string;
  lastActiveAt?: number;
};

export type AgentRoster = { version: 1; agents: readonly AgentIdentity[] };

export const EMPTY_ROSTER: AgentRoster = { version: 1, agents: [] };

/** One identity per provider, so the id is the provider's, namespaced. */
export function agentIdFor(provider: AgentProviderId): string {
  return `agent:${provider}`;
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_AGENT_NAME_LENGTH);
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

function reviveIdentity(value: unknown): AgentIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (!isAgentProviderId(record.provider)) return null;
  if (record.id !== agentIdFor(record.provider)) return null;
  const name = cleanName(record.name);
  if (!name) return null;
  if (!isValidTimestamp(record.connectedAt) || !isValidTimestamp(record.approvedAt)) return null;
  if (!Array.isArray(record.approvedScopes)) return null;

  const identity: AgentIdentity = {
    id: record.id,
    provider: record.provider,
    name,
    connectedAt: record.connectedAt as number,
    // An unknown scope is removed, never widened into.
    approvedScopes: [...new Set(record.approvedScopes.filter(isAgentPermissionScope))],
    approvedAt: record.approvedAt as number,
  };

  const workspaceId = optionalId(record.workspaceId);
  if (workspaceId) identity.workspaceId = workspaceId;
  const lastSessionId = optionalId(record.lastSessionId);
  if (lastSessionId) identity.lastSessionId = lastSessionId;
  if (isValidTimestamp(record.lastActiveAt)) identity.lastActiveAt = record.lastActiveAt as number;

  return identity;
}

export function loadAgentRoster(): AgentRoster {
  try {
    const raw = window.localStorage.getItem(scopedKey(AGENT_ROSTER_KEY));
    if (raw === null) return EMPTY_ROSTER;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.agents)) return EMPTY_ROSTER;

    const seen = new Set<AgentProviderId>();
    const agents: AgentIdentity[] = [];
    for (const candidate of parsed.agents) {
      const identity = reviveIdentity(candidate);
      if (!identity || seen.has(identity.provider)) continue;
      seen.add(identity.provider);
      agents.push(identity);
    }
    return { version: 1, agents: agents.slice(0, MAX_ROSTER_ENTRIES) };
  } catch {
    return EMPTY_ROSTER;
  }
}

export function saveAgentRoster(roster: AgentRoster): boolean {
  try {
    // Written through the reviver, so nothing that would not load is ever stored.
    const agents = roster.agents
      .map((agent) => reviveIdentity(agent))
      .filter((agent): agent is AgentIdentity => agent !== null)
      .slice(0, MAX_ROSTER_ENTRIES);
    window.localStorage.setItem(scopedKey(AGENT_ROSTER_KEY), JSON.stringify({ version: 1, agents }));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Pure updates
 * ------------------------------------------------------------------ */

/** Adds or re-approves an agent. Re-approving replaces the scopes, never merges them. */
export function approveAgent(
  roster: AgentRoster,
  input: { provider: AgentProviderId; name: string; scopes: readonly AgentPermissionScope[]; now: number }
): AgentRoster {
  const existing = roster.agents.find((agent) => agent.provider === input.provider);
  const identity: AgentIdentity = {
    ...(existing ?? {}),
    id: agentIdFor(input.provider),
    provider: input.provider,
    name: cleanName(input.name) ?? existing?.name ?? input.provider,
    connectedAt: existing?.connectedAt ?? input.now,
    approvedScopes: [...new Set(input.scopes.filter(isAgentPermissionScope))],
    approvedAt: input.now,
  };
  const others = roster.agents.filter((agent) => agent.provider !== input.provider);
  return { version: 1, agents: [identity, ...others].slice(0, MAX_ROSTER_ENTRIES) };
}

export function forgetAgent(roster: AgentRoster, provider: AgentProviderId): AgentRoster {
  return { version: 1, agents: roster.agents.filter((agent) => agent.provider !== provider) };
}

/** Records the session and workspace an agent is now working in. */
export function recordAgentSession(
  roster: AgentRoster,
  input: { provider: AgentProviderId; sessionId: string; workspaceId?: string; now: number }
): AgentRoster {
  return {
    version: 1,
    agents: roster.agents.map((agent) =>
      agent.provider === input.provider
        ? {
            ...agent,
            lastSessionId: input.sessionId,
            lastActiveAt: input.now,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          }
        : agent
    ),
  };
}

export function identityFor(roster: AgentRoster, provider: AgentProviderId): AgentIdentity | undefined {
  return roster.agents.find((agent) => agent.provider === provider);
}

/**
 * Whether a project's grant stays within what the agent was approved for.
 *
 * A convenience check in the browser, not a boundary: the runtime enforces
 * the project grant itself, and every write and command still needs its own
 * approval. What this adds is that approving Codex "read only" in the connect
 * flow means a session cannot quietly start it on a project that would let
 * it write.
 */
export function grantWithinApproval(
  identity: AgentIdentity,
  grantScopes: readonly AgentPermissionScope[]
): boolean {
  return grantScopes.every((scope) => identity.approvedScopes.includes(scope));
}
