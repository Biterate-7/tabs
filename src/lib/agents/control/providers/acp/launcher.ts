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
 * A TabDump MCP server entry for `session/new`, prepared server-side.
 *
 * Opaque to the adapter: it is forwarded exactly as built, and the adapter has
 * no code that reads a header. It exists only for the life of one session and
 * `release` revokes whatever access it carried.
 */
export type AcpMcpServerEntry = {
  type: "http";
  name: string;
  url: string;
  headers: readonly { name: string; value: string }[];
};

export type AcpMcpLink = { server: AcpMcpServerEntry; release(): void };

/** Supplies a per-session TabDump MCP link, or nothing when this runtime cannot mint one. */
export type AcpMcpLinker = (request: { sessionId: string }) => Promise<AcpMcpLink | undefined>;
