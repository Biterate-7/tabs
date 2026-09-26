import { scopedKey } from "@/lib/storage/namespace";
import { isValidTimestamp } from "@/lib/timestamps";
import { isAgentProviderId } from "./types";
import type { AgentProviderId } from "./types";

/**
 * Which connectors the user has asked Hubble to observe.
 *
 * Its own storage key, separate from `tabdump:agents:v1`, and the separation
 * is the point rather than tidiness. Agent state is a *record of work* — runs,
 * events, files, work items — and it is exported, imported and (in later
 * phases) synchronised. Connector configuration is a *setting about this
 * install*: which providers this person wants watched. Mixing them would mean
 * every export of a workspace carried the user's connector setup along with
 * it, and every import risked switching someone else's observation on.
 *
 * ## What is NOT here
 *
 * There is no field on `ConnectorConfig` for a token, a key, a secret, a
 * cookie, a header or a credential of any kind, and none may be added. That
 * is not a convention — it is the whole reason this file can write to
 * localStorage at all. localStorage is readable by any script that runs on
 * the origin and survives indefinitely on a shared machine; it is a
 * reasonable home for "the user turned Claude Code on" and an unacceptable
 * one for anything that would let a third party act as the user.
 *
 * A provider that genuinely needs a secret gets it from
 * ./session-credentials.ts, which holds it in memory for the life of the tab
 * and never writes it anywhere. `connectors/security.test.ts` pins both
 * halves of that rule.
 */

const STORAGE_KEY = "tabdump:connectors:v1";

export const CONNECTOR_STATE_VERSION = 1;

/**
 * One provider's configuration.
 *
 * Three fields, all of them non-sensitive by inspection: who, whether, and
 * when. Note what `enabled` means — "the user asked for this", not "this is
 * working". Whether it works is `ConnectorStatus`, which is live state and is
 * never persisted: restoring a saved "connected" would show a connection that
 * has not been established yet, which is exactly the fake-live-data failure
 * this phase exists to avoid.
 */
export type ConnectorConfig = {
  provider: AgentProviderId;
  /** The user's intent. Reconnection on load is attempted for these, and only these. */
  enabled: boolean;
  /** When the user first enabled it, epoch ms. Display only. */
  enabledAt?: number;
};

export type ConnectorConfigState = {
  version: typeof CONNECTOR_STATE_VERSION;
  connectors: ConnectorConfig[];
};

export function defaultConnectorConfigState(): ConnectorConfigState {
  return { version: CONNECTOR_STATE_VERSION, connectors: [] };
}

export function findConnectorConfig(
  state: ConnectorConfigState,
  provider: AgentProviderId
): ConnectorConfig | undefined {
  return state.connectors.find((entry) => entry.provider === provider);
}

export function isConnectorEnabled(
  state: ConnectorConfigState,
  provider: AgentProviderId
): boolean {
  return findConnectorConfig(state, provider)?.enabled === true;
}

/**
 * Records that the user wants (or no longer wants) a provider observed.
 *
 * Pure, with the clock injected. Disabling keeps the entry rather than
 * deleting it, so `enabledAt` survives a disable/enable cycle and the record
 * reads as one connector's history rather than two unrelated events. Callers
 * that really mean "forget this ever happened" use `removeConnectorConfig`.
 */
export function setConnectorEnabled(
  state: ConnectorConfigState,
  provider: AgentProviderId,
  enabled: boolean,
  now: number
): ConnectorConfigState {
  const existing = findConnectorConfig(state, provider);

  if (!existing) {
    const created: ConnectorConfig = enabled
      ? { provider, enabled: true, enabledAt: now }
      : { provider, enabled: false };
    return { ...state, connectors: [...state.connectors, created] };
  }

  if (existing.enabled === enabled) return state;

  const next: ConnectorConfig = {
    ...existing,
    enabled,
    // First enable stamps the clock; a re-enable keeps the original, because
    // "connected since" is about the relationship, not the last toggle.
    enabledAt: enabled ? (existing.enabledAt ?? now) : existing.enabledAt,
  };

  return {
    ...state,
    connectors: state.connectors.map((entry) => (entry.provider === provider ? next : entry)),
  };
}

export function removeConnectorConfig(
  state: ConnectorConfigState,
  provider: AgentProviderId
): ConnectorConfigState {
  const kept = state.connectors.filter((entry) => entry.provider !== provider);
  return kept.length === state.connectors.length ? state : { ...state, connectors: kept };
}

/**
 * Reads stored configuration, tolerating anything.
 *
 * Never throws and never propagates a partial record: an entry that fails any
 * check is dropped, and a record that fails wholesale degrades to "nothing is
 * configured". The failure mode that matters is the safe one — a corrupt file
 * turns observation OFF rather than on, because the alternative is a
 * hand-edited or half-written value silently switching on a poll against the
 * user's machine.
 *
 * Unknown provider ids are dropped rather than kept for a future build. A
 * string that is not a provider Hubble ships cannot be rendered, connected,
 * or disconnected through any path, so keeping it would only mean carrying an
 * entry no UI can act on.
 */
export function loadConnectorConfig(): ConnectorConfigState {
  try {
    const raw = window.localStorage.getItem(scopedKey(STORAGE_KEY));
    if (!raw) return defaultConnectorConfigState();

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultConnectorConfigState();

    const record = parsed as Record<string, unknown>;
    if (record.version !== CONNECTOR_STATE_VERSION) return defaultConnectorConfigState();
    if (!Array.isArray(record.connectors)) return defaultConnectorConfigState();

    const connectors: ConnectorConfig[] = [];
    const seen = new Set<AgentProviderId>();

    for (const entry of record.connectors) {
      if (!entry || typeof entry !== "object") continue;
      const { provider, enabled, enabledAt } = entry as Record<string, unknown>;
      if (!isAgentProviderId(provider) || seen.has(provider)) continue;
      if (typeof enabled !== "boolean") continue;

      seen.add(provider);
      const config: ConnectorConfig = { provider, enabled };
      if (isValidTimestamp(enabledAt)) config.enabledAt = enabledAt;
      connectors.push(config);
    }

    return { version: CONNECTOR_STATE_VERSION, connectors };
  } catch {
    return defaultConnectorConfigState();
  }
}

/**
 * Writes configuration back.
 *
 * Serialises field by field rather than stringifying the state it was handed.
 * That is not defensive habit: it means that if a caller ever passes an object
 * carrying an extra property — a token someone attached in a later phase, a
 * response spread in by accident — the extra property is not written, because
 * this function only ever writes the three fields it names.
 */
export function saveConnectorConfig(state: ConnectorConfigState): boolean {
  try {
    const safe: ConnectorConfigState = {
      version: CONNECTOR_STATE_VERSION,
      connectors: state.connectors.map((entry) => {
        const config: ConnectorConfig = { provider: entry.provider, enabled: entry.enabled };
        if (entry.enabledAt !== undefined) config.enabledAt = entry.enabledAt;
        return config;
      }),
    };

    window.localStorage.setItem(scopedKey(STORAGE_KEY), JSON.stringify(safe));
    return true;
  } catch {
    // Quota, or storage disabled mid-session. Reported rather than thrown:
    // failing to remember a preference must not take down the surface the
    // user was using when they set it.
    return false;
  }
}

export const CONNECTOR_STORAGE_KEY = STORAGE_KEY;
