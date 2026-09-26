import { AGENT_PROVIDER_IDS, isAgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * Provider connections — "this user authorized Hubble to use this provider".
 *
 * ## The three things this phase keeps apart
 *
 * ```
 * Provider connection   this user has credentials for this provider
 *         ↓
 * Agent session         this agent is working on this project
 *         ↓
 * Agent run             this turn
 * ```
 *
 * They were one thing in every earlier phase, in the sense that there was
 * nothing to separate: a deployment had one operator key and every session
 * used it. The product this phase exists to make possible is the other one —
 *
 * ```
 * USER → THEIR PROVIDER CONNECTION → COMMAND CENTRE → THEIR AGENT
 * ```
 *
 * — and that only works if a connection is a first-class record with an
 * owner, rather than an environment variable with a deployment.
 *
 * ## What is deliberately not in this file
 *
 * A secret. `AgentProviderConnection` is the shape the *browser* is given, and
 * every field on it is safe to render. The credential lives behind a
 * credential reference handled by `./secret-store.ts` and is never loaded into
 * this type, never returned by the service that produces it, and never
 * serialized into anything a client can read. There is no field here you could
 * put one in, which is the only version of that rule that survives a refactor.
 */

/* ------------------------------------------------------------------ *
 * Auth methods
 * ------------------------------------------------------------------ */

/**
 * How a user proved to a provider that they are allowed to use it.
 *
 * Open on purpose, and **not** assumed uniform across providers. Anthropic
 * documents API-key authentication (the `x-api-key` header) for developer
 * products, and Workload Identity Federation for service-to-service
 * deployments. The OAuth flow it documents is for a developer's own machine —
 * `ant auth login`, writing a profile under the user's config directory — not
 * a delegated third-party grant a hosted product can hold on somebody's
 * behalf. So:
 *
 *   - `api_key` — implemented, for Claude, in `./providers/claude.ts`.
 *   - `workload_identity` — declared. A real documented mechanism; nothing
 *     implements it, and the registry says so rather than offering it.
 *   - `official_oauth` — declared, and **must not be assumed to exist for any
 *     given provider**. It is here so that when a provider publishes a
 *     delegated flow for third-party applications, it becomes one adapter and
 *     one registry entry rather than a rewrite of this layer.
 *
 * What is *not* here, and will not be added: scraping Claude.ai cookies,
 * reading a user's local Claude Code OAuth state, or asking anybody to paste a
 * browser session token. None of those is a supported third-party
 * authentication mechanism, and storing one would mean holding a person's
 * login session on our server under a name that implied otherwise.
 */
export type ProviderAuthMethod = "api_key" | "workload_identity" | "official_oauth";

export const PROVIDER_AUTH_METHODS: readonly ProviderAuthMethod[] = [
  "api_key",
  "workload_identity",
  "official_oauth",
] as const;

export function isProviderAuthMethod(value: unknown): value is ProviderAuthMethod {
  return typeof value === "string" && (PROVIDER_AUTH_METHODS as readonly string[]).includes(value);
}

/** What each method is called on screen. Accurate, not aspirational — see the naming note below. */
export const AUTH_METHOD_LABEL: Record<ProviderAuthMethod, string> = {
  // NOT "Claude account". Hubble holds an API credential the user issued
  // themselves; calling that "connect your Claude account" would describe an
  // OAuth grant that does not exist and imply Hubble can act as them.
  api_key: "Anthropic API",
  workload_identity: "Workload identity",
  official_oauth: "Provider sign-in",
};

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/**
 * Where a connection stands, as a closed set.
 *
 * `connected` is the only state that may start a session. The rest are
 * distinct because each tells the user something different to do: a key the
 * provider rejected needs replacing, a provider that was unreachable needs
 * retrying, and a revoked connection needs reconnecting.
 */
export type ProviderConnectionStatus =
  /** Validated. Sessions may start. */
  | "connected"
  /** The provider rejected the credential at validation time. */
  | "invalid"
  /** Validated once, but the last check could not reach the provider. */
  | "unverified"
  /** The user disconnected it. The secret is gone; the row may survive briefly. */
  | "revoked";

export const PROVIDER_CONNECTION_STATUSES: readonly ProviderConnectionStatus[] = [
  "connected",
  "invalid",
  "unverified",
  "revoked",
] as const;

export function isProviderConnectionStatus(value: unknown): value is ProviderConnectionStatus {
  return (
    typeof value === "string" &&
    (PROVIDER_CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

export const CONNECTION_STATUS_LABEL: Record<ProviderConnectionStatus, string> = {
  connected: "Connected",
  invalid: "Credentials rejected",
  unverified: "Not verified",
  revoked: "Disconnected",
};

/* ------------------------------------------------------------------ *
 * Validation outcomes
 * ------------------------------------------------------------------ */

/**
 * What a validation attempt proved, normalized away from the provider.
 *
 * A provider's own error body is never carried here. Its status code is mapped
 * onto one of these and the body discarded, because an error string is the
 * single easiest route by which a key echoed back in a message — which some
 * APIs do — would reach a screen. `./providers/claude.ts` maps; nothing
 * downstream ever sees anything else.
 */
export type CredentialValidationCode =
  /** The provider authenticated and answered. */
  | "connection_valid"
  /** The provider said no. Wrong key, revoked key, or one without access. */
  | "invalid_credentials"
  /** The shape is wrong before a request is worth making. */
  | "malformed_credential"
  /** The provider could not be reached, or answered 5xx. Says nothing about the key. */
  | "provider_unavailable"
  /** The provider is rate-limiting. Also says nothing about the key. */
  | "rate_limited"
  /** Something else went wrong on our side. */
  | "validation_failed";

export const VALIDATION_MESSAGE: Record<CredentialValidationCode, string> = {
  connection_valid: "Connected.",
  invalid_credentials: "The provider did not accept those credentials.",
  malformed_credential: "That does not look like a valid credential for this provider.",
  provider_unavailable: "Hubble could not reach the provider. Try again shortly.",
  rate_limited: "The provider is rate-limiting requests right now. Try again shortly.",
  validation_failed: "Hubble could not verify those credentials.",
};

export type CredentialValidation = {
  code: CredentialValidationCode;
  /** From the fixed table above. Never interpolated from a provider response. */
  message: string;
};

export function credentialValidation(code: CredentialValidationCode): CredentialValidation {
  return { code, message: VALIDATION_MESSAGE[code] };
}

/** Whether a validation outcome may be stored as a working connection. */
export function isValidatedOk(code: CredentialValidationCode): boolean {
  return code === "connection_valid";
}

/**
 * Which outcomes mean "the credential itself is bad".
 *
 * Load-bearing at rotation: a rotation that fails because the provider was
 * *unreachable* must not mark the existing connection invalid, because nothing
 * was learned about it. See `./service.ts`.
 */
export function blamesCredential(code: CredentialValidationCode): boolean {
  return code === "invalid_credentials" || code === "malformed_credential";
}

/* ------------------------------------------------------------------ *
 * The connection
 * ------------------------------------------------------------------ */

/**
 * A provider connection, exactly as the browser receives it.
 *
 * Every field is safe to render, log and serialize. There is no credential, no
 * credential reference, no prefix, no masked form and no length. A masked
 * prefix is a habit borrowed from dashboards that can revoke a key from the
 * same screen; Hubble cannot, so showing four characters of somebody's secret
 * buys recognition at the cost of leaking part of it into every screenshot.
 */
export type AgentProviderConnection = {
  /** Server-minted and opaque. The only handle the browser ever holds. */
  id: string;
  /** The runtime actor who owns it, e.g. `account:<uuid>`. Never read from a request body. */
  ownerId: string;
  provider: AgentProviderId;
  authMethod: ProviderAuthMethod;
  /** The user's own label, or a default. Free text, length-capped, never the credential. */
  displayName: string;
  status: ProviderConnectionStatus;
  createdAt: number;
  updatedAt: number;
  /** When the provider last confirmed the credential. Absent if it never has. */
  lastValidatedAt?: number;
  /** Why the last validation failed, when it did. From the closed set above. */
  lastFailureCode?: CredentialValidationCode;
};

/** Longest display name accepted. Room for "Work key — billing account", not room for a payload. */
export const MAX_DISPLAY_NAME = 80;

/**
 * Normalizes a caller-supplied display name.
 *
 * Control characters are stripped rather than escaped: a name is rendered in a
 * dozen places and the one that forgets to escape is the one that matters. An
 * empty result falls back to the provider's default label, so a connection
 * always has something to call itself.
 */
export function normalizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[ -]/g, " ").trim().slice(0, MAX_DISPLAY_NAME);
  return cleaned || fallback;
}

/* ------------------------------------------------------------------ *
 * The browser-facing view
 * ------------------------------------------------------------------ */

/**
 * What crosses the network.
 *
 * `AgentProviderConnection` already holds nothing secret, so this is not a
 * redaction — it is a *narrowing*, and the difference matters. `ownerId` is
 * dropped because a client has no use for an id it cannot act on and every
 * reason not to learn the shape of somebody else's, and because a view that
 * carries no owner cannot be the thing a route accidentally trusts.
 *
 * Every route that returns a connection returns this. `security.test.ts`
 * sweeps the serialized result for a distinctive test secret.
 */
export type ProviderConnectionView = {
  id: string;
  provider: AgentProviderId;
  authMethod: ProviderAuthMethod;
  displayName: string;
  status: ProviderConnectionStatus;
  createdAt: number;
  updatedAt: number;
  lastValidatedAt?: number;
  lastFailureCode?: CredentialValidationCode;
};

export function toConnectionView(connection: AgentProviderConnection): ProviderConnectionView {
  const view: ProviderConnectionView = {
    id: connection.id,
    provider: connection.provider,
    authMethod: connection.authMethod,
    displayName: connection.displayName,
    status: connection.status,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };

  if (connection.lastValidatedAt !== undefined) view.lastValidatedAt = connection.lastValidatedAt;
  if (connection.lastFailureCode !== undefined) view.lastFailureCode = connection.lastFailureCode;
  return view;
}

/** Whether a connection may be used to start a session. One definition, used everywhere. */
export function isUsable(connection: Pick<AgentProviderConnection, "status">): boolean {
  return connection.status === "connected";
}

/* ------------------------------------------------------------------ *
 * The credential, in the one place it is allowed to exist
 * ------------------------------------------------------------------ */

/**
 * A resolved credential, on its way into a runtime.
 *
 * Constructed server-side, held for the duration of one `start()`, and handed
 * to exactly one place: the environment of the provider process. It is not a
 * field on a session, not a field on a run, not a field on an event, and not a
 * field on anything with a `toJSON`.
 *
 * `connectionId` travels with it so a runtime can *say which connection it
 * used* without saying what the credential was — which is what makes the
 * multi-user isolation tests possible to write without ever comparing secrets.
 */
export type ResolvedProviderCredential = {
  connectionId: string;
  provider: AgentProviderId;
  authMethod: ProviderAuthMethod;
  /**
   * The environment variables the provider's runtime reads, and their values.
   *
   * A map rather than a bare string because `workload_identity` needs four
   * variables and `api_key` needs one, and a shape that only fitted one of
   * them would have to be widened by whoever implements the other.
   */
  env: Readonly<Record<string, string>>;
};

/**
 * Why a credential could not be resolved.
 *
 * Deliberately coarse. A caller learns "this user cannot start a Claude
 * session, and here is the one thing to do about it", not which half of the
 * store was unreachable.
 */
export type CredentialResolutionFailure =
  /** No connection for this provider at all. The user must connect one. */
  | "not_connected"
  /** A connection exists but is not usable — invalid, revoked, unverified. */
  | "not_usable"
  /** The secret store could not produce the secret. A deployment problem, not a user one. */
  | "unavailable";

export type CredentialResolution =
  | { ok: true; credential: ResolvedProviderCredential }
  | { ok: false; reason: CredentialResolutionFailure };

export const RESOLUTION_MESSAGE: Record<CredentialResolutionFailure, string> = {
  not_connected: "Connect your own provider credentials before starting a session.",
  not_usable: "This provider connection needs attention before it can run a session.",
  unavailable: "Hubble cannot reach its credential store on this deployment.",
};

/* ------------------------------------------------------------------ *
 * Re-exports, so callers need one import
 * ------------------------------------------------------------------ */

export { AGENT_PROVIDER_IDS, isAgentProviderId };
export type { AgentProviderId };
