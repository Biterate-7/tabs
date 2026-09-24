import type { AgentControlAdapter } from "./types";

/**
 * How an adapter lets go of one session's resources when the host forgets it
 * (Phase J.2).
 *
 * ## Why this exists
 *
 * The host forgets a session in two places — `dispose_session`, and
 * `disconnect_provider` for every session of that agent — and in both it
 * cancels the run first. For an agent whose session *is* a process (every ACP
 * agent: one process per session), cancelling a run leaves that process alive
 * and ready for the next prompt, which is right while the session exists and
 * a leak once nothing can reach it. The process was only reclaimed when the
 * whole runtime shut down.
 *
 * ## Why an extension, like `approval-details.ts` and `authentication.ts`
 *
 * The base contract reads the same for every provider. An adapter with
 * nothing per session to release does not implement this, and the host
 * checks for it structurally rather than by provider.
 */
export type SessionReleasingAdapter = AgentControlAdapter & {
  /** Ends the session and releases what it holds — its process, its scratch directory, its MCP token. Idempotent. */
  releaseSession(sessionId: string): void;
};

export function hasSessionRelease(adapter: AgentControlAdapter): adapter is SessionReleasingAdapter {
  return typeof (adapter as Partial<SessionReleasingAdapter>).releaseSession === "function";
}
