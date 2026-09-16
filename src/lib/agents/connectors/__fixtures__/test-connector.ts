import { createConnectorCore } from "../base";
import { connectorError, NO_CAPABILITIES } from "../types";
import type { ConnectorCore } from "../base";
import type {
  AgentConnector,
  AgentProviderId,
  ConnectorCapabilities,
  ConnectorErrorCode,
  ConnectorObservation,
  ProviderDescriptor,
} from "../types";

/**
 * A connector a test drives by hand.
 *
 * Built on the real `createConnectorCore`, so the status transitions,
 * listener fan-out and disposal behaviour under test are the production ones
 * — a hand-rolled fake would pass while the code it stands in for was broken.
 * What is faked is only the part a test cannot have: an actual provider.
 *
 * It observes nothing and cannot be made to. There is no `start`, no `exec`
 * and no way to add one: if a mock ever needed a control method to be useful,
 * that would be a sign the contract had drifted, not that the mock was
 * lacking.
 */
export type TestConnector = AgentConnector & {
  /** Delivers observations to whatever is subscribed, as a real connector would. */
  emit(observations: ConnectorObservation[]): void;
  /** Drives the connector into an error state, the way a failed poll would. */
  fail(code?: ConnectorErrorCode): void;
  /** Settles a connect that was told to hang. */
  settle(): void;
  /** How many observers are attached — lets a test prove unsubscribe detaches. */
  readonly observerCount: number;
  /** How many times `connect` has been called, for reconnection assertions. */
  readonly connectCount: number;
  readonly disposed: boolean;
};

export type TestConnectorOptions = {
  provider?: AgentProviderId;
  displayName?: string;
  capabilities?: Partial<ConnectorCapabilities>;
  /** What connecting settles into. Defaults to a successful connection. */
  connectTo?: "connected" | "error" | "unavailable" | "configuration_required";
  now?: () => number;
};

export function createTestConnector(options: TestConnectorOptions = {}): TestConnector {
  const provider = options.provider ?? "custom";
  const now = options.now ?? (() => Date.now());

  const descriptor: ProviderDescriptor = {
    provider,
    displayName: options.displayName ?? "Test agent",
    summary: "A connector that exists only in tests.",
    capabilities: { ...NO_CAPABILITIES, ...options.capabilities },
  };

  const core: ConnectorCore = createConnectorCore({
    provider,
    initialKind: "disconnected",
    now,
  });

  let observerCount = 0;
  let connectCount = 0;
  let disposed = false;
  let pending: (() => void) | null = null;

  return {
    provider,
    descriptor,

    getStatus: () => core.getStatus(),

    async connect() {
      connectCount += 1;
      const target = options.connectTo ?? "connected";

      if (target === "error") {
        core.setStatus("error", { error: connectorError("unreachable") });
      } else if (target === "connected") {
        core.setStatus("connected", { error: null });
      } else {
        core.setStatus(target, { error: connectorError("unsupported"), detail: "Not here." });
      }

      return core.getStatus();
    },

    disconnect() {
      core.setStatus("disconnected", { error: null, detail: null });
    },

    subscribe(observer) {
      observerCount += 1;
      const off = core.subscribe(observer);
      return () => {
        observerCount -= 1;
        off();
      };
    },

    watchStatus: (listener) => core.watchStatus(listener),

    emit: (observations) => core.emit(observations),

    fail(code = "unreachable") {
      core.setStatus("error", { error: connectorError(code) });
    },

    settle() {
      pending?.();
      pending = null;
    },

    get observerCount() {
      return observerCount;
    },
    get connectCount() {
      return connectCount;
    },
    get disposed() {
      return disposed;
    },

    dispose() {
      disposed = true;
      core.dispose();
    },
  };
}

/** An observation with only the fields the domain requires, for tests that care about routing rather than content. */
export function testObservation(
  over: Partial<ConnectorObservation> & { provider?: string } = {}
): ConnectorObservation {
  return {
    provider: "custom",
    externalId: "session-1",
    ...over,
  };
}
