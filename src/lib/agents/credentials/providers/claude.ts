import { credentialValidation } from "../types";
import type { CredentialInputShape, ProviderCredentialAdapter } from "../registry";
import type { CredentialValidation, ResolvedProviderCredential } from "../types";

/**
 * Claude, authenticated with the user's own Anthropic API credentials.
 *
 * ## Why an API key and not a "Connect Claude account" button
 *
 * Anthropic documents two authentication mechanisms for software that is not
 * the user sitting at their own terminal: an API key on the `x-api-key`
 * header, and Workload Identity Federation for service-to-service deployments.
 * The OAuth flow it documents (`ant auth login`) writes a profile into a
 * developer's own config directory for that developer's own tools; it is not a
 * delegated grant that a hosted third-party product can hold on somebody's
 * behalf, and there is no documented mechanism by which it could be.
 *
 * So the supported route for a user-facing product is the API key, and that is
 * what this implements. The UI says **Connect Anthropic API**, never "Connect
 * your Claude account", because the second sentence would describe an
 * authorization the user never gave and a capability Hubble does not have.
 *
 * When Anthropic publishes a delegated flow for third-party applications, it
 * becomes a second entry in `authMethods` and a second branch in `input` and
 * `prepareRuntimeCredential`. Nothing above this file changes — which is the
 * whole reason `ProviderAuthMethod` is a union rather than a boolean.
 *
 * ## Why this file uses `fetch` rather than the Anthropic SDK
 *
 * `@anthropic-ai/sdk` is not a direct dependency of this project (it arrives
 * transitively under the agent SDK, which is not a thing to build on). More to
 * the point, this is the one request in Hubble whose *inputs and outputs both
 * need to be tightly controlled*: exactly one header carries the secret,
 * nothing about the response is retained beyond its status, and no client
 * object holding the key outlives the call. Forty lines of `fetch` make all
 * three of those visible in one screen; a client construction does not.
 */

/**
 * The validation request.
 *
 * `GET /v1/models?limit=1` is the cheapest authenticated endpoint Anthropic
 * exposes: it requires the credential, proves the provider accepts it, spends
 * no tokens and costs nothing. §5's three requirements — syntactically
 * acceptable, provider accepts authentication, provider responds successfully —
 * are exactly what a 200 from it establishes.
 *
 * What it deliberately is not: a one-token `POST /v1/messages`. That would
 * bill the user to check a key, and a validation that costs money is a
 * validation people avoid running.
 */
const VALIDATION_URL = "https://api.anthropic.com/v1/models?limit=1";

/** Anthropic's required version header. Pinned; an unversioned request is rejected. */
const API_VERSION = "2023-06-01";

/** How long to wait before calling the provider unreachable. */
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * The environment variable the Claude runtime reads.
 *
 * The same name the deployment-wide operator key used to be read from — but
 * the *direction* has reversed, and that is the whole phase. Nothing reads
 * this from `process.env` to start a user's session any more. It is now only
 * ever a name Hubble *writes*, into the environment of one provider process,
 * carrying one user's own credential.
 */
export const ANTHROPIC_KEY_ENV_VAR = "ANTHROPIC_API_KEY";

/**
 * The shape an Anthropic key has.
 *
 * Checked before a request is made, so an obvious typo costs nothing and a
 * pasted paragraph never leaves the machine. Deliberately loose about the
 * suffix — matching Anthropic's exact key format would mean this check starts
 * rejecting valid keys the day the format gains a variant, which is a much
 * worse failure than letting one bad string reach a 401.
 */
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{16,}$/;

function looksLikeKey(secret: string): boolean {
  return KEY_PATTERN.test(secret);
}

const INPUT: CredentialInputShape = {
  label: "Anthropic API key",
  kind: "secret",
  // Not a prefix of a real key, and not a plausible one either: a placeholder
  // that looked real is a placeholder somebody eventually pastes.
  placeholder: "sk-ant-...",
  issueUrl: "https://console.anthropic.com/settings/keys",
  explanation:
    "Use your own Anthropic API credentials. Hubble does not provide a shared Claude account, and your key is only ever used for your own sessions.",
};

export function createClaudeCredentialAdapter(options?: {
  /** Injected so validation is testable without the network. */
  fetchImpl?: typeof fetch;
}): ProviderCredentialAdapter {
  const doFetch = options?.fetchImpl ?? fetch;

  return {
    provider: "claude-code",
    // One method, and the list is the truth rather than the ambition.
    // `workload_identity` is a real Anthropic mechanism and is deliberately
    // absent: nothing here implements it, and listing it would offer the user
    // a path that dead-ends.
    authMethods: ["api_key"],
    defaultDisplayName: "Anthropic API",

    input(method) {
      return method === "api_key" ? INPUT : undefined;
    },

    async validate(secret, method): Promise<CredentialValidation> {
      if (method !== "api_key") return credentialValidation("validation_failed");

      const trimmed = secret.trim();
      if (!looksLikeKey(trimmed)) return credentialValidation("malformed_credential");

      // An explicit timeout rather than whatever the platform's default is. A
      // validation that hangs for a minute reads to the user as a broken
      // product, and "provider unreachable" is both true and actionable.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), VALIDATION_TIMEOUT_MS);

      let response: Response;
      try {
        response = await doFetch(VALIDATION_URL, {
          method: "GET",
          headers: {
            // The credential's only appearance in this function.
            "x-api-key": trimmed,
            "anthropic-version": API_VERSION,
          },
          signal: abort.signal,
        });
      } catch {
        // Network failure, DNS, TLS, or our own timeout. None of these says
        // anything about the key, and reporting them as `invalid_credentials`
        // would send a user to regenerate a key that was fine.
        return credentialValidation("provider_unavailable");
      } finally {
        clearTimeout(timer);
      }

      // The response body is never read. Not parsed, not logged, not stored.
      // Only the status is consulted, which is all §5 needs and is the one
      // reading of the response that cannot carry anything back out.
      return credentialValidation(codeForStatus(response.status));
    },

    prepareRuntimeCredential({ connectionId, secret, method }): ResolvedProviderCredential | undefined {
      if (method !== "api_key") return undefined;

      return {
        connectionId,
        provider: "claude-code",
        authMethod: "api_key",
        env: { [ANTHROPIC_KEY_ENV_VAR]: secret },
      };
    },
  };
}

/**
 * The provider's status code, reduced to one of ours.
 *
 * A closed mapping rather than a range check, so a status nobody anticipated
 * lands on `validation_failed` — which says "we do not know" — rather than
 * being guessed into a bucket that tells the user something false.
 */
function codeForStatus(status: number) {
  if (status >= 200 && status < 300) return "connection_valid" as const;

  switch (status) {
    case 401:
    case 403:
      return "invalid_credentials" as const;
    case 429:
      return "rate_limited" as const;
    default:
      // 5xx and anything else. The provider is having a problem, or we are
      // talking to something that is not the provider.
      return status >= 500 ? ("provider_unavailable" as const) : ("validation_failed" as const);
  }
}
