/**
 * Per-account namespacing for TabDump's local storage.
 *
 * TabDump is local-first: workspaces, tabs, collections, dependencies and
 * graph layout live in the browser, not on a server (see
 * src/lib/workspace/persistence.ts and its neighbours). Adding accounts
 * therefore doesn't move that data anywhere — it partitions it, so two
 * people signing into the same browser don't see each other's tabs, and
 * signing out doesn't hand the next person the previous one's workspace.
 *
 * The partition is a key prefix:
 *
 *   signed out        tabdump:workspaces:v1
 *   signed in as U    tabdump:u:<U>:workspaces:v1
 *
 * The signed-out keys are the *existing* ones, byte for byte. That is the
 * central guarantee here: installing accounts moves nobody's data and
 * deletes nothing. A user who never signs in sees exactly what they saw
 * before, and one who signs in and out again finds their local workspace
 * where they left it.
 */

const NAMESPACE_PREFIX = "tabdump:u:";
const BASE_PREFIX = "tabdump:";

/**
 * The keys that hold a user's own content, and therefore the ones that get
 * partitioned.
 *
 * Everything else stays global on purpose: appearance settings, the
 * onboarding state, sidebar collapse and the resolved-title cache are
 * device preferences and derived caches, not personal content — scoping
 * them would mean a signed-in user losing their theme, and would leave the
 * pre-hydration theme script in src/app/layout.tsx (which runs long before
 * any account is known) reading a key that no longer exists.
 */
export const SCOPED_STORAGE_KEYS = [
  "tabdump:workspaces:v1",
  "tabdump:collections:v1",
  "tabdump:dependencies:v1",
  "tabdump:graph:v1",
] as const;

/**
 * Module-level rather than React state because the persistence modules that
 * consume it are plain functions called from all over the app (and from
 * outside React entirely). AuthProvider is the single writer; it sets this
 * before the app shell mounts and re-mounts the shell whenever it changes,
 * so no reader ever observes a half-switched namespace.
 */
let activeUserId: string | null = null;

/** `null` while signed out. */
export function getStorageNamespace(): string | null {
  return activeUserId;
}

/** Sets (or, with `null`, clears) the account whose data this browser session reads and writes. */
export function setStorageNamespace(userId: string | null): void {
  activeUserId = userId;
}

/**
 * The key `baseKey` should actually be read from or written to right now.
 *
 * Signed out this is the identity function, which is what keeps every
 * existing stored value reachable at the key it was written under.
 */
export function scopedKey(baseKey: string): string {
  if (!activeUserId) return baseKey;
  return namespacedKey(baseKey, activeUserId);
}

/** The key `baseKey` takes inside a specific account's namespace, regardless of who is currently signed in. */
export function namespacedKey(baseKey: string, userId: string): string {
  const suffix = baseKey.startsWith(BASE_PREFIX) ? baseKey.slice(BASE_PREFIX.length) : baseKey;
  return `${NAMESPACE_PREFIX}${userId}:${suffix}`;
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** True when the signed-out namespace holds any TabDump content at all — the question "is there anything here to bring into the account?". */
export function hasAnonymousData(): boolean {
  return SCOPED_STORAGE_KEYS.some((key) => readRaw(key) !== null);
}

/** True once an account's namespace has been written to. Used to tell a first sign-in (nothing there yet) from a returning one. */
export function hasNamespaceData(userId: string): boolean {
  return SCOPED_STORAGE_KEYS.some((key) => readRaw(namespacedKey(key, userId)) !== null);
}

/**
 * Copies the signed-out data into `userId`'s namespace. Explicitly a COPY:
 * the anonymous keys are left exactly as they are, so this is reversible by
 * simply signing out, and a mistaken "yes" costs the user nothing.
 *
 * Never overwrites. A key already present in the account's namespace wins,
 * so running this twice, or running it for an account that already has
 * workspaces, cannot clobber real data.
 */
export function copyAnonymousDataInto(userId: string): { copied: string[]; failed: string[] } {
  const copied: string[] = [];
  const failed: string[] = [];

  for (const baseKey of SCOPED_STORAGE_KEYS) {
    const source = readRaw(baseKey);
    if (source === null) continue;

    const target = namespacedKey(baseKey, userId);
    if (readRaw(target) !== null) continue;

    try {
      window.localStorage.setItem(target, source);
      copied.push(baseKey);
    } catch {
      // Quota, or storage disabled mid-session. Reported rather than
      // thrown so a partial copy is visible to the caller instead of
      // aborting the sign-in that triggered it.
      failed.push(baseKey);
    }
  }

  return { copied, failed };
}
