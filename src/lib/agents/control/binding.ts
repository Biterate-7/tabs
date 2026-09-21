import type { AgentControlAdapter } from "./types";

/**
 * The two optional accessors a run-correlating adapter offers.
 *
 * ## Why optional, and why structural
 *
 * Neither is something every provider can do.
 *
 * `bindRun` tells an adapter which run its events belong to, so that
 * everything it emits afterwards carries the id. An adapter that emits no
 * events has nothing to bind.
 *
 * `providerSessionIdFor` reads the provider's own identity for a live
 * session. Some providers issue one and reveal it on the wire; some issue one
 * only on request; some issue none at all. Putting it on
 * `AgentControlAdapter` would make every adapter declare a method that
 * returns `undefined` forever, and would turn "does this provider have a
 * resumable identity" into a question you answer by calling something.
 *
 * So both are structural, checked before use, exactly as
 * ./approval-details.ts does for the approval detail accessor. The checks
 * live here rather than in the runtime module because they are statements
 * about the *adapter contract*, and the runtime is a consumer of that
 * contract rather than its author.
 *
 * ## What `bindRun` is not
 *
 * It is not how a run is created. The control plane does not mint domain
 * runs — the agent domain owns those, and a second minter would be a second
 * representation of the same work. `bindRun` only tells an adapter an id that
 * already exists, so that its events can be joined to it.
 */

/** An adapter whose events can be attributed to a run. */
export type RunBindingAdapter = AgentControlAdapter & {
  bindRun(sessionId: string, runId: string): void;
};

/** An adapter that can report the provider's own session identity. */
export type ProviderSessionAdapter = AgentControlAdapter & {
  providerSessionIdFor(sessionId: string): string | undefined;
};

export function canBindRun(adapter: AgentControlAdapter): adapter is RunBindingAdapter {
  return typeof (adapter as Partial<RunBindingAdapter>).bindRun === "function";
}

export function reportsProviderSession(
  adapter: AgentControlAdapter
): adapter is ProviderSessionAdapter {
  return (
    typeof (adapter as Partial<ProviderSessionAdapter>).providerSessionIdFor === "function"
  );
}

/**
 * Binds a run if the adapter can be bound, and says whether it was.
 *
 * The boolean matters: an adapter that cannot bind produces events with no
 * run id, and a caller that assumed otherwise would build correlation on
 * evidence that is not there.
 */
export function bindRunTo(
  adapter: AgentControlAdapter,
  sessionId: string,
  runId: string
): boolean {
  if (!canBindRun(adapter)) return false;
  adapter.bindRun(sessionId, runId);
  return true;
}

/** The provider's own session id, or `undefined` when the adapter does not report one. */
export function providerSessionIdOf(
  adapter: AgentControlAdapter,
  sessionId: string
): string | undefined {
  if (!reportsProviderSession(adapter)) return undefined;
  return adapter.providerSessionIdFor(sessionId);
}
