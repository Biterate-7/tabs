import type { AgentConnector, AgentProviderId, ProviderDescriptor } from "./types";

/**
 * Which providers exist, and how to build a connector for one.
 *
 * Deliberately two separate things:
 *
 *   - a **descriptor**, which is static metadata and is always available —
 *     the settings UI can list every provider, with its capabilities and what
 *     it would need, before anything is connected or even constructed;
 *   - a **factory**, which is called at most once per provider, lazily, and
 *     only when a connector is actually wanted.
 *
 * Splitting them is what lets the UI be honest with zero cost: listing five
 * providers does not construct five connectors, start five timers, or read
 * five configuration files.
 *
 * Nothing here knows *which* providers exist. That single provider-aware
 * decision lives in ./catalog.ts, which is the only module in the connector
 * layer that names one — everything else, including the manager, works
 * against whatever it was given.
 */

export type ConnectorFactory = () => AgentConnector;

export type ConnectorRegistration = {
  descriptor: ProviderDescriptor;
  create: ConnectorFactory;
};

export type RegistryFailureReason = "duplicate-provider" | "unknown-provider" | "descriptor-mismatch";

export type RegistryFailure = { ok: false; reason: RegistryFailureReason };

export type ConnectorRegistry = {
  /**
   * Adds a provider.
   *
   * Refuses a provider that is already registered rather than replacing it:
   * a silent overwrite would leave whichever module registered first holding
   * a connector nobody else can reach, and there is no case where two
   * registrations for one provider is the intent.
   */
  register(registration: ConnectorRegistration): { ok: true } | RegistryFailure;
  /** Every descriptor, in registration order. Constructs nothing. */
  describeAll(): ProviderDescriptor[];
  describe(provider: AgentProviderId): ProviderDescriptor | undefined;
  has(provider: AgentProviderId): boolean;
  /**
   * The connector for a provider, constructing it on first use.
   *
   * Memoised, so every caller shares one connector per provider — which is
   * what keeps two surfaces (the settings page and the workspace) from each
   * running their own poll loop against the same machine.
   */
  get(provider: AgentProviderId): AgentConnector | undefined;
  /** Connectors already constructed. Used by teardown, which must not construct one in order to dispose it. */
  instantiated(): AgentConnector[];
  /** Disposes every constructed connector and forgets it. Registrations survive. */
  disposeAll(): void;
};

export function createConnectorRegistry(): ConnectorRegistry {
  const registrations = new Map<AgentProviderId, ConnectorRegistration>();
  const instances = new Map<AgentProviderId, AgentConnector>();

  return {
    register(registration) {
      const { descriptor, create } = registration;
      if (registrations.has(descriptor.provider)) return { ok: false, reason: "duplicate-provider" };
      registrations.set(descriptor.provider, { descriptor, create });
      return { ok: true };
    },

    describeAll: () => [...registrations.values()].map((entry) => entry.descriptor),

    describe: (provider) => registrations.get(provider)?.descriptor,

    has: (provider) => registrations.has(provider),

    get(provider) {
      const existing = instances.get(provider);
      if (existing) return existing;

      const registration = registrations.get(provider);
      if (!registration) return undefined;

      const connector = registration.create();
      instances.set(provider, connector);
      return connector;
    },

    instantiated: () => [...instances.values()],

    disposeAll() {
      for (const connector of instances.values()) connector.dispose();
      instances.clear();
    },
  };
}
