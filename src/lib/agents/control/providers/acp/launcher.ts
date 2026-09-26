import type { AcpTransport } from "./rpc";

/**
 * How the ACP adapter obtains a connection to an agent — and nothing else.
 *
 * The adapter never names a binary, an argument or an environment variable.
 * It asks for a transport, optionally rooted in the authorized project's
 * directory, and a launcher built server-side in `lib/agents/launch/` decides
 * what that means for this provider from a fixed allowlist. That split is
 * what keeps every process concern out of the pure control plane, and what
 * makes "no argv from user text" true by construction: there is no parameter
 * here a user's words could reach.
 */

export type AcpLaunchRequest = {
  /**
   * The authorized project's root, already validated by the service and
   * revalidated by the launcher. Absent means an empty, private working
   * directory the launcher creates and removes.
   */
  projectPath?: string;
  /**
   * The session's context server name (Phase J.4), for an agent whose launch
   * entry limits a session to that one MCP server (`AcpContextIdentity`).
   * Minted by the runtime, validated by the launcher against
   * `CONTEXT_SERVER_NAME_PATTERN`; never text anyone typed.
   */
  contextServerName?: string;
};

export type AcpLaunchResult =
  | {
      ok: true;
      transport: AcpTransport;
      /** The absolute directory the agent was started in. ACP requires one on `session/new`. */
      cwd: string;
      /** Releases anything the launch held beyond the process — a scratch directory. */
      release(): void;
    }
  | { ok: false; reason: "not-installed" | "failed" };

export type AcpLauncher = (request: AcpLaunchRequest) => Promise<AcpLaunchResult>;

/**
 * A Hubble MCP server entry for `session/new` (ACP's HTTP MCP server shape).
 * Built by the adapter from the session's context server (Phase J.3); lives
 * as long as the session's credential does.
 */
export type AcpMcpServerEntry = {
  type: "http";
  name: string;
  url: string;
  headers: readonly { name: string; value: string }[];
};


/**
 * How Hubble stays the one that approves what an ACP agent does (Phase J.2).
 *
 * ACP agents have session *modes*, and in most of them the agent approves its
 * own actions. So each agent's launch entry says — from the agent's source,
 * not its mode names — which modes ask before **every** privileged action, or
 * that none does. The adapter enforces it: a session starts only in an asking
 * mode, and an agent that leaves one mid-session is stopped.
 */
export type AcpApprovalPolicy =
  /** Modes in which the agent asks before editing, deleting, running or fetching anything, in order of preference. */
  | { kind: "asking-mode"; modeIds: readonly string[] }
  /** The agent has no such mode. No session is started with it. One sentence, shown to the user. */
  | { kind: "unavailable"; reason: string };

/**
 * How Hubble tells an ACP agent's calls to the session's context server apart
 * from every other tool (Phase J.4) — verified from each agent's source.
 *
 * ACP's `session/request_permission` names no MCP server, and Hubble never
 * matches a tool name or title. So an agent can be handed the context server
 * only when two *structural* facts hold together:
 *
 *   1. **Exclusivity.** A launch flag (`allowlistFlag`, given the session's
 *      per-session server name) makes the context server the only MCP server
 *      the agent will load in that process — no user, extension or
 *      administrator server can join it.
 *   2. **A typed MCP marker.** The agent's permission request for an MCP call
 *      carries option ids that only its MCP confirmations carry
 *      (`mcpConfirmationOptionIds`, all required). They are built by the
 *      agent's code — not by the model, not by a server.
 *
 * Together: the request is an MCP call, and the only MCP server is Hubble's.
 * A request missing the marker is an ordinary tool and is refused as one.
 * An agent with neither is `unavailable`: its sessions start without context.
 */
export type AcpContextIdentity =
  | {
      kind: "exclusive-mcp";
      allowlistFlag: string;
      mcpConfirmationOptionIds: readonly string[];
    }
  | { kind: "unavailable"; reason: string };
