import { NAMESPACE_PREFIX, RETIRED_STORAGE_KEYS } from "./namespace";

/**
 * Removes storage a feature left behind when it was deleted.
 *
 * Hubble is local-first, which means deleting a feature is not finished
 * when its code is gone: whatever it wrote is still sitting in every
 * existing user's localStorage, and nothing in the shipped app can read or
 * clear it any more. `RETIRED_STORAGE_KEYS` names those keys and this sweeps
 * them.
 *
 * ## Why it sweeps by prefix rather than by key
 *
 * Scoped keys are per-account (`tabdump:u:<id>:agent-world:v1`), and this
 * runs before anybody is signed in — so the account ids that hold a retired
 * value are not knowable here. Enumerating the store and matching the
 * namespaced *shape* of each retired key is the only way to reach an account
 * the current browser session will never activate.
 *
 * ## Why it is deliberately narrow
 *
 * It removes exactly the keys listed, in exactly their two possible spellings
 * (global, and namespaced under any account). It never removes a key by
 * pattern, never touches an unknown `tabdump:` key, and never removes
 * anything belonging to another origin. A bug here deletes a user's
 * workspaces, so the blast radius is bounded by an explicit list rather than
 * by a regex over the whole store.
 */

/** Whether `storageKey` is one of `retired`, in either the global or a namespaced spelling. */
export function isRetiredKey(storageKey: string, retired: readonly string[]): boolean {
  if (retired.includes(storageKey)) return true;

  if (!storageKey.startsWith(NAMESPACE_PREFIX)) return false;

  // `tabdump:u:<id>:workspaces:v1` -> `workspaces:v1`. The account id cannot
  // contain a colon (it is a Hubble user id), so the first colon after the
  // prefix ends it.
  const afterPrefix = storageKey.slice(NAMESPACE_PREFIX.length);
  const separator = afterPrefix.indexOf(":");
  if (separator === -1) return false;

  const suffix = afterPrefix.slice(separator + 1);
  return retired.some((key) => key === `tabdump:${suffix}`);
}

/**
 * Deletes every retired key present in this browser, and reports how many
 * went.
 *
 * Safe to call more than once and safe to call when storage is unavailable —
 * a browser with localStorage disabled or full throws on access, and a
 * cleanup failing is never a reason to stop the app from starting.
 */
export function sweepRetiredStorage(
  retired: readonly string[] = RETIRED_STORAGE_KEYS
): number {
  if (retired.length === 0) return 0;

  let store: Storage;
  try {
    store = window.localStorage;
  } catch {
    return 0;
  }

  // Collected first, then removed: removing during enumeration reindexes the
  // store underneath `key(i)` and silently skips entries.
  const doomed: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && isRetiredKey(key, retired)) doomed.push(key);
    }
  } catch {
    return 0;
  }

  let removed = 0;
  for (const key of doomed) {
    try {
      store.removeItem(key);
      removed += 1;
    } catch {
      // One key refusing to go is not a reason to abandon the rest.
    }
  }

  return removed;
}
