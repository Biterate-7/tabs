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
 * A TabDump MCP server entry for `session/new` (ACP's HTTP MCP server shape).
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
 * How TabDump stays the one that approves what an ACP agent does (Phase J.2).
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
