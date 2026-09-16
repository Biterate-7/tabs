import { logConnectorEvent } from "./observability";
import { isLiveConnectorStatus } from "./types";
import type {
  AgentProviderId,
  ConnectorError,
  ConnectorObservation,
  ConnectorObserver,
  ConnectorStatus,
  ConnectorStatusKind,
  ConnectorStatusListener,
  ConnectorUnsubscribe,
} from "./types";

/**
 * The bookkeeping every connector needs and none should reimplement.
 *
 * Status, status listeners, observation observers, disposal — mechanical,
 * easy to get subtly wrong, and wrong in ways that surface as leaks rather
 * than as failures. Centralising it means a new provider adapter is only the
 * part that is genuinely provider-specific: how to reach the thing, and how
 * to turn what it says into observations.
 *
 * The three mistakes this exists to make impossible:
 *
 *   - **notifying a listener that has detached.** Every fan-out iterates a
 *     snapshot, so a listener that unsubscribes while being notified does not
 *     mutate the set mid-iteration.
 *   - **emitting after disposal.** Once disposed, `emit` and `setStatus` are
 *     no-ops. A provider with an in-flight request that resolves after
 *     teardown cannot push into a torn-down app.
 *   - **keeping listeners across disposal.** `dispose` drops both sets, so
 *     nothing holds a reference to an unmounted consumer's closure.
 */

export type ConnectorCore = {
  getStatus(): ConnectorStatus;
  /**
   * Moves to a new state and notifies watchers.
   *
   * Ignores a transition to the state it is already in with nothing else
   * changed, so a poll loop reporting "still connected" every few seconds
   * does not wake every listener in the app on every tick.
   */
  setStatus(kind: ConnectorStatusKind, patch?: StatusPatch): void;
  /** Records a failure without changing the state's kind — for a failed poll inside a healthy connection. */
  noteError(error: ConnectorError): void;
  /** Delivers observations and stamps `lastObservationAt`. */
  emit(observations: ConnectorObservation[]): void;
  subscribe(observer: ConnectorObserver): ConnectorUnsubscribe;
  watchStatus(listener: ConnectorStatusListener): ConnectorUnsubscribe;
  /** True once `dispose` has run. Providers check it before acting on a late async result. */
  isDisposed(): boolean;
  dispose(): void;
  /** Whether this connector has ever reached `connected` — what makes a retry a *re*connect. */
  hasConnected(): boolean;
};

export type StatusPatch = {
  /** `null` clears a previously recorded error; `undefined` leaves it as it is. */
  error?: ConnectorError | null;
  detail?: string | null;
};

export type ConnectorCoreOptions = {
  provider: AgentProviderId;
  initialKind: ConnectorStatusKind;
  initialDetail?: string;
  /** Clock, injected so tests need no timer mocking. */
  now: () => number;
};

export function createConnectorCore(options: ConnectorCoreOptions): ConnectorCore {
  const { provider, now } = options;

  let status: ConnectorStatus = options.initialDetail
    ? { kind: options.initialKind, since: now(), detail: options.initialDetail }
    : { kind: options.initialKind, since: now() };

  let disposed = false;
  let everConnected = false;

  const observers = new Set<ConnectorObserver>();
  const statusListeners = new Set<ConnectorStatusListener>();

  function notifyStatus(): void {
    for (const listener of [...statusListeners]) listener(status);
  }

  return {
    getStatus: () => status,

    hasConnected: () => everConnected,

    isDisposed: () => disposed,

    setStatus(kind, patch) {
      if (disposed) return;

      const nextError =
        patch?.error === null ? undefined : (patch?.error ?? status.lastError);
      const nextDetail =
        patch?.detail === null ? undefined : (patch?.detail ?? status.detail);

      // A repeat of the current state with nothing new to say is not a
      // change. Without this, a poll loop would re-render every consumer on
      // every tick simply for staying connected.
      if (kind === status.kind && nextError === status.lastError && nextDetail === status.detail) {
        return;
      }

      if (kind === "connected") everConnected = true;

      status = {
        kind,
        since: now(),
        // Carried across transitions: when the last observation arrived is a
        // property of the connector, not of the state it happens to be in.
        lastObservationAt: status.lastObservationAt,
        ...(nextError ? { lastError: nextError } : {}),
        ...(nextDetail ? { detail: nextDetail } : {}),
      };

      logConnectorEvent({
        event:
          kind === "connected"
            ? "connector.connected"
            : kind === "connecting"
              ? "connector.connecting"
              : kind === "reconnecting"
                ? "connector.reconnecting"
                : kind === "error"
                  ? "connector.error"
                  : "connector.disconnected",
        provider,
        status: kind,
        ...(nextError ? { error: nextError.code } : {}),
      });

      notifyStatus();
    },

    noteError(error) {
      if (disposed) return;
      if (status.lastError?.code === error.code) return;

      status = { ...status, lastError: error };
      logConnectorEvent({ event: "connector.error", provider, status: status.kind, error: error.code });
      notifyStatus();
    },

    emit(observations) {
      if (disposed || observations.length === 0) return;

      status = { ...status, lastObservationAt: now() };
      logConnectorEvent({ event: "connector.observations", provider, count: observations.length });

      for (const observer of [...observers]) observer(observations);
      // Watchers learn that something arrived, which is what drives the
      // "last observation" line without a second subscription.
      notifyStatus();
    },

    subscribe(observer) {
      if (disposed) return () => {};
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },

    watchStatus(listener) {
      if (disposed) return () => {};
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      observers.clear();
      statusListeners.clear();
    },
  };
}

/** The status a fresh connection attempt should show: first time round it is connecting, afterwards reconnecting. */
export function attemptKind(core: ConnectorCore): ConnectorStatusKind {
  return core.hasConnected() ? "reconnecting" : "connecting";
}

/** Whether a connector is currently holding resources, from the outside. */
export function isConnectorLive(status: ConnectorStatus): boolean {
  return isLiveConnectorStatus(status.kind);
}
