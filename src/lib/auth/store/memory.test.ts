import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAuthStore } from "./memory";
import type { AuthSession } from "../types";

let store: MemoryAuthStore;

beforeEach(() => {
  store = new MemoryAuthStore();
});

function userInput(overrides: Partial<Parameters<MemoryAuthStore["createUser"]>[0]> = {}) {
  return {
    id: "user-1",
    googleSub: "google-sub-1",
    email: "ada@example.com",
    name: "Ada",
    avatarUrl: null,
    ...overrides,
  };
}

function sessionFor(userId: string, overrides: Partial<AuthSession> = {}): AuthSession {
  const now = Date.now();
  return {
    id: `session-${Math.random()}`,
    userId,
    tokenHash: `hash-${Math.random()}`,
    createdAt: now,
    expiresAt: now + 60_000,
    lastUsedAt: now,
    ...overrides,
  };
}

describe("MemoryAuthStore users", () => {
  it("declares itself non-durable, which is what keeps it out of production", () => {
    expect(store.durable).toBe(false);
    expect(store.kind).toBe("memory");
  });

  it("finds a created user by google subject and by id", async () => {
    const user = await store.createUser(userInput());
    expect(await store.findUserByGoogleSub("google-sub-1")).toEqual(user);
    expect(await store.findUserById(user.id)).toEqual(user);
  });

  it("returns null rather than throwing for an unknown user", async () => {
    expect(await store.findUserByGoogleSub("nobody")).toBeNull();
    expect(await store.findUserById("nobody")).toBeNull();
  });

  it("never creates a second account for the same google subject", async () => {
    const first = await store.createUser(userInput());
    const second = await store.createUser(userInput({ id: "user-2", name: "Ada Lovelace" }));

    // Mirrors Postgres's ON CONFLICT DO UPDATE: the original row survives,
    // keeping its id, with the new profile applied.
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Ada Lovelace");
    expect(await store.findUserById("user-2")).toBeNull();
  });

  it("keeps one account when the same person's Google email changes", async () => {
    const first = await store.createUser(userInput());
    const afterRename = await store.createUser(userInput({ id: "user-2", email: "ada@newdomain.example" }));

    expect(afterRename.id).toBe(first.id);
    expect(afterRename.email).toBe("ada@newdomain.example");
  });

  it("treats a different google subject with the same email as a different account", async () => {
    // The scenario the email-is-not-identity rule exists for: an address
    // released by one Google account and later assigned to another.
    const original = await store.createUser(userInput());
    const recycled = await store.createUser(userInput({ id: "user-2", googleSub: "google-sub-2" }));

    expect(recycled.id).not.toBe(original.id);
  });

  it("updates a profile without touching identity", async () => {
    const user = await store.createUser(userInput());
    const updated = await store.updateUserProfile(user.id, {
      email: "ada@example.org",
      name: "A. Lovelace",
      avatarUrl: "https://example.com/a.png",
    });

    expect(updated.id).toBe(user.id);
    expect(updated.googleSub).toBe(user.googleSub);
    expect(updated.email).toBe("ada@example.org");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(user.updatedAt);
  });

  it("throws when asked to update a user that doesn't exist", async () => {
    await expect(store.updateUserProfile("ghost", { email: "x@y.z", name: "x", avatarUrl: null })).rejects.toThrow();
  });
});

describe("MemoryAuthStore sessions", () => {
  it("finds a session by token hash", async () => {
    const session = sessionFor("user-1", { tokenHash: "hash-a" });
    await store.createSession(session);
    expect(await store.findSessionByTokenHash("hash-a")).toEqual(session);
  });

  it("returns null for an unknown token hash", async () => {
    expect(await store.findSessionByTokenHash("nope")).toBeNull();
  });

  it("bumps lastUsedAt, and expiry only when a new one is given", async () => {
    const session = sessionFor("user-1", { tokenHash: "hash-a" });
    await store.createSession(session);

    await store.touchSession(session.id, session.lastUsedAt + 1000);
    let stored = await store.findSessionByTokenHash("hash-a");
    expect(stored?.lastUsedAt).toBe(session.lastUsedAt + 1000);
    expect(stored?.expiresAt).toBe(session.expiresAt);

    await store.touchSession(session.id, session.lastUsedAt + 2000, session.expiresAt + 5000);
    stored = await store.findSessionByTokenHash("hash-a");
    expect(stored?.expiresAt).toBe(session.expiresAt + 5000);
  });

  it("makes a deleted session unfindable by its token hash", async () => {
    const session = sessionFor("user-1", { tokenHash: "hash-a" });
    await store.createSession(session);
    await store.deleteSession(session.id);
    expect(await store.findSessionByTokenHash("hash-a")).toBeNull();
  });

  it("deletes every session for one user and leaves other users' alone", async () => {
    await store.createSession(sessionFor("user-1", { tokenHash: "a" }));
    await store.createSession(sessionFor("user-1", { tokenHash: "b" }));
    await store.createSession(sessionFor("user-2", { tokenHash: "c" }));

    await store.deleteSessionsForUser("user-1");

    expect(await store.findSessionByTokenHash("a")).toBeNull();
    expect(await store.findSessionByTokenHash("b")).toBeNull();
    expect(await store.findSessionByTokenHash("c")).not.toBeNull();
  });

  it("purges only sessions that have actually expired", async () => {
    const now = Date.now();
    await store.createSession(sessionFor("user-1", { tokenHash: "old", expiresAt: now - 1 }));
    await store.createSession(sessionFor("user-1", { tokenHash: "live", expiresAt: now + 60_000 }));

    await store.deleteExpiredSessions(now);

    expect(await store.findSessionByTokenHash("old")).toBeNull();
    expect(await store.findSessionByTokenHash("live")).not.toBeNull();
  });
});
