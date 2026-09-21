import { NO_CAPABILITIES } from "./capabilities";
import { controlError, controlFailure } from "./types";
import type {
  AgentControlAdapter,
  ControlResult,
  ControlStatus,
  ControlStatusListener,
  ControlUnsubscribe,
  SessionHandle,
} from "./types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * A control adapter that is registered, described, and honest about doing
 * nothing.
 *
 * ## Why this is a real implementation rather than a stub
 *
 * The temptation in a foundation phase is to write adapters that "work" by
 * returning plausible values, so the plumbing can be demonstrated. This module
 * exists to make that impossible for the providers that are not built yet.
 *
 * It genuinely satisfies `AgentControlAdapter` — it has a provider, a status,
 * a lifecycle, listeners and disposal, and the registry treats it exactly like
 * any other — but:
 *
 *   - it declares `NO_CAPABILITIES`, so the service refuses every operation
 *     *before* reaching it;
 *   - every method returns `unsupported` anyway, so an operation that somehow
 *     did reach it still cannot succeed;
 *   - there is **no code path that emits an event**, so no fabricated
 *     activity can ever appear. The failure mode is structural rather than
 *     conventional: no amount of UI work could make this produce a message,
 *     a tool call, or a file change.
 *
 * ## What replacing one looks like
 *
 * A real adapter is a new file beside this one that implements the same
 * interface for real and declares the capabilities it actually has. Nothing
 * in the registry, the service, the permission layer, the approval broker or
 * any future UI changes — which is the property the whole plane exists to
 * have.
 */

export type UnimplementedAdapterOptions = {
  provider: AgentProviderId;
  /**
   * The one safe sentence explaining why this cannot drive an agent yet.
   *
   * Required rather than defaulted. A generic "not supported" is the start of
   * exactly the vagueness this design is meant to remove: a user who selects
   * an agent deserves to learn in one line what is missing.
   */
  detail: string;
  /**
   * Whether the gap is something the user could close.
   *
   * `unavailable` means they cannot — TabDump has not built it. That is the
   * truthful answer for every provider in Phase B, and it is the default.
   * `configuration_required` would mean the user must supply something, and
   * no adapter here is in that state yet.
   */
  kind?: "unavailable" | "configuration_required";
  now?: () => number;
};

export function createUnimplementedControlAdapter(
  options: UnimplementedAdapterOptions
): AgentControlAdapter {
  const now = options.now ?? (() => Date.now());
  const kind = options.kind ?? "unavailable";
  const listeners = new Set<ControlStatusListener>();

  const status: ControlStatus = {
    kind,
    since: now(),
    detail: options.detail,
    lastError: controlError("unsupported"),
  };

  /** Returned by every operation. One value, so no caller can find a path that succeeds. */
  function refuse<T>(): Promise<ControlResult<T>> {
    return Promise.resolve(controlFailure<T>("unsupported"));
  }

  return {
    provider: options.provider,

    // The empty set is the load-bearing part. The service checks capabilities
    // before dispatch, so in practice nothing below is ever reached.
    getCapabilities: () => NO_CAPABILITIES,

    getConnectionStatus: () => status,

    // Connecting does not move the status. There is nothing to connect to, and
    // a status that briefly said "connected" would be the single most
    // misleading thing this module could do.
    connect: () => refuse<ControlStatus>(),

    disconnect: () => Promise.resolve(),

    createSession: () => refuse<SessionHandle>(),

    resumeSession: () => refuse<SessionHandle>(),

    sendMessage: () => refuse<void>(),

    cancelRun: () => refuse<void>(),

    respondToApproval: () => refuse<void>(),

    // Accepts a listener and never calls it. Returning a working unsubscribe
    // keeps callers uniform; there is deliberately no way to feed this.
    subscribeToEvents: () => () => {},

    watchStatus(listener: ControlStatusListener): ControlUnsubscribe {
      listeners.add(listener);
      // Delivered once so a consumer renders the truthful state immediately
      // rather than sitting on a default until a change that never comes.
      listener(status);
      return () => listeners.delete(listener);
    },

    dispose() {
      listeners.clear();
    },
  };
}
