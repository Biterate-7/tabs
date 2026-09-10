import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUser } from "./account";
import { MemoryAuthStore } from "./store/memory";
import type { GoogleIdentity } from "./types";

let store: MemoryAuthStore;

beforeEach(() => {
  store = new MemoryAuthStore();
});

const ADA: GoogleIdentity = {
  googleSub: "115625890123456789012",
  email: "ada@example.com",
  name: "Ada Lovelace",
  avatarUrl: "https://lh3.googleusercontent.com/ada",
};

describe("findOrCreateUser", () => {
  it("creates an account on a first sign-in", async () => {
    const { user, created } = await findOrCreateUser(store, ADA);

    expect(created).toBe(true);
    expect(user.googleSub).toBe(ADA.googleSub);
    expect(user.email).toBe(ADA.email);
    // TabDump's own id, not Google's — this is what the rest of the app
    // scopes data by.
    expect(user.id).not.toBe(ADA.googleSub);
  });

  it("returns the same account on every later sign-in, never a duplicate", async () => {
    const first = await findOrCreateUser(store, ADA);
    const second = await findOrCreateUser(store, ADA);
    const third = await findOrCreateUser(store, ADA);

    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(third.user.id).toBe(first.user.id);
  });

  it("refreshes name and avatar when Google reports new ones", async () => {
    const first = await findOrCreateUser(store, ADA);
    const { user } = await findOrCreateUser(store, {
      ...ADA,
      name: "Ada L.",
      avatarUrl: "https://lh3.googleusercontent.com/ada-v2",
    });

    expect(user.id).toBe(first.user.id);
    expect(user.name).toBe("Ada L.");
    expect(user.avatarUrl).toBe("https://lh3.googleusercontent.com/ada-v2");
  });

  it("leaves the record untouched when nothing changed", async () => {
    const first = await findOrCreateUser(store, ADA);
    const second = await findOrCreateUser(store, ADA);

    // No profile write means no updatedAt churn on every single visit.
    expect(second.user.updatedAt).toBe(first.user.updatedAt);
  });

  it("keeps the same account when the Google email changes", async () => {
    const first = await findOrCreateUser(store, ADA);
    const { user, created } = await findOrCreateUser(store, { ...ADA, email: "ada@newjob.example" });

    expect(created).toBe(false);
    expect(user.id).toBe(first.user.id);
    expect(user.email).toBe("ada@newjob.example");
  });

  it("does not hand a released email address the previous owner's account", async () => {
    // Same email, different Google subject: a genuinely different person.
    // Looking accounts up by email instead of `sub` is what this prevents.
    const original = await findOrCreateUser(store, ADA);
    const someoneElse = await findOrCreateUser(store, { ...ADA, googleSub: "999888777666555444333" });

    expect(someoneElse.created).toBe(true);
    expect(someoneElse.user.id).not.toBe(original.user.id);
  });

  it("converges on one account when two first sign-ins race", async () => {
    // Both calls see "no such user" before either writes — the store's
    // uniqueness on googleSub is what has to break the tie.
    const [a, b] = await Promise.all([findOrCreateUser(store, ADA), findOrCreateUser(store, ADA)]);

    expect(a.user.id).toBe(b.user.id);
    expect(await store.findUserByGoogleSub(ADA.googleSub)).not.toBeNull();
  });
});
