import type { AgentPermissionGrant } from "./permissions";
import type { AgentProject } from "./projects";
import type { AgentControlAdapter, ControlResult, SessionHandle } from "./types";

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

/**
 * An adapter whose provider does not push, and must be asked.
 *
 * ## Why this exists at all
 *
 * A local provider is a child process of the thing listening to it: its
 * output arrives as it is produced, and `subscribeToEvents` is the whole
 * story. A *remote* provider is a process inside a microVM, and the thing
 * listening to it is a serverless function that did not exist a moment ago
 * and will not exist a moment later. There is no socket to hold open across
 * that gap, and pretending otherwise is how a system ends up with an event
 * stream that works on a developer's machine and silently delivers nothing
 * in production.
 *
 * So a remote adapter is *drained*: asked, on each request that cares, for
 * everything the provider has said since the last cursor. What it emits then
 * flows through exactly the same `subscribeToEvents` path a local adapter
 * uses, gets the same sequence numbers from the same journal, and is
 * indistinguishable downstream — which is the requirement that the UI must
 * not be able to tell where an event came from.
 *
 * Optional and structural, for the same reason the two above are: a local
 * adapter has nothing to drain, and declaring a no-op method forever would
 * make "does this provider push" a question you answer by calling something.
 */
export type DrainableAdapter = AgentControlAdapter & {
  /**
   * Collects whatever the provider has produced since the last call.
   *
   * Emits through the adapter's own event stream rather than returning
   * events, so that a drained event and a pushed one take the same path and
   * no consumer needs a second code path for remote sessions.
   */
  drainSession(sessionId: string): Promise<void>;
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

/**
 * What a caller asks for when picking a session back up.
 *
 * Provider-neutral by construction — a session id, an already-resolved
 * project and the grant that project carries. There is nothing here a
 * provider could read as an instruction, and in particular no path, no
 * process id and no sandbox handle: the adapter resolves those from its own
 * durable state, which is the only place they are allowed to live.
 */
export type ReattachSessionRequest = {
  sessionId: string;
  project?: AgentProject;
  permissions: AgentPermissionGrant;
};

/**
 * An adapter whose provider keeps running when this process does not.
 *
 * Declared structurally, and absent from every local adapter on purpose. The
 * question "can a session be picked up after a restart" has a different
 * answer for a child process than for a microVM, and it must be answered by
 * the adapter that knows rather than assumed by the layer above.
 */
export type ReattachingAdapter = AgentControlAdapter & {
  reattachSession(request: ReattachSessionRequest): Promise<ControlResult<SessionHandle>>;
};

export function canDrain(adapter: AgentControlAdapter): adapter is DrainableAdapter {
  return typeof (adapter as Partial<DrainableAdapter>).drainSession === "function";
}

export function canReattachSession(
  adapter: AgentControlAdapter
): adapter is ReattachingAdapter {
  return typeof (adapter as Partial<ReattachingAdapter>).reattachSession === "function";
}

/**
 * Drains an adapter that needs draining, and does nothing to one that does
 * not.
 *
 * Failures are swallowed on purpose, and this is the one place in the control
 * plane where that is the right call. A drain is a *read* of work that has
 * already happened: the sandbox is still running, its log is still on disk,
 * and the next drain picks up from the same cursor. Turning a transient read
 * failure into a failed command would take a session that is working fine and
 * report it to the user as broken.
 */
export async function drainAdapter(
  adapter: AgentControlAdapter,
  sessionId: string
): Promise<void> {
  if (!canDrain(adapter)) return;
  await adapter.drainSession(sessionId).catch(() => undefined);
}
