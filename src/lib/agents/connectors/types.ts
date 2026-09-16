import type { AgentAdapterObservation } from "@/lib/agents/adapter";

/**
 * The connector layer: who can be observed, whether they currently can be,
 * and what they are able to say.
 *
 * This sits directly above the observation seam in `../adapter.ts` and adds
 * the three things that seam deliberately does not model — identity,
 * capability and connection state — without teaching the domain beneath it
 * that providers exist. Traffic is one-way and unchanged:
 *
 *     provider -> connector -> AgentAdapterObservation -> agent domain
 *
 * and never the reverse. Every omission in `AgentAdapter` is preserved here:
 * no member on any type below would start, stop, prompt, cancel or otherwise
 * act on an external agent, and `./guard.test.ts` fails the build if one
 * appears.
 */

/**
 * A provider TabDump knows how to talk about.
 *
 * A closed union rather than an open string, so that adding a provider is a
 * deliberate edit with a type error at every place that has to care — rather
 * than a new string appearing in persisted state and silently rendering as
 * nothing. `custom` is the escape hatch for an integration that is not one of
 * the four, and it is a single value on purpose: it names the *kind* of
 * connector, while an individual custom connector's identity is its
 * descriptor.
 */
export type AgentProviderId = "claude-code" | "openai-codex" | "gemini" | "grok" | "custom";

export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = [
  "claude-code",
  "openai-codex",
  "gemini",
  "grok",
  "custom",
] as const;

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === "string" && (AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * What a connector is able to observe.
 *
 * Every flag defaults to false in `NO_CAPABILITIES` below, and that direction
 * is the point: a provider declares what it *can* do, and anything it has not
 * claimed is assumed absent. The opposite default would make a new provider
 * look fully-featured until someone remembered to switch things off, and the
 * UI would promise data that never arrives.
 *
 * These describe ability, not the current moment. A connector that can
 * observe work items still declares `workItems: true` during a poll that
 * happened to find none — "supports" and "has right now" are different
 * questions, and conflating them would make the capability list flicker.
 */
export type ConnectorCapabilities = {
  /** Can report that sessions/runs exist at all. The floor: without this a connector can report nothing. */
  runs: boolean;
  /** Can report an activity log of what happened during a run. */
  events: boolean;
  /** Can report which project files a run touched. */
  files: boolean;
  /** Can report produced artifacts as first-class objects. */
  artifacts: boolean;
  /** Can report structured units of work (tasks, plan items). */
  workItems: boolean;
  /** Can deliver updates while a run is ongoing, rather than only after the fact. */
  liveUpdates: boolean;
};

export const CAPABILITY_KEYS = [
  "runs",
  "events",
  "files",
  "artifacts",
  "workItems",
  "liveUpdates",
] as const satisfies readonly (keyof ConnectorCapabilities)[];

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Human labels for the capability list. Provider-neutral by construction. */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  runs: "Runs",
  events: "Events",
  files: "Files",
  artifacts: "Artifacts",
  workItems: "Work items",
  liveUpdates: "Live updates",
};

/** Nothing claimed. The base every descriptor spreads over. */
export const NO_CAPABILITIES: ConnectorCapabilities = {
  runs: false,
  events: false,
  files: false,
  artifacts: false,
  workItems: false,
  liveUpdates: false,
};

export function capabilityCount(capabilities: ConnectorCapabilities): number {
  return CAPABILITY_KEYS.filter((key) => capabilities[key]).length;
}

/**
 * Where a connector is in its connection life.
 *
 * Seven states, and the three that look similar are the ones that matter
 * most, because collapsing them is how a UI starts lying:
 *
 *   - `disconnected` — could be observed; the user has not asked for it.
 *   - `configuration_required` — the user asked, and something they must
 *     supply is missing. Actionable by them.
 *   - `unavailable` — the user asked, and this environment cannot do it at
 *     all. NOT actionable by them; no amount of configuring will help.
 *
 * A product that showed all three as "Not connected" would send someone
 * hunting for a setting that does not exist. `error` is separate again: the
 * connector could observe, tried, and failed.
 */
export type ConnectorStatusKind =
  | "disconnected"
  | "configuration_required"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "unavailable";

export const CONNECTOR_STATUS_KINDS: readonly ConnectorStatusKind[] = [
  "disconnected",
  "configuration_required",
  "connecting",
  "connected",
  "reconnecting",
  "error",
  "unavailable",
] as const;

export function isConnectorStatusKind(value: unknown): value is ConnectorStatusKind {
  return typeof value === "string" && (CONNECTOR_STATUS_KINDS as readonly string[]).includes(value);
}

/**
 * The word for each state, in one place.
 *
 * Shared by the settings page and the workspace sidebar so the two surfaces
 * cannot describe the same connector differently — which they would, the
 * first time one of them was edited and the other was not.
 */
export const CONNECTOR_STATUS_LABELS: Record<ConnectorStatusKind, string> = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Not connected",
  configuration_required: "Needs setup",
  unavailable: "Unavailable",
  error: "Error",
};

/** Statuses in which a connector is actively holding resources (a timer, a listener). */
export const LIVE_CONNECTOR_STATUS_KINDS: readonly ConnectorStatusKind[] = [
  "connecting",
  "connected",
  "reconnecting",
] as const;

export function isLiveConnectorStatus(kind: ConnectorStatusKind): boolean {
  return (LIVE_CONNECTOR_STATUS_KINDS as readonly string[]).includes(kind);
}

/**
 * Why a connector failed, structured rather than free-form.
 *
 * A closed code plus an already-safe message. There is deliberately no field
 * for a raw provider payload, a stack trace, a request body or a response: an
 * error is the one path where a secret most easily escapes into a log or onto
 * a screen, and the only way to be sure it cannot is to have nowhere to put
 * it. See `connectorError`, the only thing that mints one — and which never
 * reads a caught exception at all.
 */
export type ConnectorErrorCode =
  | "unreachable"
  | "permission-denied"
  | "malformed-response"
  | "timeout"
  | "unsupported"
  | "configuration"
  | "unknown";

export type ConnectorError = {
  code: ConnectorErrorCode;
  /** Short, human-readable, known-safe: chosen from a fixed table, never interpolated from provider data. */
  message: string;
};

const ERROR_MESSAGES: Record<ConnectorErrorCode, string> = {
  unreachable: "Could not reach the provider.",
  "permission-denied": "TabDump does not have permission to observe this provider.",
  "malformed-response": "The provider returned data TabDump could not read.",
  timeout: "The provider did not respond in time.",
  unsupported: "This environment does not support observing this provider.",
  configuration: "This connector needs to be configured before it can observe anything.",
  unknown: "The connector stopped unexpectedly.",
};

/**
 * Turns a code into a safe error.
 *
 * Takes a code and nothing else — in particular, it does not accept the
 * caught value. That is the structural reason a provider cannot get a string
 * of its choosing onto the user's screen, or into a log line, by throwing one.
 */
export function connectorError(code: ConnectorErrorCode): ConnectorError {
  return { code, message: ERROR_MESSAGES[code] };
}

/**
 * A connector's current state, in full.
 *
 * Everything a consumer needs to render is here, so nothing has to infer
 * status by checking whether some other field happens to be set.
 */
export type ConnectorStatus = {
  kind: ConnectorStatusKind;
  /** When the connector entered this state, epoch ms. */
  since: number;
  /** When an observation was last delivered. Absent until one has been. */
  lastObservationAt?: number;
  /** The most recent failure. Kept through a later recovery, so "it has been flaky" stays legible. */
  lastError?: ConnectorError;
  /**
   * One extra, already-safe sentence for the states that need one — chiefly
   * `unavailable` and `configuration_required`, where "why" is the whole
   * question. Authored by the connector, never by the provider.
   */
  detail?: string;
};

export function initialStatus(
  kind: ConnectorStatusKind,
  now: number,
  detail?: string
): ConnectorStatus {
  return detail ? { kind, since: now, detail } : { kind, since: now };
}

/**
 * Derived health, as distinct from status.
 *
 * Status says what the connection is doing; health says whether it is doing
 * it *well*. A connector can be `connected` and unhealthy — polling, but
 * failing every time, or silent for far longer than its own update interval.
 * Both are computed from real state; nothing here runs a timer of its own.
 */
export type ConnectorHealthKind = "healthy" | "degraded" | "failing" | "idle" | "unknown";

export type ConnectorHealth = {
  kind: ConnectorHealthKind;
  /** A short, safe phrase for display. */
  label: string;
};

/**
 * Static facts about a provider: who it is and what it can do.
 *
 * Separate from `ConnectorStatus` because it never changes at runtime — the
 * settings UI can list every provider, with its capabilities, before a single
 * connector has been connected.
 */
export type ProviderDescriptor = {
  provider: AgentProviderId;
  /** Shown to the user. The Agent identity minted for this provider takes this name. */
  displayName: string;
  /** One line: what TabDump would observe if this were connected. */
  summary: string;
  capabilities: ConnectorCapabilities;
  /**
   * What this connector needs before it can observe, in one safe sentence.
   *
   * Absent when it needs nothing. Present for every provider that is not
   * implemented, which is how the UI explains an `unavailable` honestly
   * rather than showing an empty card.
   */
  requirement?: string;
};

export type ConnectorUnsubscribe = () => void;

export type ConnectorStatusListener = (status: ConnectorStatus) => void;

export type ConnectorObserver = (observations: ConnectorObservation[]) => void;

/**
 * The provider-neutral connector contract.
 *
 * Read-only, exactly as `AgentAdapter` is, and for the same reason: TabDump
 * observes agents and does not drive them. `connect` and `disconnect` are
 * about *TabDump's own observation* — they start and stop this app watching,
 * and they do not reach the external agent at all. Nothing here can launch a
 * session, send it a prompt, or stop one that is running, and no member may
 * be added that could.
 *
 * `dispose` is separate from `disconnect` on purpose. Disconnecting is a user
 * action and is reversible: the connector stays registered and can be
 * connected again. Disposing is teardown — the connector is finished with,
 * every timer and listener it owns is released, and it is not expected to
 * work afterwards.
 */
export interface AgentConnector {
  readonly provider: AgentProviderId;
  readonly descriptor: ProviderDescriptor;

  getStatus(): ConnectorStatus;

  /** Begins observing. Resolves with the status it settled into — including a failure state. */
  connect(): Promise<ConnectorStatus>;

  /** Stops observing and releases what the connection held. Safe to call when already disconnected. */
  disconnect(): void;

  /** Receives observations while connected. Returns the function that detaches it. */
  subscribe(observer: ConnectorObserver): ConnectorUnsubscribe;

  /** Receives every status change. Returns the function that detaches it. */
  watchStatus(listener: ConnectorStatusListener): ConnectorUnsubscribe;

  /** Final teardown. Idempotent. */
  dispose(): void;
}

/**
 * An observation as it leaves a connector.
 *
 * Identical to what the domain ingests — the connector layer adds routing and
 * state, never a field. Aliased so provider modules name the type from the
 * layer they implement rather than reaching past it.
 */
export type ConnectorObservation = AgentAdapterObservation;
