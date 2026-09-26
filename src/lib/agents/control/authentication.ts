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

export type AdapterAuthentication = {
  state: AdapterAuthenticationState;
  methods: readonly AdapterAuthMethod[];
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
