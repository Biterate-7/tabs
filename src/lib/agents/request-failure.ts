/**
 * Why a request for this person's own agent data failed, as a closed set.
 *
 * The account-scoped agent routes (`/api/agents/provider-connections`,
 * `/api/agents/remote-projects`) answer a failure with a status that already
 * says which of these it is. The deployment check comes first, so 503 means
 * the deployment cannot provide the service at all; 401 comes after it, so a
 * 401 means the service exists and this visitor is not signed in to Hubble.
 *
 * Collapsing them is how a signed-out visitor was told "this deployment is not
 * set up to store provider credentials" — a claim about the deployment that
 * the 401 itself disproves. Each surface words the four cases for itself; this
 * only decides which one it is. A request that never got a response is
 * `failed`: it proves nothing about the deployment or the account.
 */
export type AgentRequestFailure =
  /** 401: not signed in to Hubble. */
  | "sign_in_required"
  /** 403: signed in, or at least identified, and refused. */
  | "not_permitted"
  /** 503: the deployment cannot provide this service at all. */
  | "unavailable"
  /** Anything else, including no response. */
  | "failed";

export function agentRequestFailureOf(status: number | undefined): AgentRequestFailure {
  switch (status) {
    case 401:
      return "sign_in_required";
    case 403:
      return "not_permitted";
    case 503:
      return "unavailable";
    default:
      return "failed";
  }
}
