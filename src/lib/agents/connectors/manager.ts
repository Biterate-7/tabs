import { deriveConnectorHealth } from "./health";
import { logConnectorEvent } from "./observability";
import {
  isConnectorEnabled,
  loadConnectorConfig,
  saveConnectorConfig,
  setConnectorEnabled,
} from "./persistence";
import { createConnectorRegistry } from "./registry";
import { connectorError, isLiveConnectorStatus } from "./types";
import type { ConnectorConfigState } from "./persistence";
import type { ConnectorRegistration, ConnectorRegistry } from "./registry";
import type {
  AgentConnector,
  AgentProviderId,
  ConnectorHealth,
  ConnectorObservation,
  ConnectorObserver,
  ConnectorStatus,
  ConnectorStatusListener,
  ConnectorUnsubscribe,
  ProviderDescriptor,
} from "./types";

/**
 * The connector layer's front door.
 *
 * One object owns every connector's lifecycle, so the rest of the app never
 * holds one directly. That matters more than it looks: two surfaces want this
 * data at once — the settings page, which lists and toggles connectors, and
 * the workspace, which consumes their observations — and if each constructed
 * its own connector there would be two poll loops reading the user's machine
 * and two sets of runs disagreeing about what happened. Going through the
 * manager makes one connector per provider a structural fact rather than a
 * discipline.
 *
 * What it adds over the registry:
 *
 *   - **intent, persisted.** Which providers the user asked for, restored on
 *     load. Status is never restored — only the intent to connect.
 *   - **one merged observation stream**, already tagged by provider, so a
 *     consumer subscribes once rather than per connector.
 *   - **bounded reconnection.** A connector that fails is retried on a
 *     backoff, a fixed number of times, and then left alone.
 *   - **teardown that actually tears down.** Disposing the manager disposes
 *     every connector it built and drops every listener.
 *
 * What it deliberately does not add: any way to act on an external agent.
 * Nothing below can start, stop, prompt or cancel one, and `guard.test.ts`
 * fails the build if such a member appears.
 */

/** How many times a failed connector is retried before it is left in `error`. */
export const MAX_RECONNECT_ATTEMPTS = 4;

/** First retry delay. Each subsequent attempt doubles it. */
export const RECONNECT_BASE_DELAY_MS = 2_000;

/**
 * Ceiling on the backoff.
 *
 * With four attempts the delays are 2s, 4s, 8s, 16s — the cap is not reached
 * today, and exists so that raising the attempt count later cannot silently
 * turn into a connector that retries once an hour.
 */
export const RECONNECT_MAX_DELAY_MS = 30_000;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_DELAY_MS);
}

/** Everything a consumer needs to render one connector. Assembled from live state, never stored. */
export type ConnectorView = {
  descriptor: ProviderDescriptor;
  status: ConnectorStatus;
  health: ConnectorHealth;
  /** The user's persisted intent, which is not the same as being connected. */
  enabled: boolean;
};

export type ConnectorManagerOptions = {
  registrations?: ConnectorRegistration[];
  /** Clock, injected for tests. */
  now?: () => number;
  /** Timers, injected so tests need no fake-timer setup. */
  scheduler?: {
    setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
  /**
   * Whether to read and write the persisted configuration.
   *
   * Off in tests by default so a suite cannot leak intent into the next one,
   * and off automatically when there is no `window` — the manager is
   * constructible during server rendering and simply remembers nothing.
   */
  persist?: boolean;
};

export type ConnectorManager = {
  /** Registers a provider. Refuses a duplicate rather than replacing it. */
  register(registration: ConnectorRegistration): boolean;
  /** Every registered provider's static metadata. Constructs no connectors. */
  describeAll(): ProviderDescriptor[];
  /** A render-ready view per provider, in registration order. */
  list(): ConnectorView[];
  view(provider: AgentProviderId): ConnectorView | undefined;
  status(provider: AgentProviderId): ConnectorStatus | undefined;
  /** The connector itself, for a consumer that needs provider-specific extras (Claude's session list). */
  connector(provider: AgentProviderId): AgentConnector | undefined;

  /** Records the user's intent and connects. */
  connect(provider: AgentProviderId): Promise<ConnectorStatus | undefined>;
  /** Records the user's intent and disconnects. Cancels any pending retry. */
  disconnect(provider: AgentProviderId): void;

  /** Connects everything the user previously enabled. Called once, on load. */
  restore(): Promise<void>;

  /** Observations from every connected provider, merged. */
  subscribe(observer: ConnectorObserver): ConnectorUnsubscribe;
  /** Any connector's status change. */
  watchStatus(listener: ConnectorStatusListener): ConnectorUnsubscribe;

  /** Releases every timer, listener and connector. Idempotent. */
  dispose(): void;
};

export function createConnectorManager(
  options: ConnectorManagerOptions = {}
): ConnectorManager {
  const now = options.now ?? (() => Date.now());
  const scheduler = options.scheduler ?? {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const persist = options.persist ?? false;

  const registry: ConnectorRegistry = createConnectorRegistry();
  for (const registration of options.registrations ?? []) registry.register(registration);

  let config: ConnectorConfigState = persist
    ? loadConnectorConfig()
    : { version: 1, connectors: [] };

  const observers = new Set<ConnectorObserver>();
  const statusListeners = new Set<ConnectorStatusListener>();

  /** Per-provider teardown for the manager's own subscriptions to a connector. */
  const attachments = new Map<AgentProviderId, ConnectorUnsubscribe[]>();
  const retryTimers = new Map<AgentProviderId, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<AgentProviderId, number>();

  let disposed = false;

  function persistConfig(): void {
    if (persist) saveConnectorConfig(config);
  }

  function fanOutStatus(status: ConnectorStatus): void {
    for (const listener of [...statusListeners]) listener(status);
  }

  function fanOutObservations(observations: ConnectorObservation[]): void {
    for (const observer of [...observers]) observer(observations);
  }

  function cancelRetry(provider: AgentProviderId): void {
    const timer = retryTimers.get(provider);
    if (timer !== undefined) scheduler.clearTimeout(timer);
    retryTimers.delete(provider);
    retryAttempts.delete(provider);
  }

  /**
   * Schedules one retry, if there are any left.
   *
   * Bounded twice over: by the attempt count, and by the fact that a retry is
   * only ever scheduled from a status transition into `error` — so a
   * connector that keeps failing produces a finite series and then stops,
   * rather than a loop that hammers the user's machine forever.
   */
  function scheduleRetry(provider: AgentProviderId): void {
    if (disposed) return;
    if (retryTimers.has(provider)) return;

    const attempt = (retryAttempts.get(provider) ?? 0) + 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) return;
    retryAttempts.set(provider, attempt);

    logConnectorEvent({ event: "connector.reconnecting", provider, attempt });

    const timer = scheduler.setTimeout(() => {
      retryTimers.delete(provider);
      // The user may have disconnected while the timer was pending. Intent
      // wins: a retry must never resurrect a connector they turned off.
      if (disposed || !isConnectorEnabled(config, provider)) return;
      void registry.get(provider)?.connect();
    }, reconnectDelayMs(attempt));

    retryTimers.set(provider, timer);
  }

  /**
   * Subscribes the manager to a connector, once.
   *
   * Idempotent by the presence of an entry in `attachments`: connecting an
   * already-attached provider must not add a second observer, which would
   * deliver every observation twice and double-count everything downstream.
   */
  function attach(connector: AgentConnector): void {
    if (attachments.has(connector.provider)) return;

    const teardown: ConnectorUnsubscribe[] = [
      connector.subscribe((observations) => {
        if (disposed) return;
        fanOutObservations(observations);
      }),
      connector.watchStatus((status) => {
        if (disposed) return;

        if (status.kind === "error") {
          scheduleRetry(connector.provider);
        } else if (status.kind === "connected") {
          // A successful connection resets the budget, so a connector that
          // recovers is not one failure away from giving up permanently.
          cancelRetry(connector.provider);
        }

        fanOutStatus(status);
      }),
    ];

    attachments.set(connector.provider, teardown);
  }

  function detach(provider: AgentProviderId): void {
    for (const off of attachments.get(provider) ?? []) off();
    attachments.delete(provider);
  }

  function viewFor(connectorOrDescriptor: ProviderDescriptor): ConnectorView {
    const provider = connectorOrDescriptor.provider;
    // Reads an *existing* connector rather than constructing one: listing the
    // settings page must not instantiate five connectors.
    const existing = registry.instantiated().find((entry) => entry.provider === provider);
    const status: ConnectorStatus = existing?.getStatus() ?? { kind: "disconnected", since: 0 };

    const expectedIntervalMs = (existing as { expectedIntervalMs?: number } | undefined)
      ?.expectedIntervalMs;

    return {
      descriptor: connectorOrDescriptor,
      status,
      health: deriveConnectorHealth({ status, expectedIntervalMs, now: now() }),
      enabled: isConnectorEnabled(config, provider),
    };
  }

  /**
   * The one connect path.
   *
   * A named function rather than a method so that `restore` calls exactly
   * what a user's click calls — the intent is recorded, the manager attaches,
   * and any pending retry is cancelled, in the same order either way.
   */
  async function connectProvider(
    provider: AgentProviderId
  ): Promise<ConnectorStatus | undefined> {
    if (disposed) return undefined;

    const connector = registry.get(provider);
    if (!connector) return undefined;

    config = setConnectorEnabled(config, provider, true, now());
    persistConfig();

    cancelRetry(provider);
    attach(connector);

    try {
      return await connector.connect();
    } catch {
      // A connector that throws out of `connect` is a bug in that connector,
      // not a reason for the app to fall over. The code is all that is
      // recorded — never the caught value, which could carry provider text.
      return { kind: "error", since: now(), lastError: connectorError("unknown") };
    }
  }

  return {
    register(registration) {
      return registry.register(registration).ok;
    },

    describeAll: () => registry.describeAll(),

    list: () => registry.describeAll().map(viewFor),

    view(provider) {
      const descriptor = registry.describe(provider);
      return descriptor ? viewFor(descriptor) : undefined;
    },

    status(provider) {
      const descriptor = registry.describe(provider);
      return descriptor ? viewFor(descriptor).status : undefined;
    },

    connector: (provider) => registry.get(provider),

    connect: (provider) => connectProvider(provider),

    disconnect(provider) {
      config = setConnectorEnabled(config, provider, false, now());
      persistConfig();

      cancelRetry(provider);

      // Disconnect first, so the connector's own teardown runs while the
      // manager is still listening and the resulting `disconnected` status
      // reaches consumers. Detaching first would drop that last transition
      // and leave every UI showing the state before the click.
      registry.get(provider)?.disconnect();
      detach(provider);
    },

    async restore() {
      if (disposed) return;

      // Only what the user actually enabled. A provider they never touched is
      // not connected on their behalf, and nothing polls their machine
      // because an app started.
      const wanted = registry
        .describeAll()
        .map((descriptor) => descriptor.provider)
        .filter((provider) => isConnectorEnabled(config, provider));

      await Promise.all(wanted.map((provider) => connectProvider(provider)));
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

      for (const timer of retryTimers.values()) scheduler.clearTimeout(timer);
      retryTimers.clear();
      retryAttempts.clear();

      for (const provider of [...attachments.keys()]) detach(provider);

      // Disposes only what was constructed — listing providers never builds a
      // connector, so teardown must not build one in order to tear it down.
      registry.disposeAll();

      observers.clear();
      statusListeners.clear();
    },
  };
}

/** True while a provider is doing something that holds resources. */
export function isConnectorBusy(view: ConnectorView): boolean {
  return isLiveConnectorStatus(view.status.kind);
}
