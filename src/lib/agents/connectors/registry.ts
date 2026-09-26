import type { AgentControlAdapter } from "@/lib/agents/control/types";
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
 *
 * ## Two planes, one registry
 *
 * A provider has an **observation** adapter (`AgentConnector`, read-only) and
 * may have a **control** adapter (`AgentControlAdapter`, separately
 * permissioned). This registry holds both, because a second registry would
 * mean two places to ask "which providers exist" and eventually two answers.
 *
 * They stay structurally apart despite sharing a home:
 *
 *   - `createControl` is **optional**. A provider with no control adapter is
 *     ordinary, not broken — it is observable and not drivable, which is the
 *     true state of every provider Hubble ships today.
 *   - They are constructed independently, so asking for a connector never
 *     builds a control adapter, and a provider that is only being watched
 *     never instantiates the plane that could act.
 *   - Nothing in this file can invoke either of them. It hands them out.
 */

export type ConnectorFactory = () => AgentConnector;

export type ControlFactory = () => AgentControlAdapter;

export type ConnectorRegistration = {
  descriptor: ProviderDescriptor;
  /** Builds the read-only observation adapter. */
  create: ConnectorFactory;
  /**
   * Builds the control adapter, for a provider that has one.
   *
   * Optional on purpose. Absent means Hubble can watch this provider and
   * cannot drive it — and a caller asking for control gets `undefined`, which
   * every consumer must handle as "not drivable" rather than as an error.
   */
  createControl?: ControlFactory;
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
  /**
   * The control adapter for a provider, constructing it on first use.
   *
   * `undefined` for a provider that declares none — which is not an error and
   * must not be treated as one. Memoised separately from the connector, so a
   * surface that only watches never builds the plane that could act.
   */
  control(provider: AgentProviderId): AgentControlAdapter | undefined;
  /** Whether this provider has a control adapter at all. Constructs nothing. */
  hasControl(provider: AgentProviderId): boolean;
  /** Control adapters already constructed, for teardown. */
  instantiatedControl(): AgentControlAdapter[];
  /** Disposes every constructed connector and control adapter, and forgets them. Registrations survive. */
  disposeAll(): void;
};

export function createConnectorRegistry(): ConnectorRegistry {
  const registrations = new Map<AgentProviderId, ConnectorRegistration>();
  const instances = new Map<AgentProviderId, AgentConnector>();
  const controlInstances = new Map<AgentProviderId, AgentControlAdapter>();

  return {
    register(registration) {
      const { descriptor } = registration;
      if (registrations.has(descriptor.provider)) return { ok: false, reason: "duplicate-provider" };
      // Stored whole, rather than rebuilt from the fields this function
      // happens to name. An earlier version destructured `{ descriptor,
      // create }` and rebuilt from those two, which silently dropped
      // `createControl` — a provider registered with a control adapter came
      // back with none, and nothing failed until a test asked for it.
      registrations.set(descriptor.provider, registration);
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

    control(provider) {
      const existing = controlInstances.get(provider);
      if (existing) return existing;

      const registration = registrations.get(provider);
      if (!registration?.createControl) return undefined;

      const adapter = registration.createControl();
      controlInstances.set(provider, adapter);
      return adapter;
    },

    hasControl: (provider) => Boolean(registrations.get(provider)?.createControl),

    instantiatedControl: () => [...controlInstances.values()],

    disposeAll() {
      for (const connector of instances.values()) connector.dispose();
      instances.clear();
      for (const adapter of controlInstances.values()) adapter.dispose();
      controlInstances.clear();
    },
  };
}
