// @vitest-environment node
/**
 * The MCP server against real PostgreSQL.
 *
 * Everything real below the network: the token schema and store, the sync
 * schema and `SyncService` (written through `initial`, the path a device
 * uses), the remote store's schema, and the official MCP client speaking the
 * wire protocol to the route's handler. What this proves that the in-memory
 * suites cannot: that the schema's constraints actually hold, and that
 * ownership survives the real queries.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Pool } from "pg";
import { SyncService } from "@/lib/sync/service";
import { createSyncMcpData } from "./data";
import { handleMcpHttpRequest } from "./http";
import { issueMcpToken, hashMcpToken } from "./tokens";
import { createPostgresMcpTokenStore } from "./tokens-postgres";
import { describePostgres, freshDatabase, seedUser } from "../../../test/pg/database";

const T = 1_700_000_000_000;
const MCP_SCHEMA = readFileSync(path.join(__dirname, "schema.sql"), "utf8");

describePostgres("Hubble MCP against real PostgreSQL", () => {
  let pool: Pool;
  let alice: string;
  let bob: string;
  let aliceWorkspace: string;
  let bobWorkspace: string;
  let aliceToken: string;
  let bobToken: string;
  let deps: Parameters<typeof handleMcpHttpRequest>[1];

  beforeEach(async () => {
    const db = await freshDatabase();
    pool = db.pool;
    await pool.query(MCP_SCHEMA);
    alice = await seedUser(pool, "alice");
    bob = await seedUser(pool, "bob");

    const sync = new SyncService(pool);
    aliceWorkspace = randomUUID();
    bobWorkspace = randomUUID();
    const tab = randomUUID();

    const seededAlice = await sync.initial(
      {
        workspace: { id: aliceWorkspace, name: "Remote Agent Test", createdAt: T, updatedAt: T },
        upserts: [
          {
            entityType: "tab",
            entity: {
              id: tab,
              url: "https://user:hunter2@docs.example.com/mcp?token=PLANTED-PG-SECRET#frag",
              title: "MCP specification",
              createdAt: T,
              updatedAt: T,
            },
          },
          {
            entityType: "collection",
            entity: { id: randomUUID(), name: "Test Context", tabIds: [tab], createdAt: T, updatedAt: T },
          },
        ],
      },
      alice,
      null
    );
    const seededBob = await sync.initial(
      { workspace: { id: bobWorkspace, name: "Bob only", createdAt: T, updatedAt: T }, upserts: [] },
      bob,
      null
    );
    if (!seededAlice.ok || !seededBob.ok) throw new Error("seed failed");

    const tokens = createPostgresMcpTokenStore(pool);
    const a = await issueMcpToken(tokens, { userId: alice, name: "Alice desktop", now: Date.now() });
    const b = await issueMcpToken(tokens, { userId: bob, name: "Bob desktop", now: Date.now() });
    if (!a.ok || !b.ok) throw new Error("token failed");
    aliceToken = a.token;
    bobToken = b.token;

    deps = { tokens, data: createSyncMcpData({ sync }) };
  });

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "pg-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://tabdump.test/api/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (url, init) => handleMcpHttpRequest(new Request(url, init), deps),
      })
    );
    return client;
  }

  it("stores only the hash, and the schema refuses anything else", async () => {
    const { rows } = await pool.query("SELECT token_hash FROM tabdump_mcp_tokens WHERE user_id = $1", [alice]);
    expect(rows).toEqual([{ token_hash: hashMcpToken(aliceToken) }]);

    await expect(
      pool.query(
        `INSERT INTO tabdump_mcp_tokens (id, user_id, name, token_hash, hint, scopes, created_at, expires_at)
         VALUES ('x', $1, 'n', $2, 'abcd', ARRAY['read'], 1, 2)`,
        [alice, aliceToken]
      )
    ).rejects.toThrow(/check constraint/);
  });

  it("refuses a write scope at the database", async () => {
    await expect(
      pool.query(
        `INSERT INTO tabdump_mcp_tokens (id, user_id, name, token_hash, hint, scopes, created_at, expires_at)
         VALUES ('y', $1, 'n', $2, 'abcd', ARRAY['read','write'], 1, 2)`,
        [alice, "a".repeat(64)]
      )
    ).rejects.toThrow(/check constraint/);
  });

  it("serves the caller's synced workspace, redacted, through the real sync service", async () => {
    const client = await connect(aliceToken);
    const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
    const listText = (listed.content as { text: string }[])[0].text;
    expect(JSON.parse(listText).workspaces).toEqual([
      expect.objectContaining({ workspaceId: aliceWorkspace, name: "Remote Agent Test" }),
    ]);

    const overview = await client.callTool({ name: "get_workspace", arguments: { workspaceId: aliceWorkspace } });
    const text = (overview.content as { text: string }[])[0].text;
    expect(text).toContain("MCP specification");
    expect(text).toContain("Test Context");
    for (const secret of ["hunter2", "PLANTED-PG-SECRET", "#frag"]) expect(text).not.toContain(secret);
    await client.close();
  });

  it("isolates the two accounts through the real queries", async () => {
    const aliceClient = await connect(aliceToken);
    const bobClient = await connect(bobToken);

    const stolen = await aliceClient.callTool({ name: "get_workspace", arguments: { workspaceId: bobWorkspace } });
    expect(stolen.isError).toBe(true);
    expect((stolen.content as { text: string }[])[0].text).not.toContain("Bob only");

    const bobList = await bobClient.callTool({ name: "list_workspaces", arguments: {} });
    const bobIds = JSON.parse((bobList.content as { text: string }[])[0].text).workspaces.map(
      (w: { workspaceId: string }) => w.workspaceId
    );
    expect(bobIds).toEqual([bobWorkspace]);

    await aliceClient.close();
    await bobClient.close();
  });

  it("stops working the moment a token is revoked, and the account's deletion removes its tokens", async () => {
    const store = createPostgresMcpTokenStore(pool);
    const [record] = await store.listForUser(alice);
    expect(await store.revoke(bob, record.id, Date.now())).toBe(false);
    expect(await store.revoke(alice, record.id, Date.now())).toBe(true);

    const refused = await handleMcpHttpRequest(
      new Request("https://tabdump.test/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${aliceToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
      }),
      deps
    );
    expect(refused.status).toBe(401);

    await pool.query("DELETE FROM tabdump_users WHERE id = $1", [bob]);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM tabdump_mcp_tokens WHERE user_id = $1", [bob]);
    expect(rows[0].n).toBe(0);
  });
});
