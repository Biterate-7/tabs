import { SESSION_CONTEXT_TOOLS, SESSION_TOOL_CAPABILITY, isSessionContextTool, isWriteCapability } from "./capabilities";
import type { SessionContextCapability, SessionContextTool } from "./capabilities";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The one decision about a session's workspace context (Phase J.4).
 *
 * ## Where a context request can come from
 *
 * A TabDump context operation is decided in up to two places, and both ask
 * this module:
 *
 *   1. **The context server itself** (`origin: "context-server"`), on every
 *      tool call — the authority. It knows the credential's session, the
 *      bound workspace and the exact tool. Nothing reaches the workspace
 *      without passing here.
 *   2. **An agent's own permission step**, before the call is made. Claude
 *      Code pre-allows the tools this returns (`contextToolsFor`); an ACP
 *      agent that asks before an MCP call is answered from here — but only
 *      once its adapter has *proved*, from the agent's own structure, that
 *      the call targets this session's context server (`serverName`). An
 *      adapter that cannot prove it does not ask this module at all: the call
 *      stays an ordinary third-party tool, which TabDump refuses.
 *
 * Every provider's request is normalized into the same `SessionContextRequest`
 * (named so because `AgentContextRequest` is the Phase E resolver's request),
 * and the same function answers it. `provider` is carried so a decision can be
 * shown and audited; it never changes one — the tests hold every provider to
 * the same answers.
 *
 * ## What cannot be claimed
 *
 * A request carries no capabilities and no binding. The authority — the
 * session, its workspace, its server identity and its capabilities — comes
 * from the runtime's registry (the server) or from what the runtime handed
 * the adapter when the session started. A request naming another session,
 * another workspace or another server is refused, as is a tool the authority
 * does not hold.
 *
 * ## Approval
 *
 * Reads need none: the grant already answered them, exactly as a read inside
 * an authorized project needs none. Writes are `every-time`: the context
 * server raises a TabDump approval, through the control service's broker, for
 * each one, with the change spelled out. An agent-level answer for a call
 * whose tool the agent does not name structurally is `at-server` — the
 * server makes the per-tool decision when the call arrives.
 */

export type ContextRequestOrigin = "context-server" | "claude-sdk" | "acp";

export type SessionContextRequest = {
  sessionId: string;
  /** Who is asking, for display and audit. Never part of the decision. Absent at the server, which serves a credential, not a provider. */
  provider?: AgentProviderId;
  origin: ContextRequestOrigin;
  /**
   * The context server the request is proven to target. Set by the context
   * server (it is the server) or by an adapter that attested it from the
   * agent's structure. Absent: not proven, refused.
   */
  serverName?: string;
  /** The TabDump tool, when the request names it structurally. */
  tool?: string;
  /** A workspace the request names, if it names one. */
  workspaceId?: string;
};

/** What the runtime established for the session. Never from the request. */
export type ContextAuthority = {
  sessionId: string;
  workspaceId: string;
  serverName: string;
  capabilities: readonly SessionContextCapability[];
};

export type ContextDenial =
  | "no_session"
  | "wrong_session"
  | "unattested"
  | "wrong_workspace"
  | "unknown_tool"
  | "not_permitted";

export type ContextDecision =
  | {
      allowed: true;
      access: "read" | "write" | "per-tool";
      capability?: SessionContextCapability;
      approval: "none" | "every-time" | "at-server";
    }
  | { allowed: false; reason: ContextDenial };

export function authorizeContextRequest(
  request: SessionContextRequest,
  authority: ContextAuthority | undefined
): ContextDecision {
  if (!authority) return { allowed: false, reason: "no_session" };
  if (request.sessionId !== authority.sessionId) return { allowed: false, reason: "wrong_session" };
  if (request.serverName === undefined || request.serverName !== authority.serverName) {
    return { allowed: false, reason: "unattested" };
  }
  if (request.workspaceId !== undefined && request.workspaceId !== authority.workspaceId) {
    return { allowed: false, reason: "wrong_workspace" };
  }

  if (request.tool === undefined) {
    // Only an agent-level answer can lack the tool, and only for an adapter
    // whose agent does not name it. The server decides the tool itself.
    if (request.origin === "context-server") return { allowed: false, reason: "unknown_tool" };
    return authority.capabilities.length > 0
      ? { allowed: true, access: "per-tool", approval: "at-server" }
      : { allowed: false, reason: "not_permitted" };
  }

  if (!isSessionContextTool(request.tool)) return { allowed: false, reason: "unknown_tool" };
  const capability = SESSION_TOOL_CAPABILITY[request.tool];
  if (!authority.capabilities.includes(capability)) return { allowed: false, reason: "not_permitted" };
  return isWriteCapability(capability)
    ? { allowed: true, access: "write", capability, approval: "every-time" }
    : { allowed: true, access: "read", capability, approval: "none" };
}

/** The tools an authority permits — what an agent that pre-allows tools may pre-allow, and what the server registers. */
export function contextToolsFor(capabilities: readonly SessionContextCapability[]): SessionContextTool[] {
  return SESSION_CONTEXT_TOOLS.filter((tool) => capabilities.includes(SESSION_TOOL_CAPABILITY[tool]));
}
