import { launchEntryFor } from "./allowlist";
import { controlFailure } from "@/lib/agents/control/types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type {
  AdapterAuthentication,
  AdapterAuthenticationState,
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
 * This is the "native authentication flow" the architecture prefers, and it
 * keeps the provider-connections invariant intact: there is still no fallback
 * to a key in the environment (the agent's environment is allowlisted and
 * carries none), and still no operator credential. The credential is the
 * user's own, in the agent's own store.
 *
 * ## Shape
 *
 * `createNativeLoginSource` is the adapter's `ClaudeCredentialSource`: it
 * resolves "ok, with no environment of its own" only when the agent reports it
 * is signed in. `withNativeAuthentication` wraps the adapter with the
 * `AuthenticatingAdapter` extension, so the host's `authenticate_provider`
 * reaches it through the same generic seam the ACP agents use.
 */

export type NativeRunner = (operation: NativeOperation, timeoutMs: number) => Promise<NativeRunResult>;

const STATUS_TIMEOUT_MS = 20_000;
/** A person is signing in in a browser. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a status answer is trusted. Short: signing out in a terminal should be noticed. */
const STATUS_TTL_MS = 15_000;

export type NativeLoginState = {
  /** Asks the agent, or returns a recent answer. */
  status(): Promise<AdapterAuthenticationState>;
  /** The last answer, without asking. `unknown` before the first. */
  current(): AdapterAuthenticationState;
  /** Forgets the cached answer, so the next `status()` asks. */
  invalidate(): void;
  login(methodId: string): Promise<AdapterAuthenticationState | "failed">;
};

export function createNativeLoginState(options: {
  run: NativeRunner;
  now?: () => number;
}): NativeLoginState {
  const now = options.now ?? (() => Date.now());
  let cached: { state: AdapterAuthenticationState; at: number } | undefined;
  let inFlight: Promise<AdapterAuthenticationState> | undefined;

  async function ask(): Promise<AdapterAuthenticationState> {
    const result = await options.run({ kind: "status" }, STATUS_TIMEOUT_MS);
    let state: AdapterAuthenticationState = "unknown";
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
        // Only the one boolean is read. Nothing else in the reply — account
        // email, organization, plan — is kept or passed on.
        if (parsed.loggedIn === true) state = "authenticated";
        else if (parsed.loggedIn === false) state = "required";
      } catch {
        state = "unknown";
      }
    }
    cached = { state, at: now() };
    return state;
  }

  const api: NativeLoginState = {
    async status() {
      if (cached && now() - cached.at < STATUS_TTL_MS) return cached.state;
      inFlight ??= ask().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    current: () => cached?.state ?? "unknown",
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
 * in — the agent finds its own token in its own store — and refuses otherwise,
 * which the Claude adapter already turns into "sign in first".
 */
export function createNativeLoginSource(state: NativeLoginState): ClaudeCredentialSource {
  return async () => {
    const status = await state.status();
    if (status === "authenticated") return { ok: true, connectionId: "native-login", env: {} };
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
    return { state: state.current(), methods };
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
    if (!methods.some((method) => method.id === methodId)) return controlFailure("invalid-request");
    const outcome = await state.login(methodId);
    if (outcome === "failed") return controlFailure("unreachable");
    // Re-connecting moves the adapter out of "sign in first" once the agent
    // says it is signed in.
    await adapter.connect();
    if (outcome !== "authenticated") return controlFailure("configuration");
    return { ok: true, value: describe() };
  };
  return wrapped;
}
