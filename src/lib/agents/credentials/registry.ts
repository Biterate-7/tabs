import { AGENT_PROVIDER_IDS } from "@/lib/agents/connectors/types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type {
  CredentialValidation,
  ProviderAuthMethod,
  ResolvedProviderCredential,
} from "./types";

/**
 * The provider credential layer's seam and its registry.
 *
 * ## Why authentication is its own adapter
 *
 * Hubble already has two provider-shaped planes — observation
 * (`connectors/providers/`) and control (`control/providers/`) — and they are
 * separate because a provider can be fully observable and entirely undrivable.
 * Authentication is a third fact of the same kind: a provider can be drivable
 * and have no credential mechanism Hubble can honestly implement, and a user
 * can hold a credential for a provider Hubble cannot drive at all.
 *
 * Collapsing any two of the three would make one of those states
 * unrepresentable, and each of them is a state some provider is actually in
 * today. So this is a third small interface beside the other two, not a
 * capability bolted onto either.
 *
 * ## Deliberately narrow
 *
 * Three methods. Not a general provider-feature interface: no model list, no
 * quota, no billing, no usage. Those are things some providers expose and
 * others do not, and an interface that named them would force every adapter to
 * answer a question its provider cannot. See §5 of the brief — Hubble does
 * not invent billing information.
 */

/**
 * How a credential is collected from the user.
 *
 * `secret` is the only field shape implemented, because it is the only one
 * API-key authentication needs. A delegated OAuth adapter would add a variant
 * here — a redirect rather than a text field — and the UI would switch on it.
 * Declaring the union with one member today is what makes that a new member
 * rather than a rewrite of the settings page.
 */
export type CredentialInputShape = {
  kind: "secret";
  /** The label above the field. */
  label: string;
  /** Placeholder text. Never a real key, and never a prefix of one. */
  placeholder: string;
  /** Where the user goes to issue one. Rendered as a link. */
  issueUrl: string;
  /** One sentence making it unambiguous whose credential this is. */
  explanation: string;
};

/**
 * What Hubble can do about one provider's credentials.
 *
 * Absent from the registry entirely means "Hubble has no credential story for
 * this provider", which reads correctly everywhere without a stub having to
 * claim otherwise.
 */
export type ProviderCredentialAdapter = {
  provider: AgentProviderId;
  /** The methods this adapter implements. Not the methods the provider has. */
  authMethods: readonly ProviderAuthMethod[];
  /** The default label a connection gets when the user names nothing. */
  defaultDisplayName: string;
  /** How the UI asks for it, per method. */
  input(method: ProviderAuthMethod): CredentialInputShape | undefined;

  /**
   * A cheap, authenticated request that proves the provider accepts this
   * credential.
   *
   * Must not start an agent run, must not generate tokens, and must not cost
   * the user anything beyond a request. Must normalize every provider error
   * onto a `CredentialValidationCode` and must not carry a provider response
   * body out — see the note on `CredentialValidationCode`.
   */
  validate(secret: string, method: ProviderAuthMethod): Promise<CredentialValidation>;

  /**
   * Turns a stored secret into the environment a runtime needs.
   *
   * Pure, synchronous, and the only place that knows which variable a given
   * provider's runtime reads. Returning a map rather than mutating an
   * environment is what keeps the credential's lifetime equal to the lifetime
   * of the object the caller holds.
   */
  prepareRuntimeCredential(input: {
    connectionId: string;
    secret: string;
    method: ProviderAuthMethod;
  }): ResolvedProviderCredential | undefined;
};

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * What a provider's connection story is, for a UI that must not overclaim.
 *
 * The brief's §11 requirement is that connector cards derive their statuses
 * from actual registration rather than hardcoded marketing text. This is the
 * connection third of that; observation and control already have their own.
 */
export type ProviderCredentialSupport =
  /** An adapter is registered and a user can connect today. */
  | { kind: "supported"; authMethods: readonly ProviderAuthMethod[] }
  /** Hubble knows the provider and has no credential mechanism for it yet. */
  | { kind: "unsupported" };

const adapters = new Map<AgentProviderId, ProviderCredentialAdapter>();

/**
 * Registers an adapter.
 *
 * Called once per provider, from `./providers/index.ts`. Idempotent by
 * replacement so a hot reload in development does not end up with two.
 */
export function registerCredentialAdapter(adapter: ProviderCredentialAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function credentialAdapterFor(
  provider: AgentProviderId
): ProviderCredentialAdapter | undefined {
  return adapters.get(provider);
}

/**
 * Whether a provider can be connected, and how.
 *
 * The source of truth §20 asks for. Codex, Gemini and Grok answer
 * `unsupported` — not because their connection architecture is missing, but
 * because no adapter has been written and verified against their real
 * authentication, and a registry entry that existed only to make a card look
 * complete would be exactly the fake credential the brief forbids.
 */
export function credentialSupportFor(provider: AgentProviderId): ProviderCredentialSupport {
  const adapter = adapters.get(provider);
  if (!adapter) return { kind: "unsupported" };
  return { kind: "supported", authMethods: adapter.authMethods };
}

/** Every provider Hubble names, with its connection story. For the settings page. */
export function credentialSupportTable(): ReadonlyMap<
  AgentProviderId,
  ProviderCredentialSupport
> {
  return new Map(
    AGENT_PROVIDER_IDS.map((provider) => [provider, credentialSupportFor(provider)])
  );
}

/** Drops every registration. For tests, so one suite's registry cannot leak into the next. */
export function resetCredentialAdapters(): void {
  adapters.clear();
}
