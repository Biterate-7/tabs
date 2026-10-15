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
import { MAX_ACTIVE_CONNECTIONS, approveAuthorization, exchangeToken, registerClient, revokeToken, validateAuthorizationRequest } from "./oauth";
import { decideProposal } from "./proposals";
import { createTokenConnection, revokeConnection, updateConnection } from "./service";
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

  const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

  async function oauthClient() {
    return (await registerClient(store, { client_name: "Claude", redirect_uris: [CALLBACK] }, Date.now())).body as { client_id: string };
  }

  /** Consent and code exchange for a registered client, as the routes run them. */
  async function oauthConnect(clientId: string, level: "read" | "write" = "write") {
    const { createHash } = await import("node:crypto");
    const verifier = randomUUID() + randomUUID();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const v = await validateAuthorizationRequest(store, { response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", resource: ENDPOINT }, ISSUER);
    if (!v.ok) throw new Error(v.description);
    const approved = await approveAuthorization(store, { request: v.request, issuer: ISSUER, userId: alice, level, workspaceIds: [workspace], grantableWorkspaceIds: new Set([workspace]), now: Date.now() });
    if (!approved.ok) throw new Error(approved.reason);
    const code = new URL(approved.location).searchParams.get("code")!;
    const answer = await exchangeToken(store, new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId }), undefined, ISSUER, Date.now());
    expect(answer.status).toBe(200);
    return { access: String(answer.body.access_token), refresh: String(answer.body.refresh_token) };
  }

  const refreshWith = (clientId: string, refresh: string) =>
    exchangeToken(store, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }), undefined, ISSUER, Date.now());

  async function works(token: string): Promise<boolean> {
    try {
      return !(await (await connect(token)).callTool({ name: "get_connection_info", arguments: {} })).isError;
    } catch {
      return false;
    }
  }

  async function activeConnections(userId: string): Promise<{ id: string; scopes: string[]; workspace_ids: string[] }[]> {
    const { rows } = await pool.query("SELECT id, scopes, workspace_ids FROM hubble_integration_connections WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at", [userId]);
    return rows;
  }

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

  it("retention prunes every account in SQL, not only the active one", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, user, at] of [["act_old_bob", bob, now - 91 * day], ["act_new_alice", alice, now - day]] as const) {
      await pool.query(`INSERT INTO hubble_integration_activity (id, user_id, actor, kind, operation, outcome, at) VALUES ($1, $2, 'ai_client', 'read', 'list_workspaces', 'ok', $3)`, [id, user, at]);
    }
    const { retentionCutoffs } = await import("./activity");
    await store.pruneExpired(retentionCutoffs(now));
    const { rows } = await pool.query("SELECT id FROM hubble_integration_activity ORDER BY id");
    expect(rows.map((r) => r.id)).toEqual(["act_new_alice"]);
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

  it("rotates refresh tokens in SQL; a replayed one ends the connection, and so does RFC 7009 revocation", async () => {
    const client = await oauthClient();
    const first = await oauthConnect(client.client_id);
    const rotated = await refreshWith(client.client_id, first.refresh);
    expect(rotated.status).toBe(200);
    const second = { access: String(rotated.body.access_token), refresh: String(rotated.body.refresh_token) };
    expect(await works(second.access)).toBe(true);

    const replay = await refreshWith(client.client_id, first.refresh);
    expect(replay.status).toBe(400);
    expect(await activeConnections(alice)).toEqual([]);
    expect(await works(second.access)).toBe(false);
    expect((await refreshWith(client.client_id, second.refresh)).status).toBe(400);

    const other = await oauthConnect(client.client_id);
    expect((await revokeToken(store, new URLSearchParams({ token: other.refresh, client_id: client.client_id }), undefined, Date.now())).status).toBe(200);
    expect(await activeConnections(alice)).toEqual([]);
    expect(await works(other.access)).toBe(false);
  });

  it("narrowing and disconnecting take effect on the next request, and the same client can reconnect", async () => {
    const grantable = new Set([workspace]);
    const created = await createTokenConnection(store, { userId: alice, client: "claude", label: "Claude Code", permission: "write", workspaceIds: [workspace], grantable, now: Date.now() });
    if (!created.ok) throw new Error(created.problem);
    const tools = async (token: string) => (await (await connect(token)).listTools()).tools.map((t) => t.name);
    expect(await tools(created.token)).toContain("create_collection");

    expect((await updateConnection(store, { userId: bob, connectionId: created.connection.id, permission: "read", grantable, now: Date.now() })).ok).toBe(false);
    expect((await updateConnection(store, { userId: alice, connectionId: created.connection.id, permission: "read", grantable, now: Date.now() })).ok).toBe(true);
    expect((await activeConnections(alice))[0].scopes).toEqual(["hubble.read"]);
    expect(await tools(created.token)).not.toContain("create_collection");

    expect(await revokeConnection(store, bob, created.connection.id, Date.now())).toBe(false);
    expect(await revokeConnection(store, alice, created.connection.id, Date.now())).toBe(true);
    expect(await works(created.token)).toBe(false);
    expect(await activeConnections(alice)).toEqual([]);

    // An OAuth client that was disconnected keeps its registration and reconnects through consent.
    const client = await oauthClient();
    const before = await oauthConnect(client.client_id);
    const [oauthConnection] = await activeConnections(alice);
    await revokeConnection(store, alice, oauthConnection.id, Date.now());
    const after = await oauthConnect(client.client_id, "read");
    expect(await works(before.access)).toBe(false);
    expect((await refreshWith(client.client_id, before.refresh)).status).toBe(400);
    expect(await works(after.access)).toBe(true);
    const active = await activeConnections(alice);
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(oauthConnection.id);
    expect(active[0].scopes).toEqual(["hubble.read"]);
  });

  /**
   * A store whose createConnection calls all wait at the door until `racers`
   * of them have arrived, then go in together: every caller has finished
   * whatever it checked beforehand, and the inserts run concurrently. This is
   * the interleaving simultaneous requests can produce, made certain rather
   * than left to timing, so the cap is decided by the SQL alone.
   */
  function storeWithBarrier(racers: number): IntegrationStore {
    let arrived = 0;
    let open!: () => void;
    const door = new Promise<void>((resolve) => (open = resolve));
    const barrier: IntegrationStore = Object.create(store);
    barrier.createConnection = async (...args: Parameters<IntegrationStore["createConnection"]>) => {
      if (++arrived === racers) open();
      await door;
      return store.createConnection(...args);
    };
    return barrier;
  }

  /** Enough open pool connections that the racers' queries really run at once. */
  async function warmPool(size: number) {
    await Promise.all(Array.from({ length: size }, () => pool.query("SELECT pg_sleep(0.05)")));
  }

  it(`never lets concurrent token connections take an account past ${MAX_ACTIVE_CONNECTIONS}`, async () => {
    const grantable = new Set([workspace]);
    const create = (target: IntegrationStore, label: string) =>
      createTokenConnection(target, { userId: alice, client: "other", label, permission: "read", workspaceIds: [workspace], grantable, now: Date.now() });
    for (let i = 0; i < MAX_ACTIVE_CONNECTIONS - 1; i++) expect((await create(store, `c${i}`)).ok).toBe(true);
    const bobsOwn = await createTokenConnection(store, { userId: bob, client: "other", label: "bob", permission: "read", workspaceIds: [bobWorkspace], grantable: new Set([bobWorkspace]), now: Date.now() });
    expect(bobsOwn.ok).toBe(true);

    const racers = 6;
    await warmPool(racers);
    const barrier = storeWithBarrier(racers);
    const results = await Promise.all(Array.from({ length: racers }, (_, i) => create(barrier, `race${i}`)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.problem))).toEqual(Array(racers - 1).fill("too_many_connections"));
    expect(await activeConnections(alice)).toHaveLength(MAX_ACTIVE_CONNECTIONS);
    // A refused request leaves nothing behind: no connection row, no credential.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM hubble_integration_credentials c JOIN hubble_integration_connections k ON k.id = c.connection_id WHERE k.user_id = $1", [alice]);
    expect(rows[0].n).toBe(MAX_ACTIVE_CONNECTIONS);
    // The cap is per account: Bob is untouched and can still connect.
    expect(await activeConnections(bob)).toHaveLength(1);

    // Disconnecting one frees exactly one slot.
    const [oldest] = await activeConnections(alice);
    expect(await revokeConnection(store, alice, oldest.id, Date.now())).toBe(true);
    const secondRound = storeWithBarrier(racers);
    const again = await Promise.all(Array.from({ length: racers }, (_, i) => create(secondRound, `again${i}`)));
    expect(again.filter((r) => r.ok)).toHaveLength(1);
    expect(await activeConnections(alice)).toHaveLength(MAX_ACTIVE_CONNECTIONS);
  });

  it(`never lets concurrent OAuth code exchanges take an account past ${MAX_ACTIVE_CONNECTIONS}`, async () => {
    const grantable = new Set([workspace]);
    for (let i = 0; i < MAX_ACTIVE_CONNECTIONS - 1; i++) {
      const created = await createTokenConnection(store, { userId: alice, client: "other", label: `c${i}`, permission: "read", workspaceIds: [workspace], grantable, now: Date.now() });
      expect(created.ok).toBe(true);
    }

    // Several clients are approved while one slot is free (consent only checks; it creates nothing).
    const racers = 6;
    const { createHash } = await import("node:crypto");
    const pending = [];
    for (let i = 0; i < racers; i++) {
      const client = await oauthClient();
      const verifier = randomUUID() + randomUUID();
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const v = await validateAuthorizationRequest(store, { response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", resource: ENDPOINT }, ISSUER);
      if (!v.ok) throw new Error(v.description);
      const approved = await approveAuthorization(store, { request: v.request, issuer: ISSUER, userId: alice, level: "read", workspaceIds: [workspace], grantableWorkspaceIds: grantable, now: Date.now() });
      if (!approved.ok) throw new Error(approved.reason);
      pending.push({ clientId: client.client_id, verifier, code: new URL(approved.location).searchParams.get("code")! });
    }

    await warmPool(racers);
    const barrier = storeWithBarrier(racers);
    const answers = await Promise.all(
      pending.map((p) => exchangeToken(barrier, new URLSearchParams({ grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, client_id: p.clientId }), undefined, ISSUER, Date.now()))
    );
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    for (const refused of answers.filter((a) => a.status !== 200)) expect(refused).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(await activeConnections(alice)).toHaveLength(MAX_ACTIVE_CONNECTIONS);
    const winner = answers.find((a) => a.status === 200)!;
    expect(await works(String(winner.body.access_token))).toBe(true);
  });

  it("deleting an account removes every integration row it owns, and nobody else's", async () => {
    for (const userId of [alice, bob]) {
      const space = userId === alice ? workspace : bobWorkspace;
      const created = await createTokenConnection(store, { userId, client: "claude", label: "Claude", permission: "write", workspaceIds: [space], grantable: new Set([space]), now: Date.now() });
      if (!created.ok) throw new Error(created.problem);
      const client = await connect(created.token);
      await client.callTool({ name: "save_workspace_note", arguments: { workspaceId: space, title: "Plan", body: `Notes for ${userId}` } });
      await client.callTool({ name: "save_project_context", arguments: { workspaceId: space, goal: "Finish" } });
      await client.callTool({ name: "create_collection", arguments: { workspaceId: space, name: "Reading", idempotencyKey: `key-${userId}` } });
    }
    await oauthConnect((await oauthClient()).client_id);

    const owned = async (userId: string) => {
      const { rows } = await pool.query(
        `SELECT
           (SELECT count(*) FROM hubble_integration_connections WHERE user_id = $1)
         + (SELECT count(*) FROM hubble_integration_credentials c JOIN hubble_integration_connections k ON k.id = c.connection_id WHERE k.user_id = $1)
         + (SELECT count(*) FROM hubble_integration_idempotency i JOIN hubble_integration_connections k ON k.id = i.connection_id WHERE k.user_id = $1)
         + (SELECT count(*) FROM hubble_oauth_codes WHERE user_id = $1)
         + (SELECT count(*) FROM hubble_integration_activity WHERE user_id = $1)
         + (SELECT count(*) FROM hubble_project_context WHERE user_id = $1)
         + (SELECT count(*) FROM hubble_workspace_notes WHERE user_id = $1) AS n`,
        [userId]
      );
      return Number(rows[0].n);
    };
    const bobBefore = await owned(bob);
    expect(await owned(alice)).toBeGreaterThan(0);
    expect(bobBefore).toBeGreaterThan(0);

    await pool.query("DELETE FROM tabdump_users WHERE id = $1", [alice]);
    expect(await owned(alice)).toBe(0);
    expect(await owned(bob)).toBe(bobBefore);
    // Credentials and idempotency rows hang off connections: none may outlive theirs.
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM hubble_integration_credentials c WHERE NOT EXISTS (SELECT 1 FROM hubble_integration_connections k WHERE k.id = c.connection_id))::int AS creds,
         (SELECT count(*) FROM hubble_integration_idempotency i WHERE NOT EXISTS (SELECT 1 FROM hubble_integration_connections k WHERE k.id = i.connection_id))::int AS keys`
    );
    expect(rows[0]).toEqual({ creds: 0, keys: 0 });
  });

  it("deletes notes and project context only for their owner, and replays an idempotency key from SQL", async () => {
    const created = await createTokenConnection(store, { userId: alice, client: "claude", label: "Claude", permission: "write", workspaceIds: [workspace], grantable: new Set([workspace]), now: Date.now() });
    if (!created.ok) throw new Error(created.problem);
    const client = await connect(created.token);
    const note = json(await client.callTool({ name: "save_workspace_note", arguments: { workspaceId: workspace, title: "Plan", body: "Relativity first." } }));
    json(await client.callTool({ name: "save_project_context", arguments: { workspaceId: workspace, goal: "Finish the unit" } }));

    expect(await store.deleteNote(bob, note.noteId)).toBe(false);
    expect(await store.deleteProjectContext(bob, workspace)).toBe(false);
    expect(await store.deleteNote(alice, note.noteId)).toBe(true);
    expect(await store.deleteNote(alice, note.noteId)).toBe(false);
    expect(await store.deleteProjectContext(alice, workspace)).toBe(true);
    expect(await store.getProjectContext(alice, workspace)).toBeUndefined();
    expect((await store.listNotes(alice, workspace, { offset: 0, limit: 10 })).total).toBe(0);

    const cursor = await sync.cursorOf(workspace, alice);
    const first = json(await client.callTool({ name: "create_collection", arguments: { workspaceId: workspace, name: "Optics", idempotencyKey: "optics-1" } }));
    // A fresh MCP session, as after a client restart: the key is remembered by the database, not the process.
    const again = json(await (await connect(created.token)).callTool({ name: "create_collection", arguments: { workspaceId: workspace, name: "Optics", idempotencyKey: "optics-1" } }));
    expect(again).toMatchObject({ repeated: true, collectionId: first.collectionId });
    expect(Number(await sync.cursorOf(workspace, alice))).toBe(Number(cursor) + 1);
  });
});
