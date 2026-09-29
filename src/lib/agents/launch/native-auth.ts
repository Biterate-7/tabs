import { launchEntryFor } from "./allowlist";
import { controlFailure } from "@/lib/agents/control/types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type {
  AdapterAuthentication,
  AdapterAuthenticationState,
  AdapterAuthKind,
  AuthenticatingAdapter,
} from "@/lib/agents/control/authentication";
import type { ClaudeCredentialSource } from "@/lib/agents/control/providers/claude-code/runtime";
import type { AgentControlAdapter, ControlResult } from "@/lib/agents/control/types";
import type { NativeOperation, NativeRunResult } from "./process";

/**
 * An SDK-driven agent that signs in with its **own** login (Phase J.1).
 *
 * ## Why the desktop app needs this
 *
 * On the web, Claude runs on the user's own Anthropic key, stored encrypted
 * server-side (BYOC). The desktop app has no server and no database, and it
 * must not store a raw credential at all. What it does have is the user's own
 * installed Claude Code, with its own login. So on the desktop, Claude signs
 * in exactly as it does in a terminal — `claude auth login` opens Anthropic's
 * sign-in page in the browser — and Hubble never sees, holds or forwards the
 * token that produces. It only asks `claude auth status` whether one exists.
 *
 * ## Which login (Agent Authentication & Runtime)
 *
 * "Signed in" is not the whole question. Anthropic's terms for apps built on
 * the Claude Agent SDK — which Hubble is — are that they use API-key
 * authentication (a Console account or an API key) or a supported cloud
 * provider, and that a third-party app may not offer Claude.ai subscription
 * login or route requests through Free/Pro/Max plan credentials
 * (code.claude.com/docs/en/agent-sdk/overview, …/legal-and-compliance). So:
 *
 *   - Hubble offers only the Console sign-in (`claude auth login --console`,
 *     "API usage billing instead of a Claude subscription").
 *   - It reads *which* login Claude Code is using from the same status reply,
 *     and a subscription login is reported as signed in **but not
 *     permitted**: the credential source refuses it, so no session starts on
 *     it. Hubble never signs the user out and never switches methods for them.
 *
 * What is read from `claude auth status`, verified against Claude Code
 * 2.1.229: `loggedIn` (boolean), `authMethod` (`"claude.ai"` for a
 * subscription login), `apiProvider` (`"firstParty"` for Anthropic's own API)
 * and whether `subscriptionType` is present. Nothing else — no email, no
 * organisation, no plan name — is kept or passed on. Either subscription
 * signal is enough to refuse; an answer that does not say which login is in
 * use is `unknown` and refused too.
 *
 * ## Shape
 *
 * `createNativeLoginSource` is the adapter's `ClaudeCredentialSource`: it
 * resolves "ok, with no environment of its own" only when the agent reports it
 * is signed in with a permitted login. `withNativeAuthentication` wraps the
 * adapter with the `AuthenticatingAdapter` extension, so the host's
 * `authenticate_provider` reaches it through the same generic seam the ACP
 * agents use.
 */

export type NativeRunner = (operation: NativeOperation, timeoutMs: number) => Promise<NativeRunResult>;

const STATUS_TIMEOUT_MS = 20_000;
/** A person is signing in in a browser. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a status answer is trusted. Short: signing out in a terminal should be noticed. */
const STATUS_TTL_MS = 15_000;

/**
 * The one `authMethod` value verified to mean a Claude subscription login
 * (Claude Code 2.1.229). Any other value is a non-subscription sign-in *only
 * if* no `subscriptionType` accompanies it.
 */
const SUBSCRIPTION_AUTH_METHODS: readonly string[] = ["claude.ai"];
/** Anthropic's own API, as `apiProvider` reports it. Anything else is a cloud provider's. */
const FIRST_PARTY_API = "firstParty";

/** What the agent said about its sign-in, reduced to closed facts. */
export type NativeLoginAnswer = {
  state: AdapterAuthenticationState;
  /** Which kind of login, when the agent said. */
  kind?: AdapterAuthKind;
  /** Whether Hubble may run sessions on it. False for a subscription. */
  permitted: boolean;
};

const UNKNOWN: NativeLoginAnswer = { state: "unknown", permitted: false };

/**
 * Reads `claude auth status --json` into closed facts.
 *
 * Exported for its tests. Fails closed: anything it cannot read is `unknown`
 * and not permitted.
 */
export function readClaudeAuthStatus(stdout: string): NativeLoginAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return UNKNOWN;
  }
  if (!parsed || typeof parsed !== "object") return UNKNOWN;
  const reply = parsed as {
    loggedIn?: unknown;
    authMethod?: unknown;
    apiProvider?: unknown;
    subscriptionType?: unknown;
  };

  if (reply.loggedIn === false) return { state: "required", permitted: false };
  if (reply.loggedIn !== true) return UNKNOWN;

  const subscription =
    (typeof reply.authMethod === "string" && SUBSCRIPTION_AUTH_METHODS.includes(reply.authMethod)) ||
    (typeof reply.subscriptionType === "string" && reply.subscriptionType.length > 0);
  if (subscription) return { state: "authenticated", kind: "subscription", permitted: false };

  if (typeof reply.apiProvider === "string" && reply.apiProvider.length > 0 && reply.apiProvider !== FIRST_PARTY_API) {
    return { state: "authenticated", kind: "cloud_provider", permitted: true };
  }

  // Signed in, first-party, and not a subscription: a Console account or an
  // API key configured in Claude Code itself — both billed as API usage.
  if (typeof reply.authMethod === "string" && reply.authMethod.length > 0) {
    return { state: "authenticated", kind: "account", permitted: true };
  }

  // Signed in, but it did not say how. Not guessed at.
  return { state: "authenticated", permitted: false };
}

export type NativeLoginState = {
  /** Asks the agent, or returns a recent answer. */
  status(): Promise<AdapterAuthenticationState>;
  /** The last answer, without asking. `unknown` before the first. */
  current(): AdapterAuthenticationState;
  /** The last answer in full — which login, and whether it may be used. */
  answer(): NativeLoginAnswer;
  /** Forgets the cached answer, so the next `status()` asks. */
  invalidate(): void;
  login(methodId: string): Promise<AdapterAuthenticationState | "failed">;
};

export function createNativeLoginState(options: {
  run: NativeRunner;
  now?: () => number;
}): NativeLoginState {
  const now = options.now ?? (() => Date.now());
  let cached: { answer: NativeLoginAnswer; at: number } | undefined;
  let inFlight: Promise<AdapterAuthenticationState> | undefined;

  async function ask(): Promise<AdapterAuthenticationState> {
    const result = await options.run({ kind: "status" }, STATUS_TIMEOUT_MS);
    // `claude auth status` exits 1 when signed out, and still prints its JSON.
    // Only the parsed reply decides; a run that printed nothing is `unknown`.
    const answer = result.ok && result.stdout ? readClaudeAuthStatus(result.stdout) : UNKNOWN;
    cached = { answer, at: now() };
    return answer.state;
  }

  const api: NativeLoginState = {
    async status() {
      if (cached && now() - cached.at < STATUS_TTL_MS) return cached.answer.state;
      inFlight ??= ask().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    current: () => cached?.answer.state ?? "unknown",
    answer: () => cached?.answer ?? UNKNOWN,
    invalidate() {
      cached = undefined;
    },
    async login(methodId) {
      const result = await options.run({ kind: "login", methodId }, LOGIN_TIMEOUT_MS);
      api.invalidate();
      if (!result.ok) return "failed";
      return api.status();
    },
  };
  return api;
}

/**
 * The credential source for an agent that uses its own login.
 *
 * Resolves with an **empty** credential environment when the agent is signed
 * in with a login Hubble may use — the agent finds its own token in its own
 * store — and refuses otherwise, which the Claude adapter already turns into
 * "sign in first". A subscription login is refused as `not_permitted`; there
 * is no fallback to any other credential.
 */
export function createNativeLoginSource(state: NativeLoginState): ClaudeCredentialSource {
  return async () => {
    const status = await state.status();
    if (status === "authenticated") {
      return state.answer().permitted
        ? { ok: true, connectionId: "native-login", env: {} }
        : { ok: false, reason: "not_permitted" };
    }
    return { ok: false, reason: status === "required" ? "not_connected" : "unavailable" };
  };
}

/** Adds the native sign-in extension to an adapter. The adapter itself is untouched. */
export function withNativeAuthentication(
  adapter: AgentControlAdapter,
  provider: AgentProviderId,
  state: NativeLoginState
): AuthenticatingAdapter {
  const labels = launchEntryFor(provider)?.native?.loginLabels ?? {};
  const methods = Object.entries(labels).map(([id, name]) => ({ id, name }));

  function describe(): AdapterAuthentication {
    const answer = state.answer();
    return {
      state: state.current(),
      methods,
      ...(answer.kind ? { kind: answer.kind } : {}),
      // Signed in with a login Hubble may not use. Said, so the UI can offer
      // the permitted method; never acted on by switching methods.
      ...(answer.state === "authenticated" && !answer.permitted ? { issue: "method_not_permitted" as const } : {}),
    };
  }

  // Delegates every member, so the capability, approval-detail, run-binding
  // and provider-session accessors the adapter carries are all still found by
  // the host's structural checks.
  const wrapped = Object.create(adapter) as AuthenticatingAdapter;
  wrapped.describeAuthentication = describe;
  wrapped.connect = async () => {
    // Asked fresh on every connect, so a login finished in a terminal is
    // picked up the next time the user presses Connect.
    state.invalidate();
    await state.status();
    return adapter.connect();
  };
  wrapped.authenticate = async (methodId: string): Promise<ControlResult<AdapterAuthentication>> => {
    // Only a method the allowlist offers. A subscription login is not one of
    // them, so no request can start it — whatever an older client sends.
    if (!methods.some((method) => method.id === methodId)) return controlFailure("invalid-request");
    const outcome = await state.login(methodId);
    if (outcome === "failed") return controlFailure("unreachable");
    // Re-connecting moves the adapter out of "sign in first" once the agent
    // says it is signed in.
    await adapter.connect();
    if (outcome !== "authenticated") return controlFailure("configuration");
    // Signed in — possibly still with a login Hubble may not use, which the
    // description says and the credential source refuses.
    return { ok: true, value: describe() };
  };
  return wrapped;
}
