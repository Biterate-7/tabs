import type { ClaudeCredentialSource } from "@/lib/agents/control/providers/claude-code/runtime";

/**
 * Credential sources for tests.
 *
 * ## Why a fixture rather than a mock
 *
 * A `ClaudeCredentialSource` is a one-method function type, so these are real
 * implementations of the real contract, not `vi.mock` of somebody else's
 * module. A runtime driven by one of these takes exactly the path production
 * takes — resolve, check `ok`, put `env` into a process environment — which is
 * what makes the security suite's assertions about where a credential can and
 * cannot travel assertions about production behaviour.
 *
 * ## The distinctive secret
 *
 * `LEAK_CANARY` is deliberately unmistakable and deliberately not a plausible
 * key. Tests sweep serialized events, views, journals, error payloads and API
 * responses for it: a substring search only proves something when the string
 * could not have arrived by coincidence.
 */

/** The value the leakage suite hunts for. Never a real key shape, never a real key. */
export const LEAK_CANARY = "sk-ant-test-DO-NOT-LEAK";

/**
 * A source that always resolves.
 *
 * `connectionId` defaults to something recognisable so a test asserting *which
 * user's credential reached a runtime* can do it by connection id rather than
 * by comparing secrets — which is the assertion you want anyway, because it
 * still passes when the secret is never allowed out.
 */
export function staticCredentialSource(
  secret: string = LEAK_CANARY,
  connectionId = "pc-test",
  envVar = "ANTHROPIC_API_KEY"
): ClaudeCredentialSource {
  return async () => ({ ok: true, connectionId, env: { [envVar]: secret } });
}

/** A source that never resolves, for the refusal paths. */
export function missingCredentialSource(
  reason: "not_connected" | "not_usable" | "unavailable" = "not_connected"
): ClaudeCredentialSource {
  return async () => ({ ok: false, reason });
}

/**
 * A source whose answer can change between calls.
 *
 * For the disconnect and rotation tests: a runtime resolves its credential on
 * every `start()`, so a source that flips mid-test is how "disconnecting stops
 * the *next* session" gets exercised without rebuilding the host.
 */
export function mutableCredentialSource(initial: string = LEAK_CANARY, connectionId = "pc-test") {
  let current: { secret: string; connectionId: string } | null = {
    secret: initial,
    connectionId,
  };
  const calls: string[] = [];

  const source: ClaudeCredentialSource = async () => {
    if (!current) return { ok: false, reason: "not_connected" };
    calls.push(current.connectionId);
    return {
      ok: true,
      connectionId: current.connectionId,
      env: { ANTHROPIC_API_KEY: current.secret },
    };
  };

  return {
    source,
    /** Every connection id this source has handed out, in order. */
    calls,
    rotate(secret: string, nextConnectionId = connectionId) {
      current = { secret, connectionId: nextConnectionId };
    },
    revoke() {
      current = null;
    },
  };
}

/**
 * The developer's own credential, for the opt-in integration suites.
 *
 * ## Why reading `process.env` is correct *here* and nowhere else
 *
 * This is the one context where an environment variable genuinely is "the
 * user's own provider credential": an opt-in suite, running on a developer's
 * own machine, spending that developer's own quota, gated behind
 * `TABDUMP_CLAUDE_INTEGRATION=1` and the local-runtime opt-in. There is no
 * multi-tenancy to get wrong because there is exactly one tenant.
 *
 * It is a **test fixture** — category C in docs/provider-credential-audit.md —
 * and the security suite asserts that nothing in `src/lib` outside this file
 * reads `ANTHROPIC_API_KEY` from the process environment to start a session.
 * That assertion is what stops this convenience from quietly becoming the
 * operator-key fallback the phase removed.
 */
export const machineCredentials: ClaudeCredentialSource = async () => {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return { ok: false, reason: "not_connected" };
  return { ok: true, connectionId: "pc-integration", env: { ANTHROPIC_API_KEY: key } };
};
