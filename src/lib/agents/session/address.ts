/**
 * A session address: the smallest thing that names one run.
 *
 * ## Why this is not a router
 *
 * Hubble has no router. `AppShell` switches views with a `useState` union,
 * and the brief for this phase is explicit that a routing abstraction must
 * not be introduced to serve one surface. So this is the minimum that the
 * navigation requirement actually needs: a serialisable value identifying a
 * run and, optionally, the work item selected inside it.
 *
 * It is deliberately shaped so a later context-address system can adopt it
 * without a migration - two opaque ids and a stable textual form - but it
 * makes no claim to be one.
 *
 * ## What an address may contain
 *
 * Ids, and nothing else. Not a title, not a url, not a relative path, not a
 * project path, not an artifact id, not a provider's external id, not an
 * event summary. The run id and work item id are internally minted and carry
 * no content, which is what makes the serialised form safe to copy.
 *
 * Artifact ids are excluded on purpose even though they are also internal:
 * the phase brief names them specifically, and a session address has no
 * reason to reach that deep - a work item is the smallest thing worth
 * linking to.
 */

export type AgentSessionAddress = {
  runId: string;
  /** The work item selected inside the session, when one is. */
  workItemId?: string;
};

const RUN_PREFIX = "run:";
const ITEM_PREFIX = "item:";

/**
 * Ids are minted by the domain and are opaque, but a hand-edited address is
 * still input. Anything outside this set could otherwise put a delimiter, a
 * path separator or a scheme into a value later code splits on.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeAddressId(value: string): boolean {
  return SAFE_ID.test(value);
}

/**
 * `run:<id>` or `run:<id>/item:<id>`.
 *
 * Returns null rather than a partial address when an id is unusable, so a
 * caller cannot accidentally publish `run:undefined` or an id carrying a
 * delimiter. A null here means "this session is not linkable", which the UI
 * renders by not offering the control at all.
 */
export function encodeAgentSessionAddress(address: AgentSessionAddress): string | null {
  if (!isSafeAddressId(address.runId)) return null;
  if (address.workItemId === undefined) return `${RUN_PREFIX}${address.runId}`;
  if (!isSafeAddressId(address.workItemId)) return null;
  return `${RUN_PREFIX}${address.runId}/${ITEM_PREFIX}${address.workItemId}`;
}

/**
 * The inverse. Total: any input that is not exactly one of the two forms
 * returns null rather than a best guess, because a half-understood address
 * would open the wrong session rather than none.
 */
export function decodeAgentSessionAddress(value: string): AgentSessionAddress | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(RUN_PREFIX)) return null;

  const rest = trimmed.slice(RUN_PREFIX.length);
  const slash = rest.indexOf("/");

  if (slash === -1) {
    return isSafeAddressId(rest) ? { runId: rest } : null;
  }

  const runId = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (!isSafeAddressId(runId)) return null;
  if (!tail.startsWith(ITEM_PREFIX)) return null;

  const workItemId = tail.slice(ITEM_PREFIX.length);
  return isSafeAddressId(workItemId) ? { runId, workItemId } : null;
}
