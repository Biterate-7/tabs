import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSandboxService } from "./__fixtures__/sandbox";
import { createRemoteProject, deleteRemoteProject, sweepExpiredSandboxes } from "./projects";
import { createMemoryRemoteStore } from "./store";
import { REMOTE_LIMITS } from "./types";
import type { FakeSandboxService } from "./__fixtures__/sandbox";
import type { RemoteProjectServices } from "./projects";
import type { RemoteStore } from "./store";

/**
 * Remote project lifecycle.
 *
 * The interesting properties here are about *ordering under failure* — a
 * sandbox that exists with no row is money nobody can find — and about the
 * grant, which a disposable microVM is not an excuse to skip asking for.
 */

const T0 = 1_700_000_000_000;
const ALICE = "account:alice";
const BOB = "account:bob";

let store: RemoteStore;
let sandbox: FakeSandboxService;
let services: RemoteProjectServices;
let ids: number;

beforeEach(() => {
  store = createMemoryRemoteStore();
  sandbox = createFakeSandboxService();
  ids = 0;
  services = { store, sandbox, now: () => T0, createId: () => `id${++ids}` };
});

function files(...paths: string[]) {
  return paths.map((path) => ({ path, content: new Uint8Array([1, 2, 3]) }));
}

describe("creating", () => {
  it("creates a row, a sandbox and the project's files, in that order", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: ["read_project", "write_project"],
      files: files("src/index.ts", "package.json"),
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.project.status).toBe("ready");
    expect(created.project.source).toBe("remote_upload");
    expect(created.project.scopes).toEqual(["read_project", "write_project"]);

    // Row before sandbox. The opposite order loses a microVM whenever the
    // write fails: running, billing, and nameless.
    const kinds = sandbox.calls.map((call) => call.kind);
    expect(kinds).toEqual(["ensure", "writeWorkspace"]);
    expect(sandbox.peek(created.project.sandboxName)?.files.size).toBe(2);
  });

  it("mints a sandbox name that is not derived from anything guessable", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("a.ts"),
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Someone who learns a project id must not be able to compute the handle
    // that addresses the running microVM, and no account id may leak into a
    // platform dashboard or a billing line.
    expect(created.project.sandboxName).not.toContain(created.project.id);
    expect(created.project.sandboxName).not.toContain(ALICE);
    expect(created.project.sandboxName).not.toContain("alice");
    expect(created.project.sandboxName).toMatch(/^tabdump-[a-z0-9]+$/);
  });

  it("stores the grant the user chose rather than assuming one", async () => {
    // "It runs in a disposable microVM" says who *else* is safe, not whether
    // this user consented to an agent running commands on their files.
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "Read only",
      scopes: ["read_project"],
      files: files("a.ts"),
    });

    expect(created.ok && created.project.scopes).toEqual(["read_project"]);
  });

  it("refuses a scope it cannot enforce rather than dropping it", async () => {
    // Dropping would silently narrow a grant the user believed they made.
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: ["read_project", "become_root"],
      files: files("a.ts"),
    });

    expect(created).toMatchObject({ ok: false, reason: "invalid-scopes" });
    expect(sandbox.calls).toEqual([]);
  });

  it("validates the upload before creating anything", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("../../etc/passwd"),
    });

    expect(created).toMatchObject({ ok: false, reason: "upload-rejected", detail: "traversal" });
    // A bad upload costs nothing: no row, no sandbox.
    expect(sandbox.calls).toEqual([]);
    expect(await store.listProjects(ALICE)).toEqual([]);
  });

  it("refuses at the per-owner sandbox ceiling, without touching the platform", async () => {
    for (let index = 0; index < REMOTE_LIMITS.maxSandboxesPerOwner; index += 1) {
      await createRemoteProject(services, {
        ownerId: ALICE,
        name: `p${index}`,
        scopes: [],
        files: files("a.ts"),
      });
    }
    const before = sandbox.calls.length;

    const refused = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "one too many",
      scopes: [],
      files: files("a.ts"),
    });

    expect(refused).toMatchObject({ ok: false, reason: "too-many-sandboxes" });
    expect(sandbox.calls.length).toBe(before);

    // And one account's usage never constrains another's.
    const bob = await createRemoteProject(services, {
      ownerId: BOB,
      name: "bob's",
      scopes: [],
      files: files("a.ts"),
    });
    expect(bob.ok).toBe(true);
  });

  it("marks the row failed when the platform will not produce a sandbox", async () => {
    sandbox.failNext("ensure", "failed");

    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("a.ts"),
    });

    expect(created).toMatchObject({ ok: false, reason: "sandbox-failed" });

    // The row survives, marked, rather than being deleted. A user can see what
    // happened, and the sweep has something to reclaim.
    const rows = await store.listProjects(ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    // A failed project no longer counts against the limit.
    expect(await store.countLiveSandboxes(ALICE)).toBe(0);
  });

  it("reports what the upload excluded instead of dropping it silently", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("src/index.ts", ".env", "node_modules/x/index.js"),
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.excluded).toEqual([".env", "node_modules/x/index.js"]);
    expect(sandbox.peek(created.project.sandboxName)?.files.has(".env")).toBe(false);
  });
});

describe("deleting", () => {
  it("destroys the sandbox before forgetting how to find it", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("a.ts"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await deleteRemoteProject(services, ALICE, created.project.id)).toBe(true);

    // Destroy first: the thing that costs money stops existing before the
    // thing that remembers it.
    const kinds = sandbox.calls.map((call) => call.kind);
    expect(kinds.at(-1)).toBe("destroy");
    expect(await store.findProject(ALICE, created.project.id)).toBeUndefined();
  });

  it("does not let another account delete a project or its sandbox", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("a.ts"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await deleteRemoteProject(services, BOB, created.project.id)).toBe(false);
    expect(sandbox.calls.some((call) => call.kind === "destroy")).toBe(false);
    expect(await store.findProject(ALICE, created.project.id)).toBeDefined();
  });
});

describe("the reclamation sweep", () => {
  it("stops an overdue sandbox and marks it expired, not stopped", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("a.ts"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await store.updateProject(ALICE, created.project.id, { expiresAt: T0 - 1 }, T0);

    expect(await sweepExpiredSandboxes(services, T0)).toBe(1);

    const after = await store.findProject(ALICE, created.project.id);
    // `expired` rather than `stopped`: the user did not ask, and that changes
    // what the UI should say.
    expect(after?.status).toBe("expired");
    expect(sandbox.calls.some((call) => call.kind === "stop")).toBe(true);
  });

  it("frees the concurrency the dead sandbox was holding", async () => {
    // Otherwise a user who hit the limit is blocked forever by sandboxes the
    // platform reclaimed an hour ago.
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("a.ts"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await store.updateProject(ALICE, created.project.id, { expiresAt: T0 - 1 }, T0);
    expect(await store.countLiveSandboxes(ALICE)).toBe(1);

    await sweepExpiredSandboxes(services, T0);

    expect(await store.countLiveSandboxes(ALICE)).toBe(0);
  });

  it("leaves a row alone when the stop failed, so the next sweep retries", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("a.ts"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await store.updateProject(ALICE, created.project.id, { expiresAt: T0 - 1 }, T0);
    sandbox.failNext("stop", "timeout");

    expect(await sweepExpiredSandboxes(services, T0)).toBe(0);
    expect((await store.findProject(ALICE, created.project.id))?.status).toBe("ready");
  });

  it("does not touch a sandbox that is still within its deadline", async () => {
    const created = await createRemoteProject(services, {
      ownerId: ALICE,
      name: "API service",
      scopes: [],
      files: files("a.ts"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await store.updateProject(ALICE, created.project.id, { expiresAt: T0 + 60_000 }, T0);

    expect(await sweepExpiredSandboxes(services, T0)).toBe(0);
    expect(sandbox.calls.some((call) => call.kind === "stop")).toBe(false);
  });
});
