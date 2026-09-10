import "server-only";
import { createRecordId } from "./tokens";
import type { AuthStore, AuthUser, GoogleIdentity } from "./types";

/**
 * Account lifecycle: turning a verified Google identity into a TabDump
 * user, whether or not one already exists.
 *
 * The lookup key is `googleSub` and only `googleSub`. Using the email
 * instead would be two bugs in one: a user who changes their Google address
 * would silently get a second, empty account, and someone who is later
 * assigned a released address would be handed the previous owner's. The
 * `sub` claim is stable for the life of the account and never reused, which
 * is exactly the property an identity key needs.
 */

export type FindOrCreateResult = {
  user: AuthUser;
  /** True only on the login that actually created the account — lets the caller distinguish first sign-in from a returning one. */
  created: boolean;
};

export async function findOrCreateUser(
  store: AuthStore,
  identity: GoogleIdentity
): Promise<FindOrCreateResult> {
  const existing = await store.findUserByGoogleSub(identity.googleSub);

  if (existing) {
    // Google re-asserts these on every sign-in, so this is where a changed
    // display name, a new profile picture, or a changed email catches up.
    // Skipped entirely when nothing differs, so a returning user's row
    // isn't rewritten (and `updatedAt` isn't churned) on every visit.
    const unchanged =
      existing.email === identity.email &&
      existing.name === identity.name &&
      existing.avatarUrl === identity.avatarUrl;

    if (unchanged) return { user: existing, created: false };

    const user = await store.updateUserProfile(existing.id, {
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    });
    return { user, created: false };
  }

  // The store enforces uniqueness on google_sub, so if a concurrent first
  // login for the same account slipped in between the read above and this
  // write, createUser returns that row instead of creating a second one —
  // which is why `created` is derived from the returned row's timestamps
  // rather than from "we took the insert branch".
  const user = await store.createUser({
    id: createRecordId(),
    googleSub: identity.googleSub,
    email: identity.email,
    name: identity.name,
    avatarUrl: identity.avatarUrl,
  });

  return { user, created: user.createdAt === user.updatedAt };
}
