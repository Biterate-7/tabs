// @vitest-environment node
import { describe, expect, it } from "vitest";
import { accountReference } from "@/lib/mcp/integration-tools";
import { TABDUMP_MCP_WRITE_TOOLS } from "@/lib/mcp/server";
import { authenticateBearer } from "./grants";
import { applyContextPatch, emptyContext } from "./project-context";
import { connectionStatus, createTokenConnection, listConnectionViews, revokeConnection, testConnection, updateConnection } from "./service";
import { ALICE, BOB, BOB_SPACE, ENDPOINT, ISSUER, PHYSICS, TAB_THERMO, createWorld } from "./__fixtures__/world";
import type { ConnectionRecord, CredentialRecord } from "./records";

const NOW = Date.now();

describe("connection status comes from what happened", () => {
  const base: ConnectionRecord = {
    id: "conn_x",
    userId: ALICE,
    client: "chatgpt",
    label: "ChatGPT",
    method: "oauth",
    scopes: ["hubble.read"],
    workspaceIds: [PHYSICS],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const cred = (kind: CredentialRecord["kind"], extra: Partial<CredentialRecord> = {}): CredentialRecord => ({
    id: `cred_${kind}`,
    connectionId: "conn_x",
    kind,
    tokenHash: "0".repeat(64),
    hint: "AAAA",
    createdAt: NOW,
    expiresAt: NOW + 1000,
    ...extra,
  });

  it("is setup-incomplete until the client calls, then connected", () => {
    expect(connectionStatus(base, [cred("refresh")], NOW)).toBe("waiting_for_client");
    expect(connectionStatus({ ...base, lastUsedAt: NOW }, [cred("refresh")], NOW)).toBe("connected");
  });

  it("is expired when no credential under it is live, and revoked when revoked", () => {
    expect(connectionStatus({ ...base, lastUsedAt: NOW }, [cred("refresh", { expiresAt: NOW - 1 })], NOW)).toBe("expired");
    expect(connectionStatus({ ...base, lastUsedAt: NOW }, [cred("refresh", { usedAt: NOW })], NOW)).toBe("expired");
    expect(connectionStatus({ ...base, revokedAt: NOW }, [cred("refresh")], NOW)).toBe("revoked");
    // A test credential never makes a connection look connected.
    expect(connectionStatus({ ...base, method: "token" }, [cred("test")], NOW)).toBe("expired");
  });
});

describe("token connections", () => {
  it("validates the client, label, permission and workspaces against the synced list", async () => {
    const world = createWorld();
    const grantable = new Set([PHYSICS]);
    const ask = (input: Record<string, unknown>) =>
      createTokenConnection(world.store, { userId: ALICE, client: "gemini", label: "Gemini CLI", permission: "read", workspaceIds: [PHYSICS], grantable, now: NOW, ...input });
    expect(await ask({ client: "copilot" })).toEqual({ ok: false, problem: "invalid_client" });
    expect(await ask({ label: "   " })).toEqual({ ok: false, problem: "invalid_label" });
    expect(await ask({ permission: "admin" })).toEqual({ ok: false, problem: "invalid_permission" });
    expect(await ask({ workspaceIds: [] })).toEqual({ ok: false, problem: "no_workspaces" });
    expect(await ask({ workspaceIds: [BOB_SPACE] })).toEqual({ ok: false, problem: "unknown_workspace" });
    const created = await ask({});
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.token).toMatch(/^hbpat_/);
    expect(JSON.stringify(world.store.credentials)).not.toContain(created.token);
    const views = await listConnectionViews(world.store, ALICE, NOW);
    expect(views).toEqual([expect.objectContaining({ status: "waiting_for_client", permission: "read", token: expect.objectContaining({ hint: created.token.slice(-4) }) })]);
    expect(JSON.stringify(views)).not.toContain(created.token);
  });

  it("only the owner can change or revoke a connection", async () => {
    const world = createWorld();
    const alice = await world.connect(ALICE, "read", [PHYSICS]);
    expect(await updateConnection(world.store, { userId: BOB, connectionId: alice.connection.id, permission: "write", grantable: new Set([BOB_SPACE]), now: NOW })).toEqual({ ok: false, problem: "not_found" });
    expect(await revokeConnection(world.store, BOB, alice.connection.id, NOW)).toBe(false);
    const auth = await authenticateBearer(alice.token, { store: world.store, now: NOW, resource: ENDPOINT });
    expect(auth.ok).toBe(true);
    expect(await revokeConnection(world.store, ALICE, alice.connection.id, NOW)).toBe(true);
    expect(await authenticateBearer(alice.token, { store: world.store, now: NOW, resource: ENDPOINT })).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("refuses a refresh token used as a bearer credential, and garbage before any lookup", async () => {
    const world = createWorld();
    expect(await authenticateBearer("hbrt_" + "A".repeat(43), { store: world.store, now: NOW, resource: ENDPOINT })).toMatchObject({ ok: false, reason: "malformed" });
    expect(await authenticateBearer("../../etc/passwd", { store: world.store, now: NOW, resource: ENDPOINT })).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("the connection test", () => {
  it("passes every step for a read-only connection, over the real MCP endpoint", async () => {
    const world = createWorld();
    const alice = await world.connect(ALICE, "read", [PHYSICS]);
    const result = await testConnection(world.store, {
      userId: ALICE,
      connectionId: alice.connection.id,
      issuer: ISSUER,
      fetch: world.fetchMcp as typeof fetch,
      expectedAccountRef: accountReference(ALICE),
      writeTools: TABDUMP_MCP_WRITE_TOOLS,
      now: () => Date.now(),
    });
    expect(result?.ok).toBe(true);
    expect(result?.steps.map((s) => s.id)).toEqual(["handshake", "identity", "listing", "permissions"]);
    // The test credential is revoked afterwards, and the test is not the client.
    expect(world.store.credentials.filter((c) => c.kind === "test").every((c) => c.revokedAt !== undefined)).toBe(true);
    const views = await listConnectionViews(world.store, ALICE, Date.now());
    expect(views[0].status).toBe("waiting_for_client");
    expect(world.store.activity.some((a) => a.operation === "connection_test" && a.outcome === "ok")).toBe(true);
  });

  it("passes for read and save, and fails honestly when the account is not the one expected", async () => {
    const world = createWorld();
    const alice = await world.connect(ALICE, "write", [PHYSICS]);
    const ok = await testConnection(world.store, { userId: ALICE, connectionId: alice.connection.id, issuer: ISSUER, fetch: world.fetchMcp as typeof fetch, expectedAccountRef: accountReference(ALICE), writeTools: TABDUMP_MCP_WRITE_TOOLS, now: () => Date.now() });
    expect(ok?.ok).toBe(true);
    const wrong = await testConnection(world.store, { userId: ALICE, connectionId: alice.connection.id, issuer: ISSUER, fetch: world.fetchMcp as typeof fetch, expectedAccountRef: accountReference(BOB), writeTools: TABDUMP_MCP_WRITE_TOOLS, now: () => Date.now() });
    expect(wrong?.ok).toBe(false);
    expect(wrong?.steps.find((s) => s.id === "identity")?.ok).toBe(false);
  });

  it("fails at the handshake when the endpoint does not speak MCP", async () => {
    const world = createWorld();
    const alice = await world.connect(ALICE, "read", [PHYSICS]);
    const result = await testConnection(world.store, {
      userId: ALICE,
      connectionId: alice.connection.id,
      issuer: ISSUER,
      fetch: (async () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch,
      expectedAccountRef: accountReference(ALICE),
      writeTools: TABDUMP_MCP_WRITE_TOOLS,
      now: () => Date.now(),
    });
    expect(result).toMatchObject({ ok: false, steps: [expect.objectContaining({ id: "handshake", ok: false })] });
  });
});

describe("project context patches", () => {
  const source = { kind: "integration", client: "claude", connectionId: "conn_x" } as const;
  const tabs = new Set([TAB_THERMO]);

  it("adds, never deletes, and does not repeat an identical save", () => {
    const start = emptyContext(ALICE, PHYSICS, NOW, source);
    const first = applyContextPatch(start, { goal: "Pass", addDecisions: ["A"], addTasks: ["T"] }, { workspaceTabIds: tabs, source, now: NOW });
    if (!first.ok) throw new Error(first.problem);
    expect(first.record.revision).toBe(1);
    const again = applyContextPatch(first.record, { goal: "Pass", addDecisions: ["A"], addTasks: ["T"] }, { workspaceTabIds: tabs, source, now: NOW });
    if (!again.ok) throw new Error(again.problem);
    expect(again.changed).toEqual([]);
    expect(again.record.revision).toBe(1);
  });

  it("refuses unknown tasks, foreign tabs, empty patches and oversized batches", () => {
    const start = emptyContext(ALICE, PHYSICS, NOW, source);
    const opts = { workspaceTabIds: tabs, source, now: NOW };
    expect(applyContextPatch(start, {}, opts)).toEqual({ ok: false, problem: "empty_patch" });
    expect(applyContextPatch(start, { completeTaskIds: ["task_nope"] }, opts)).toEqual({ ok: false, problem: "unknown_task" });
    expect(applyContextPatch(start, { linkTabIds: ["not-a-tab"] }, opts)).toEqual({ ok: false, problem: "unknown_tab" });
    expect(applyContextPatch(start, { addTasks: Array.from({ length: 21 }, (_, i) => `t${i}`) }, opts)).toEqual({ ok: false, problem: "too_many_items" });
  });

  it("strips invisible characters that could hide text from a reader", () => {
    const start = emptyContext(ALICE, PHYSICS, NOW, source);
    const zeroWidth = String.fromCharCode(0x200b);
    const override = String.fromCharCode(0x202e);
    const patched = applyContextPatch(start, { goal: `Pass${zeroWidth} the ${override}exam` }, { workspaceTabIds: tabs, source, now: NOW });
    expect(patched.ok && patched.record.goal).toBe("Pass the exam");
  });
});
