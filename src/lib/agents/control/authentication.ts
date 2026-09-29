import type { AgentControlAdapter, ControlResult } from "./types";

/**
 * How an adapter says whether its agent is signed in, and lets the user sign
 * it in through the agent's **own** flow.
 *
 * ## Why this is an extension and not part of `AgentControlAdapter`
 *
 * The same reason `approval-details.ts` is. The generic contract must read
 * identically whether or not any particular provider exists, and "sign in"
 * means different things to different agents: one opens a browser for a
 * Google account, one reads a login a CLI already holds, one has no such
 * concept and runs on a key the user stored in Hubble. A method on the base
 * interface would force every adapter to pretend to one of those.
 *
 * So an adapter that genuinely has a native sign-in exposes these two
 * members, and the host checks for them — exactly as the service checks for
 * `takeApprovalDetails`.
 *
 * ## What never crosses this seam
 *
 * A credential. `authenticate` takes a *method id* the agent itself
 * advertised, and the agent does the rest on the user's machine — typically
 * by opening a browser to the provider's own sign-in page. Hubble never sees
 * a password, a token or a key on this path, never stores one, and has no
 * parameter it could put one in.
 */

/** A sign-in method, as the agent described it. Labels only. */
export type AdapterAuthMethod = { id: string; name: string; description?: string };

/**
 * What Hubble knows about the agent's sign-in.
 *
 * `unknown` is the common, honest answer: most agents only reveal that they
 * are signed out when asked to start a session.
 */
export type AdapterAuthenticationState = "unknown" | "authenticated" | "required";

/**
 * Which *kind* of sign-in the agent says it is using, when it says.
 *
 * A closed set and only ever a kind — never the account, the organisation,
 * the plan or anything else the agent printed. It exists because "signed in"
 * is not the whole question: a provider can permit one kind of credential in
 * a third-party app and forbid another (Anthropic permits an API key or a
 * Console account for apps built on the Agent SDK, and does not permit a
 * Claude subscription). See docs/agent-authentication.md.
 *
 *   - `subscription` — a consumer plan's sign-in (Claude Pro/Max/Team, …).
 *   - `account` — the provider's own account sign-in that is not a plan's,
 *     e.g. an Anthropic Console account billed as API usage.
 *   - `api_key` — an API key.
 *   - `cloud_provider` — a cloud platform's credential (Bedrock, Vertex, …).
 */
export type AdapterAuthKind = "subscription" | "account" | "api_key" | "cloud_provider";

export const ADAPTER_AUTH_KINDS: readonly AdapterAuthKind[] = [
  "subscription",
  "account",
  "api_key",
  "cloud_provider",
] as const;

/**
 * Why a signed-in agent still cannot run a Hubble session.
 *
 * `method_not_permitted`: the agent is signed in with a kind of credential its
 * provider does not permit third-party apps to use. The adapter refuses to
 * start a session on it — Hubble never switches the agent to another method.
 */
export type AdapterAuthIssue = "method_not_permitted";

export type AdapterAuthentication = {
  state: AdapterAuthenticationState;
  methods: readonly AdapterAuthMethod[];
  /** The kind of sign-in the agent reported, when it reported one. */
  kind?: AdapterAuthKind;
  /** Present only when the sign-in cannot be used by Hubble. */
  issue?: AdapterAuthIssue;
};

export type AuthenticatingAdapter = AgentControlAdapter & {
  describeAuthentication(): AdapterAuthentication;
  /** Starts the agent's own sign-in flow for one advertised method. */
  authenticate(methodId: string): Promise<ControlResult<AdapterAuthentication>>;
};

export function hasAdapterAuthentication(
  adapter: AgentControlAdapter
): adapter is AuthenticatingAdapter {
  const candidate = adapter as Partial<AuthenticatingAdapter>;
  return (
    typeof candidate.describeAuthentication === "function" &&
    typeof candidate.authenticate === "function"
  );
}
