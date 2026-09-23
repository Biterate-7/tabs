import { issueSessionMcpToken, revokeSessionMcpToken } from "@/lib/mcp/session-tokens";
import type { AcpMcpLinker } from "@/lib/agents/control/providers/acp/launcher";
import type { McpTokenStore } from "@/lib/mcp/tokens";

/**
 * Gives one agent session read access to the user's TabDump, for as long as
 * the session lives.
 *
 * The token exists in three places only: this closure, the request that
 * starts the agent's session, and the agent's memory. It is written to no
 * file, no config and no browser storage, and it is revoked when the session
 * is released. The header is assembled here, server-side, so the control
 * plane — which carries the entry opaquely — never holds a line that builds
 * one.
 *
 * Returns `undefined` rather than failing a session when a token cannot be
 * minted: TabDump tools are an addition to a session, not a precondition.
 */
export function createMcpLinker(options: {
  store: McpTokenStore;
  /** The TabDump MCP endpoint on this machine. Never taken from a request. */
  url: string;
  userId: string;
  agentName: string;
  now?: () => number;
}): AcpMcpLinker {
  const now = options.now ?? (() => Date.now());

  return async () => {
    const issued = await issueSessionMcpToken(options.store, {
      userId: options.userId,
      agentName: options.agentName,
      now: now(),
    }).catch(() => undefined);
    if (!issued) return undefined;

    let released = false;
    return {
      server: {
        type: "http",
        name: "tabdump",
        url: options.url,
        headers: [{ name: "Authorization", value: `Bearer ${issued.token}` }],
      },
      release() {
        if (released) return;
        released = true;
        void revokeSessionMcpToken(options.store, {
          userId: options.userId,
          tokenId: issued.tokenId,
          now: now(),
        }).catch(() => {
          // The token still expires on its own. A failed revoke shortens
          // nothing, and must not throw into a session's teardown.
        });
      },
    };
  };
}
