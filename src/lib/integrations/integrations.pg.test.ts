// @vitest-environment node
/**
 * The AI integration layer against real PostgreSQL.
 *
 * Real below the network: the integration schema and store, the sync schema
 * and `SyncService` (seeded through `initial`, as a device uploads), the MCP
 * handler, and the official MCP client. What this proves that the in-memory
 * suites cannot: the schema's constraints hold, the compare-and-set
 * transitions hold across concurrent connections, and an AI client's write
 * really lands in the account copy a second device pulls.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Pool } from "pg";
import { SyncService } from "@/lib/sync/service";
import { SYNC_CURSOR_START } from "@/lib/sync/types";
import { createSyncMcpData } from "@/lib/mcp/data";
import { handleMcpHttpRequest } from "@/lib/mcp/http";
import { sha256Hex } from "./credentials";
import { approveAuthorization, exchangeToken, registerClient, validateAuthorizationRequest } from "./oauth";
import { decideProposal } from "./proposals";
import { createTokenConnection } from "./service";
import { createPostgresIntegrationStore } from "./store-postgres";
import { describePostgres, freshDatabase, seedUser } from "../../../test/pg/database";
import type { IntegrationStore } from "./store";

const SCHEMA = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
const ISSUER = "https://hubble.test";
const ENDPOINT = `${ISSUER}/api/mcp`;
const T = 1_700_000_000_000;

describePostgres("AI integrations against real PostgreSQL", () => {
  let pool: Pool;
  let store: IntegrationStore;
  let sync: SyncService;
  let alice: string;
  let bob: string;
  let workspace: string;
  let bobWorkspace: string;
  let tabs: string[];

  beforeEach(async () => {
    const db = await freshDatabase();
    pool = db.pool;
    await pool.query(SCHEMA);
    // Applying it twice is a no-op.
    await pool.query(SCHEMA);
    alice = await seedUser(pool, "alice");
    bob = await seedUser(pool, "bob");
    sync = new SyncService(pool);
    store = createPostgresIntegrationStore(pool);
    workspace = randomUUID();
    bobWorkspace = randomUUID();
    tabs = [randomUUID(), randomUUID(), randomUUID()];
    const seeded = await sync.initial(
      {
        workspace: { id: workspace, name: "Physics project", createdAt: T, updatedAt: T },
        upserts: tabs.map((id, i) => ({
          entityType: "tab" as const,
          entity: { id, url: `https://physics.example.edu/relativity/${i}`, title: `Relativity worked examples ${i}`, createdAt: T, updatedAt: T },
        })),
      },
      alice,
      null
    );
    const seededBob = await sync.initial({ workspace: { id: bobWorkspace, name: "Bob only", createdAt: T, updatedAt: T }, upserts: [] }, bob, null);
    if (!seeded.ok || !seededBob.ok) throw new Error("seed failed");
  });

  const deps = () => ({ data: createSyncMcpData({ sync }), integration: { store, sync } });

  async function connect(token: string) {
    const client = new Client({ name: "pg-integration", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (url, init) => handleMcpHttpRequest(new Request(url, init), deps()),
      })
    );
    return client;
  }

  const json = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);

  it("stores only hashes, and the schema refuses plaintext secrets, unknown scopes and empty grants", async () => {
    const created = await createTokenConnection(store, { userId: alice, client: "gemini", label: "Gemini CLI", permission: "read", workspaceIds: [workspace], grantable: new Set([workspace]), now: Date.now() });
    if (!created.ok) throw new Error(created.problem);
    const { rows } = await pool.query("SELECT token_hash FROM hubble_integration_credentials");
    expect(rows).toEqual([{ token_hash: sha256Hex(created.token) }]);

    await expect(
      pool.query(`INSERT INTO hubble_integration_credentials (id, connection_id, kind, token_hash, hint, created_at, expires_at) VALUES ('c', $1, 'personal', $2, 'abcd', 1, 2)`, [created.connection.id, created.token])
    ).rejects.toThrow();
    await expect(
      pool.query(`INSERT INTO hubble_integration_connections (id, user_id, client, label, method, scopes, workspace_ids, created_at, updated_at) VALUES ('x', $1, 'claude', 'l', 'token', ARRAY['hubble.admin'], ARRAY['w'], 1, 1)`, [alice])
    ).rejects.toThrow();
    await expect(
      pool.query(`INSERT INTO hubble_integration_connections (id, user_id, client, label, method, scopes, workspace_ids, created_at, updated_at) VALUES ('y', $1, 'claude', 'l', 'token', ARRAY['hubble.write'], ARRAY['w'], 1, 1)`, [alice])
    ).rejects.toThrow();
    await expect(
      pool.query(`INSERT INTO hubble_integration_connections (id, user_id, client, label, method, scopes, workspace_ids, created_at, updated_at) VALUES ('z', $1, 'claude', 'l', 'token', ARRAY['hubble.read'], ARRAY[]::text[], 1, 1)`, [alice])
    ).rejects.toThrow();
  });

  it("redeems an authorization code exactly once under concurrency, and a refresh token too", async () => {
    const client = (await registerClient(store, { client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/x"] }, Date.now())).body as { client_id: string };
    const verifier = "v".repeat(43);
    const { createHash } = await import("node:crypto");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const v = await validateAuthorizationRequest(store, { response_type: "code", client_id: client.client_id, code_challenge: challenge, code_challenge_method: "S256" }, ISSUER);
    if (!v.ok) throw new Error(v.description);
    const approved = await approveAuthorization(store, { request: v.request, issuer: ISSUER, userId: alice, level: "write", workspaceIds: [workspace], grantableWorkspaceIds: new Set([workspace]), now: Date.now() });
    if (!approved.ok) throw new Error(approved.reason);
    const code = new URL(approved.location).searchParams.get("code")!;
    const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id });

    const results = await Promise.all([1, 2, 3].map(() => exchangeToken(store, new URLSearchParams(body), undefined, ISSUER, Date.now())));
    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);

    const refresh = String(winners[0].body.refresh_token);
    const rotations = await Promise.all([1, 2].map(() => exchangeToken(store, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id }), undefined, ISSUER, Date.now())));
    expect(rotations.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  it("an AI client's write lands in the account copy a device pulls, and isolation holds in SQL", async () => {
    const created = await createTokenConnection(store, { userId: alice, client: "claude", label: "Claude Code", permission: "write", workspaceIds: [workspace], grantable: new Set([workspace]), now: Date.now() });
    if (!created.ok) throw new Error(created.problem);
    const client = await connect(created.token);

    const made = json(await client.callTool({ name: "create_collection", arguments: { workspaceId: workspace, name: "Relativity", resourceIds: [tabs[0]] } }));
    expect(made.created).toBe(true);

    const page = await sync.pull(workspace, alice, SYNC_CURSOR_START);
    const collection = page!.changes.find((change) => change.operation === "upsert" && change.entityType === "collection");
    expect(collection && "entity" in collection && collection.entity).toMatchObject({ id: made.collectionId, name: "Relativity", tabIds: [tabs[0]] });

    const forged = await client.callTool({ name: "create_collection", arguments: { workspaceId: bobWorkspace, name: "Stolen" } });
    expect(forged.isError).toBe(true);
    expect((await sync.pull(bobWorkspace, bob, SYNC_CURSOR_START))!.changes.some((c) => c.entityType === "collection")).toBe(false);

    const note = json(await client.callTool({ name: "save_workspace_note", arguments: { workspaceId: workspace, title: "Plan", body: "Do relativity first." } }));
    const repeat = json(await client.callTool({ name: "save_workspace_note", arguments: { workspaceId: workspace, title: "Plan", body: "Do relativity first." } }));
    expect(repeat).toMatchObject({ created: false, noteId: note.noteId });

    const context = json(await client.callTool({ name: "save_project_context", arguments: { workspaceId: workspace, goal: "Finish the unit", addTasks: ["Read chapter 3"] } }));
    expect(context.revision).toBe(1);
    const stale = await client.callTool({ name: "save_project_context", arguments: { workspaceId: workspace, expectedRevision: 0, summary: "x" } });
    expect(stale.isError).toBe(true);

    const { rows } = await pool.query("SELECT operation, outcome FROM hubble_integration_activity WHERE user_id = $1 AND actor = 'ai_client' ORDER BY at", [alice]);
    expect(rows.map((r) => `${r.operation}:${r.outcome}`)).toEqual(expect.arrayContaining(["create_collection:ok", "save_workspace_note:ok", "save_project_context:ok", "create_collection:failed"]));
  });

  it("a proposal applies once, after approval, through one sync push", async () => {
    const created = await createTokenConnection(store, { userId: alice, client: "chatgpt", label: "ChatGPT", permission: "write", workspaceIds: [workspace], grantable: new Set([workspace]), now: Date.now() });
    if (!created.ok) throw new Error(created.problem);
    const client = await connect(created.token);
    const version = json(await client.callTool({ name: "list_collections", arguments: { workspaceId: workspace } })).workspaceVersion;
    const proposed = json(
      await client.callTool({
        name: "propose_organization",
        arguments: { workspaceId: workspace, basedOnVersion: version, operations: [{ kind: "create_collection", name: "Relativity", tabIds: tabs }] },
      })
    );
    expect(proposed.status).toBe("pending");
    const before = await sync.cursorOf(workspace, alice);

    expect((await decideProposal(store, bob, proposed.proposalId, "approve", Date.now())).ok).toBe(false);
    expect((await decideProposal(store, alice, proposed.proposalId, "approve", Date.now())).ok).toBe(true);

    const [a, b] = await Promise.all([
      client.callTool({ name: "apply_organization", arguments: { proposalId: proposed.proposalId } }),
      client.callTool({ name: "apply_organization", arguments: { proposalId: proposed.proposalId } }),
    ]);
    const answers = [a, b].map((r) => (r.isError ? { error: true } : json(r)));
    expect(answers.filter((r) => "applied" in r && r.applied === true).length).toBeGreaterThanOrEqual(1);
    expect(Number(await sync.cursorOf(workspace, alice))).toBe(Number(before) + 1);
    const { rows } = await pool.query("SELECT status FROM hubble_integration_proposals WHERE id = $1", [proposed.proposalId]);
    expect(rows[0].status).toBe("applied");
  });
});
