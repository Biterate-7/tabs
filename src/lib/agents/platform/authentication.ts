import type {
  AgentAuthMethod,
  AuthMethodSupport,
  PlatformProvider,
  PlatformSignInKind,
  PlatformSurface,
} from "./catalog";
import type {
  ProviderAuthMethodView,
  ProviderConnectionView,
  RuntimeProviderStatus,
} from "@/lib/agents/runtime/protocol";

/**
 * Agent Authentication & Runtime — the provider-neutral model.
 *
 * ## Four ideas kept apart
 *
 *   1. **Provider** — the company: Anthropic, OpenAI, Google, xAI.
 *   2. **Runtime** — the program Hubble starts or asks: Claude Code, Codex,
 *      Gemini CLI, Grok Build. It owns the sign-in; Hubble observes it.
 *   3. **Authentication method** — how that runtime proves it may use the
 *      provider: an account sign-in it runs itself, an API key, a cloud
 *      credential in its own config, a Hubble token. Declared per provider in
 *      the catalogue, from the provider's documentation — never assumed.
 *   4. **Availability** — where it stands right now: the connection phase
 *      (./lifecycle.ts), derived from what the runtime reports.
 *
 * Everything here is derived from a catalogue entry plus the runtime's own
 * reports. No function names a provider, and no component needs to: adding an
 * agent is a catalogue entry and a runtime adapter, and the Settings page,
 * the connect dialog and the Command Centre read it through these functions.
 *
 * ## What never passes through here
 *
 * A credential. Methods are labels and rules; the runtime's reports are
 * closed enums. There is no field in this module a key, a token or an account
 * name could be put in.
 */

/* ------------------------------------------------------------------ *
 * Where a method is offered
 * ------------------------------------------------------------------ */

/** A method's standing on one surface. */
export type MethodAvailability =
  | { status: "offered" }
  | { status: "external"; setup: string }
  | { status: "unsupported"; reason: string };

export function methodAvailability(method: AgentAuthMethod, surface: PlatformSurface): MethodAvailability {
  const support: AuthMethodSupport = method.support;
  if (support.status === "unsupported") return { status: "unsupported", reason: support.reason };
  if (!support.surfaces.includes(surface)) {
    return {
      status: "unsupported",
      reason: method.unavailableOn?.[surface] ?? `${method.label} isn't available here.`,
    };
  }
  return support.status === "offered" ? { status: "offered" } : { status: "external", setup: support.setup };
}

/** A method Hubble offers here, with the agent's own id for starting it when the agent advertised one. */
export type OfferedAuthMethod = {
  method: AgentAuthMethod;
  /**
   * The id to send `authenticate_provider`, for a sign-in the runtime runs.
   * Absent for a method Hubble itself handles (an API key, an MCP token), and
   * for a runtime sign-in the agent has not yet been asked about.
   */
  runtimeMethodId?: string;
};

/**
 * The methods Hubble offers on this surface, reconciled with what the agent
 * itself advertised.
 *
 * A runtime-run sign-in is offered only when the agent advertises one of its
 * ids — Hubble never starts a flow the agent does not have. When the agent has
 * not been asked yet (`advertised` undefined), the method is listed without an
 * id, so the dialog can say what *will* be offered without offering a button
 * that cannot work. An advertised id the catalogue does not offer is dropped:
 * an API-key method an agent lists is never turned into a button (fail closed).
 */
export function offeredAuthMethods(
  provider: PlatformProvider,
  surface: PlatformSurface,
  advertised?: readonly ProviderAuthMethodView[]
): OfferedAuthMethod[] {
  const offered: OfferedAuthMethod[] = [];
  for (const method of provider.auth) {
    if (methodAvailability(method, surface).status !== "offered") continue;
    if (method.owner !== "runtime") {
      offered.push({ method });
      continue;
    }
    if (!advertised) {
      offered.push({ method });
      continue;
    }
    const match = advertised.find((candidate) => method.runtimeMethodIds?.includes(candidate.id));
    if (match) offered.push({ method, runtimeMethodId: match.id });
  }
  return offered;
}

/** Methods set up in the agent itself that Hubble recognises here. */
export function externalAuthMethods(provider: PlatformProvider, surface: PlatformSurface): AgentAuthMethod[] {
  return provider.auth.filter((method) => methodAvailability(method, surface).status === "external");
}

/** Every method Hubble does not use here, each with the sentence that says why. */
export function unavailableAuthMethods(
  provider: PlatformProvider,
  surface: PlatformSurface
): { method: AgentAuthMethod; reason: string }[] {
  return provider.auth.flatMap((method) => {
    const availability = methodAvailability(method, surface);
    return availability.status === "unsupported" ? [{ method, reason: availability.reason }] : [];
  });
}

/**
 * How the agent signs in here, as one of the three shapes the connect flow
 * handles. Derived from the offered methods — the runtime's own word that it
 * can run a native sign-in wins, since it knows which adapter it built.
 */
export function signInShape(
  provider: PlatformProvider,
  surface: PlatformSurface,
  status?: RuntimeProviderStatus | ProviderConnectionView
): PlatformSignInKind {
  if (status?.nativeSignIn) return "native";
  const offered = offeredAuthMethods(provider, surface).map((entry) => entry.method);
  if (offered.some((method) => method.kind === "hubble_token")) return "mcp-token";
  if (offered.some((method) => method.owner === "hubble")) return "provider-key";
  return "native";
}

/**
 * The method the runtime says is in use, when it says.
 *
 * Only from `authKind`, which the runtime reports as a closed value — never
 * guessed from which method happens to be offered. An agent that only says
 * "signed in" (every ACP agent) has no active method here, and the UI says
 * "Signed in through <runtime>" rather than inventing which account.
 */
export function activeAuthMethod(
  provider: PlatformProvider,
  status: RuntimeProviderStatus | ProviderConnectionView | undefined
): AgentAuthMethod | undefined {
  if (!status?.authKind || status.authentication !== "authenticated") return undefined;
  return provider.auth.find((method) => method.reportedAs === status.authKind);
}

/**
 * The one sentence that introduces how an agent authenticates here.
 *
 * "Use your existing account where the provider supports it" — said only for
 * a provider whose catalogue offers an account sign-in on this surface, and
 * never "sign in with your account" for one that does not.
 */
export function authIntro(provider: PlatformProvider, surface: PlatformSurface): string {
  const offered = offeredAuthMethods(provider, surface).map((entry) => entry.method);
  const account = offered.find((method) => method.kind === "account" && method.owner === "runtime");
  const key = offered.find((method) => method.kind === "api_key");
  const token = offered.find((method) => method.kind === "hubble_token");
  if (account) {
    return `${provider.runtimeName} can authenticate using your existing ${account.label}. ${provider.runtimeName} keeps the sign-in; Hubble never sees it.`;
  }
  if (key) return `${provider.displayName} runs on your own ${key.label} here.`;
  if (token) return token.summary;
  return `Authentication through Hubble isn't currently supported for ${provider.displayName}.`;
}

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

/**
 * What an agent can do with Hubble, and how it authenticates, on one surface.
 *
 * The shape the UI consumes. Every field is derived from the catalogue entry;
 * what the runtime actually declares (its adapter's capabilities) can only
 * narrow it, and the lifecycle believes the runtime.
 */
export type AgentCapabilities = {
  provider: PlatformProvider["provider"];
  displayName: string;
  vendor: string;
  runtimeName: string;
  transport: PlatformProvider["transport"];
  /** Offered or recognised here. */
  supportedAuthMethods: readonly AgentAuthMethod[];
  /** Not used here, each with its reason. */
  unsupportedAuthMethods: readonly { method: AgentAuthMethod; reason: string }[];
  /** A sign-in that can carry a paid plan is offered here, through the agent's own runtime. */
  supportsSubscriptionAuth: boolean;
  /** The provider's own account sign-in, run by its runtime, is offered here. */
  supportsAccountAuth: boolean;
  /** An API-key connection is offered here. */
  supportsApiKey: boolean;
  /** Hubble runs the agent on the user's own machine. */
  supportsLocalRuntime: boolean;
  /** A session can query its Hubble workspace (the runtime confirms per session). */
  supportsWorkspaceContext: boolean;
  /** Hubble starts and drives sessions with it. */
  supportsSessionControl: boolean;
  /** It speaks MCP with Hubble — as a client, or through its session's context server. */
  supportsMcp: boolean;
  /** How Hubble learns it is installed. */
  detection: "executable" | "none";
  /** How Hubble learns it is signed in. */
  authenticationDetection: "agent-probe" | "cli-status" | "stored-credential" | "hubble-token" | "none";
  installCommand?: string;
  docsUrl: string;
};

export function agentCapabilities(provider: PlatformProvider, surface: PlatformSurface): AgentCapabilities {
  const offered = offeredAuthMethods(provider, surface).map((entry) => entry.method);
  const external = externalAuthMethods(provider, surface);
  const usable = provider.surfaces.includes(surface);

  let authenticationDetection: AgentCapabilities["authenticationDetection"] = "none";
  if (offered.some((method) => method.kind === "hubble_token")) authenticationDetection = "hubble-token";
  else if (offered.some((method) => method.owner === "hubble")) authenticationDetection = "stored-credential";
  else if (offered.some((method) => method.owner === "runtime")) {
    authenticationDetection = provider.transport === "acp" ? "agent-probe" : "cli-status";
  }

  return {
    provider: provider.provider,
    displayName: provider.displayName,
    vendor: provider.vendor,
    runtimeName: provider.runtimeName,
    transport: provider.transport,
    supportedAuthMethods: usable ? [...offered, ...external] : [],
    unsupportedAuthMethods: unavailableAuthMethods(provider, surface),
    supportsSubscriptionAuth: usable && offered.some((method) => method.subscription && method.owner === "runtime"),
    supportsAccountAuth: usable && offered.some((method) => method.kind === "account" && method.owner === "runtime"),
    supportsApiKey: usable && offered.some((method) => method.kind === "api_key"),
    supportsLocalRuntime: provider.transport !== "mcp",
    supportsWorkspaceContext: provider.features.includes("workspace_context"),
    supportsSessionControl: usable && provider.chat && provider.sessions.available,
    supportsMcp: provider.transport === "mcp" || provider.features.includes("workspace_context"),
    detection: provider.transport === "mcp" ? "none" : "executable",
    authenticationDetection: usable ? authenticationDetection : "none",
    ...(provider.installCommand ? { installCommand: provider.installCommand } : {}),
    docsUrl: provider.docsUrl,
  };
}

/* ------------------------------------------------------------------ *
 * Adding an agent: the rules a definition must meet
 * ------------------------------------------------------------------ */

/**
 * Why a provider definition is refused.
 *
 * The catalogue is code, reviewed like code — but the rules below are the
 * security model, and a definition that breaks one must fail a test rather
 * than rely on a reviewer noticing. `platform/authentication.test.ts` runs
 * every shipped entry through this, and a custom agent cannot be defined into
 * any shape that bypasses it.
 */
export type DefinitionViolation =
  | "no_auth_methods"
  | "unsupported_without_reason"
  | "method_surface_outside_provider"
  | "duplicate_method_id"
  | "duplicate_runtime_method_id"
  | "runtime_sign_in_without_runtime_ids"
  | "hubble_held_subscription"
  | "hubble_held_key_outside_sdk"
  | "environment_credential_offered"
  | "client_agent_with_runtime_auth"
  | "client_agent_with_sessions"
  | "client_agent_with_chat";

export function validateAgentDefinition(provider: PlatformProvider): DefinitionViolation[] {
  const violations = new Set<DefinitionViolation>();
  if (provider.auth.length === 0) violations.add("no_auth_methods");

  const ids = new Set<string>();
  const runtimeIds = new Set<string>();
  for (const method of provider.auth) {
    if (ids.has(method.id)) violations.add("duplicate_method_id");
    ids.add(method.id);
    for (const runtimeId of method.runtimeMethodIds ?? []) {
      if (runtimeIds.has(runtimeId)) violations.add("duplicate_runtime_method_id");
      runtimeIds.add(runtimeId);
    }

    const support = method.support;
    if (support.status === "unsupported") {
      if (!support.reason.trim()) violations.add("unsupported_without_reason");
      continue;
    }
    if (support.surfaces.some((surface) => !provider.surfaces.includes(surface))) {
      violations.add("method_surface_outside_provider");
    }
    if (support.status !== "offered") continue;

    // A sign-in the agent runs must be one it advertises, or Hubble would be
    // offering a button nothing answers.
    if (method.owner === "runtime" && (method.runtimeMethodIds ?? []).length === 0) {
      violations.add("runtime_sign_in_without_runtime_ids");
    }
    // Hubble never collects anybody's plan login.
    if (method.owner === "hubble" && method.subscription) violations.add("hubble_held_subscription");
    // A key Hubble stores reaches only an SDK runtime's own environment, per
    // run. Agents Hubble launches as processes get an allowlisted environment
    // with no key in it (launch/env.ts), so offering one would be a lie.
    if (method.owner === "hubble" && method.kind === "api_key" && provider.transport !== "sdk") {
      violations.add("hubble_held_key_outside_sdk");
    }
    // Hubble never passes an environment credential to an agent.
    if (method.kind === "environment") violations.add("environment_credential_offered");
  }

  // An agent that is the client (the custom agent) is never started by
  // Hubble, so it has no sign-in to run, no session and no chat. Declaring
  // otherwise would be declaring a program for Hubble to launch.
  if (provider.transport === "mcp") {
    if (provider.auth.some((method) => method.owner === "runtime" && method.support.status !== "unsupported")) {
      violations.add("client_agent_with_runtime_auth");
    }
    if (provider.sessions.available) violations.add("client_agent_with_sessions");
    if (provider.chat) violations.add("client_agent_with_chat");
  }

  return [...violations];
}
