import "server-only";
import type { AuthSession, AuthStore, AuthUser } from "../types";

/**
 * Process-local AuthStore for local development.
 *
 * Same tradeoff (and same honesty about it) as src/lib/ai/server/cache.ts:
 * it lives for the lifetime of one server process, does not survive a
 * restart, and does not span instances. That is fine for `next dev`, where
 * there is exactly one long-lived process, and it means a developer can
 * sign in and exercise the whole account system without provisioning a
 * database first.
 *
 * It is NOT fine for a serverless deployment, where every invocation may be
 * a fresh process — a session created by one request would simply not exist
 * for the next. getAuthStore() refuses to hand this back in production for
 * that reason; see ./index.ts.
 */
export class MemoryAuthStore implements AuthStore {
  readonly kind = "memory";
  readonly durable = false;

  private users = new Map<string, AuthUser>();
  private usersByGoogleSub = new Map<string, string>();
  private sessions = new Map<string, AuthSession>();
  private sessionsByTokenHash = new Map<string, string>();

  /** The synchronous form, so createUser can do its uniqueness check without an `await` in the middle of it — see the note there. */
  private lookupByGoogleSub(googleSub: string): AuthUser | null {
    const id = this.usersByGoogleSub.get(googleSub);
    return id ? (this.users.get(id) ?? null) : null;
  }

  async findUserByGoogleSub(googleSub: string): Promise<AuthUser | null> {
    return this.lookupByGoogleSub(googleSub);
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(input: Omit<AuthUser, "createdAt" | "updatedAt">): Promise<AuthUser> {
    const now = Date.now();

    // Stands in for the Postgres unique constraint on google_sub, matching
    // its ON CONFLICT DO UPDATE behaviour exactly: a second insert for the
    // same subject keeps the original row (id and createdAt intact),
    // applies the freshly asserted profile, and bumps updatedAt — so
    // findOrCreateUser's "was this row just created?" check reads the same
    // against either store.
    //
    // Synchronous check-then-write, with no `await` between the two halves,
    // because that gap is the whole problem it is standing in for: two
    // concurrent first sign-ins for the same account both reach this point
    // having seen no existing user, and an await here would let both of
    // them insert. Postgres gets this from ON CONFLICT; here it comes from
    // never yielding the event loop mid-upsert.
    const existing = this.lookupByGoogleSub(input.googleSub);
    if (existing) {
      const merged: AuthUser = {
        ...existing,
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl,
        updatedAt: now,
      };
      this.users.set(merged.id, merged);
      return merged;
    }

    const user: AuthUser = { ...input, createdAt: now, updatedAt: now };
    this.users.set(user.id, user);
    this.usersByGoogleSub.set(user.googleSub, user.id);
    return user;
  }

  async updateUserProfile(
    id: string,
    profile: Pick<AuthUser, "email" | "name" | "avatarUrl">
  ): Promise<AuthUser> {
    const existing = this.users.get(id);
    if (!existing) throw new Error("auth: user not found");
    const updated: AuthUser = { ...existing, ...profile, updatedAt: Date.now() };
    this.users.set(id, updated);
    return updated;
  }

  async createSession(session: AuthSession): Promise<void> {
    this.sessions.set(session.id, session);
    this.sessionsByTokenHash.set(session.tokenHash, session.id);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    const id = this.sessionsByTokenHash.get(tokenHash);
    return id ? (this.sessions.get(id) ?? null) : null;
  }

  async touchSession(id: string, lastUsedAt: number, expiresAt?: number): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, { ...session, lastUsedAt, expiresAt: expiresAt ?? session.expiresAt });
    }
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.sessionsByTokenHash.delete(session.tokenHash);
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.userId === userId) await this.deleteSession(session.id);
    }
  }

  async deleteExpiredSessions(now: number): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAt <= now) await this.deleteSession(session.id);
    }
  }

  /** Test-only reset, mirroring __clearServerCacheForTests in src/lib/ai/server/cache.ts. */
  __clear(): void {
    this.users.clear();
    this.usersByGoogleSub.clear();
    this.sessions.clear();
    this.sessionsByTokenHash.clear();
  }
}
