import { describe, expect, it } from "vitest";
import { checkSandboxLimit, checkSessionLimit, createMemoryRemoteStore } from "./store";
import { REMOTE_LIMITS } from "./types";
import type { RemoteStore } from "./store";
import type { RemoteProject, RemoteSession } from "./types";

/**
 * Multi-user isolation, driven method by method.
 *
 * TabDump is now a hosted product, and the failure this file exists to make
 * impossible is one account reaching another's sandbox. The rule the store
 * encodes is that ownership is part of every *query* rather than a check
 * performed on a row that has already been fetched — so each test below asks
 * for something real with the wrong owner and expects the same answer it would
 * get for something that does not exist.
 */

const T0 = 1_700_000_000_000;
const ALICE = "account:alice";
const BOB = "account:bob";

function project(over: Partial<RemoteProject> = {}): RemoteProject {
  return {
    id: "rp-1",
    ownerId: ALICE,
    name: "API service",
    source: "remote_upload",
    sandboxName: "tabdump-aaaabbbbcccc",
    scopes: ["read_project"],
    status: "ready",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function session(over: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: "cs-1",
    ownerId: ALICE,
    projectId: "rp-1",
    provider: "claude-code",
    sandboxName: "tabdump-aaaabbbbcccc",
    commandId: "cmd-1",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

async function seeded(): Promise<RemoteStore> {
  const store = createMemoryRemoteStore();
  await store.createProject(project());
  await store.createSession(session());
  return store;
}

describe("cross-account isolation", () => {
  it("does not return another account's project", async () => {
    const store = await seeded();

    expect(await store.findProject(ALICE, "rp-1")).toBeDefined();
    // Indistinguishable from a project that never existed, which is the
    // answer a probe should get.
    expect(await store.findProject(BOB, "rp-1")).toBeUndefined();
  });

  it("does not list another account's projects", async () => {
    const store = await seeded();

    expect(await store.listProjects(ALICE)).toHaveLength(1);
    expect(await store.listProjects(BOB)).toEqual([]);
  });

  it("does not update another account's project", async () => {
    const store = await seeded();

    expect(await store.updateProject(BOB, "rp-1", { status: "failed" }, T0 + 1)).toBeUndefined();

    // And the row is untouched, not merely the answer withheld.
    const after = await store.findProject(ALICE, "rp-1");
    expect(after?.status).toBe("ready");
  });

  it("does not delete another account's project", async () => {
    const store = await seeded();

    expect(await store.deleteProject(BOB, "rp-1")).toBe(false);
    expect(await store.findProject(ALICE, "rp-1")).toBeDefined();
  });

  it("does not return, update or delete another account's session", async () => {
    const store = await seeded();

    expect(await store.findSession(BOB, "cs-1")).toBeUndefined();
    expect(await store.listSessions(BOB)).toEqual([]);
    expect(await store.updateSession(BOB, "cs-1", { commandId: "cmd-evil" }, T0 + 1)).toBeUndefined();
    expect(await store.deleteSession(BOB, "cs-1")).toBe(false);

    const after = await store.findSession(ALICE, "cs-1");
    expect(after?.commandId).toBe("cmd-1");
  });

  it("counts only the asking account's rows", async () => {
    const store = await seeded();
    await store.createProject(project({ id: "rp-2", ownerId: BOB, sandboxName: "tabdump-dddd11112222" }));

    expect(await store.countLiveSandboxes(ALICE)).toBe(1);
    expect(await store.countLiveSandboxes(BOB)).toBe(1);
    expect(await store.countLiveSessions(BOB)).toBe(0);
  });
});

describe("patches", () => {
  it("does not clear a field the caller did not mention", async () => {
    // The spread-with-optionals bug, and here it would clear the handle on a
    // live agent process.
    const store = await seeded();

    const updated = await store.updateSession(ALICE, "cs-1", { providerSessionId: "ps-9" }, T0 + 5);

    expect(updated?.commandId).toBe("cmd-1");
    expect(updated?.providerSessionId).toBe("ps-9");
    expect(updated?.updatedAt).toBe(T0 + 5);
  });

  it("keeps a project's sandbox name when only the status moves", async () => {
    const store = await seeded();

    const updated = await store.updateProject(ALICE, "rp-1", { status: "expired" }, T0 + 5);

    expect(updated?.sandboxName).toBe("tabdump-aaaabbbbcccc");
    expect(updated?.status).toBe("expired");
  });
});

describe("lifecycle bookkeeping", () => {
  it("stops counting a sandbox once it is dead", async () => {
    const store = await seeded();
    expect(await store.countLiveSandboxes(ALICE)).toBe(1);

    await store.updateProject(ALICE, "rp-1", { status: "expired" }, T0 + 1);

    // Otherwise a user who hit the concurrency limit could never create
    // another project, blocked by sandboxes that no longer exist.
    expect(await store.countLiveSandboxes(ALICE)).toBe(0);
  });

  it("takes a project's sessions with it", async () => {
    const store = await seeded();

    await store.deleteProject(ALICE, "rp-1");

    // A session row pointing at a deleted project names a sandbox nothing can
    // resolve any more.
    expect(await store.findSession(ALICE, "cs-1")).toBeUndefined();
  });

  it("finds only live sandboxes past their deadline", async () => {
    const store = createMemoryRemoteStore();
    await store.createProject(project({ id: "live", expiresAt: T0 + 10_000, sandboxName: "tabdump-l1" }));
    await store.createProject(project({ id: "overdue", expiresAt: T0 - 1, sandboxName: "tabdump-o1" }));
    await store.createProject(
      project({ id: "already-dead", expiresAt: T0 - 1, status: "expired", sandboxName: "tabdump-d1" })
    );
    await store.createProject(project({ id: "no-deadline", sandboxName: "tabdump-n1" }));

    const expired = await store.findExpired(T0, 10);

    expect(expired.map((entry) => entry.projectId)).toEqual(["overdue"]);
    // The sweep needs an owner to scope its follow-up writes, and nothing else.
    expect(expired[0]).toEqual({
      projectId: "overdue",
      ownerId: ALICE,
      sandboxName: "tabdump-o1",
    });
  });
});

describe("limits", () => {
  it("refuses another sandbox at the per-owner ceiling", async () => {
    const store = createMemoryRemoteStore();
    for (let index = 0; index < REMOTE_LIMITS.maxSandboxesPerOwner; index += 1) {
      await store.createProject(project({ id: `rp-${index}`, sandboxName: `tabdump-s${index}` }));
    }

    expect(await checkSandboxLimit(store, ALICE)).toBe("too-many-sandboxes");
    // One account's usage never constrains another's.
    expect(await checkSandboxLimit(store, BOB)).toBeNull();
  });

  it("refuses another session at the per-owner ceiling", async () => {
    const store = createMemoryRemoteStore();
    for (let index = 0; index < REMOTE_LIMITS.maxSessionsPerOwner; index += 1) {
      await store.createSession(session({ id: `cs-${index}` }));
    }

    expect(await checkSessionLimit(store, ALICE)).toBe("too-many-sessions");
    expect(await checkSessionLimit(store, BOB)).toBeNull();
  });
});
