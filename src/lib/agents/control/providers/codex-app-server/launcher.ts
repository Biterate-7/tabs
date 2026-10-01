import type { AcpTransport } from "../acp/rpc";

/**
 * How the Codex adapter obtains a connection to `codex app-server` — and
 * nothing else. The same split as ACP's launcher (../acp/launcher.ts): the
 * adapter never names a binary, an argument, an environment variable or a
 * settings folder; a launcher built server-side in `lib/agents/launch/`
 * decides all of that from the fixed allowlist.
 *
 * Unlike an ACP launch there is no context-server argument: Codex is handed
 * the session's context server inside `thread/start`, over its stdin, so the
 * process is started identically for every session.
 */

export type AppServerLaunchRequest = {
  /** The authorized project's root, revalidated by the launcher. Absent: a private scratch directory. */
  projectPath?: string;
};

export type AppServerLaunchFailure =
  /** No allowlisted executable found. */
  | "not-installed"
  /** It could not be started. */
  | "failed"
  /**
   * Hubble's Codex folder is unusable for a safe launch — it cannot be
   * written, or it holds approval rules that would let commands run unasked.
   */
  | "unsafe-home";

export type AppServerLaunchResult =
  | {
      ok: true;
      transport: AcpTransport;
      /** The absolute directory Codex was started in. */
      cwd: string;
      release(): void;
    }
  | { ok: false; reason: AppServerLaunchFailure };

export type AppServerLauncher = (request: AppServerLaunchRequest) => Promise<AppServerLaunchResult>;

/**
 * Runs the agent's own sign-in for one allowlisted method and waits for the
 * person to finish it in their browser. Resolves `completed` when the sign-in
 * program says it finished, `failed` when it says it did not (cancelled,
 * refused), `timeout` when nobody finished it in time.
 */
export type AppServerLogin = (methodId: string) => Promise<"completed" | "failed" | "timeout" | "unavailable">;
