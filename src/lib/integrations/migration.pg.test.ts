// @vitest-environment node
/**
 * `npm run migrate:integrations`, against a database shaped like production.
 *
 * Runs the real migration scripts as child processes, the same entry points
 * an operator runs, onto an empty real PostgreSQL database:
 *
 *   1. the production baseline: every migration that ships (auth, sync,
 *      mcp, downloads), plus the removed agent product's tables
 *      (credentials, remote, agent-history), which production databases
 *      still hold — applied from their frozen schemas
 *      (__fixtures__/legacy-agent-schemas.sql);
 *   2. representative existing data: users, a session, a synced workspace
 *      with tabs and a collection, and a legacy read-only `tdmcp_` token;
 *   3. migrate:integrations, then again — it claims to be repeatable;
 *   4. existing data byte-for-byte unchanged, legacy token still read-only;
 *   5. a failure mid-migration leaves no half schema behind.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SyncService } from "@/lib/sync/service";
import { createSyncMcpData } from "@/lib/mcp/data";
import { handleMcpHttpRequest } from "@/lib/mcp/http";
import { issueMcpToken } from "@/lib/mcp/tokens";
import { createPostgresMcpTokenStore } from "@/lib/mcp/tokens-postgres";
import { createTokenConnection, revokeConnection } from "./service";
import { createPostgresIntegrationStore, integrationSchemaPresent } from "./store-postgres";
import { describePostgres, emptyDatabase, seedUser } from "../../../test/pg/database";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BASELINE = ["auth", "sync", "mcp", "downloads"] as const;
const LEGACY_AGENT_SCHEMAS = readFileSync(path.join(__dirname, "__fixtures__", "legacy-agent-schemas.sql"), "utf8");

async function migrate(name: string, url: string) {
  // migrate:integrations names its target explicitly; the older scripts take no arguments.
  const args = name === "integrations" ? [`--expect-host=${new URL(url).hostname}`] : [];
  return run(process.execPath, [path.join(REPO_ROOT, "scripts", `migrate-${name}.mjs`), ...args], {
    cwd: REPO_ROOT,
    // Never a developer's real database: the scripts read .env files only for unset variables.
    env: { ...process.env, POSTGRES_URL: url, DATABASE_URL: "" },
  });
}

const INTEGRATION_TABLES = [
  "hubble_integration_activity",
  "hubble_integration_connections",
  "hubble_integration_credentials",
  "hubble_integration_idempotency",
  "hubble_integration_proposals",
  "hubble_oauth_clients",
  "hubble_oauth_codes",
  "hubble_project_context",
  "hubble_workspace_notes",
];

/** Every row of every pre-existing table, for a before/after comparison. */
async function snapshot(pool: import("pg").Pool) {
  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE 'hubble_%' ORDER BY table_name`
  );
  const out: Record<string, unknown[]> = {};
  for (const { table_name } of tables) out[table_name] = (await pool.query(`SELECT * FROM ${table_name} ORDER BY 1`)).rows;
  return out;
}

describePostgres("migrate:integrations on a production-shaped database", () => {
  it("is additive, repeatable and preserves existing users, workspaces and legacy tokens", async () => {
    const db = await emptyDatabase();
    for (const name of BASELINE) await migrate(name, db.url);
    await db.pool.query(LEGACY_AGENT_SCHEMAS);

    const alice = await seedUser(db.pool, "alice");
    const sync = new SyncService(db.pool);
    const workspace = randomUUID();
    const tab = randomUUID();
    const seeded = await sync.initial(
      {
        workspace: { id: workspace, name: "Existing workspace", createdAt: 1, updatedAt: 1 },
        upserts: [
          { entityType: "tab", entity: { id: tab, url: "https://example.org/existing", title: "Existing tab", createdAt: 1, updatedAt: 1 } },
          { entityType: "collection", entity: { id: randomUUID(), name: "Existing collection", tabIds: [tab], createdAt: 1, updatedAt: 1 } },
        ],
      },
      alice,
      null
    );
    expect(seeded.ok).toBe(true);
    const legacyTokens = createPostgresMcpTokenStore(db.pool);
    const legacy = await issueMcpToken(legacyTokens, { userId: alice, name: "Claude Desktop", now: Date.now() });
    if (!legacy.ok) throw new Error("legacy token");

    // Deployed before the migration: the store reads as unavailable (503), never a missing-relation 500 (regression).
    expect(await integrationSchemaPresent(db.pool)).toBe(false);

    const before = await snapshot(db.pool);
    await migrate("integrations", db.url);
    expect(await integrationSchemaPresent(db.pool)).toBe(true);
    await migrate("integrations", db.url);
    const after = await snapshot(db.pool);
    expect(after).toEqual(before);

    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'hubble_%' ORDER BY table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual(INTEGRATION_TABLES);

    // A second application created no duplicate index or constraint under a generated name.
    const { rows: indexes } = await db.pool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename LIKE 'hubble_%'`);
    expect(new Set(indexes.map((i) => i.indexname)).size).toBe(indexes.length);

    // Deleting the account takes every integration row with it.
    const store = createPostgresIntegrationStore(db.pool);
    const created = await createTokenConnection(store, { userId: alice, client: "claude", label: "Claude Code", permission: "write", workspaceIds: [workspace], grantable: new Set([workspace]), now: Date.now() });
    if (!created.ok) throw new Error(created.problem);

    // Read-only and write connections, then the legacy token, through the real handler.
    const deps = { tokens: legacyTokens, data: createSyncMcpData({ sync }), integration: { store, sync } };
    const connect = async (token: string) => {
      const client = new Client({ name: "migration-check", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("https://hubble.test/api/mcp"), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
          fetch: (url, init) => handleMcpHttpRequest(new Request(url, init), deps),
        })
      );
      return client;
    };
    const readOnly = await createTokenConnection(store, { userId: alice, client: "gemini", label: "Gemini CLI", permission: "read", workspaceIds: [workspace], grantable: new Set([workspace]), now: Date.now() });
    if (!readOnly.ok) throw new Error(readOnly.problem);

    const writer = await connect(created.token);
    expect((await writer.callTool({ name: "create_collection", arguments: { workspaceId: workspace, name: "After migration" } })).isError).not.toBe(true);
    const reader = await connect(readOnly.token);
    expect((await reader.listTools()).tools.map((t) => t.name)).not.toContain("create_collection");
    const old = await connect(legacy.token);
    const oldTools = (await old.listTools()).tools.map((t) => t.name);
    expect(oldTools).toContain("list_workspaces");
    expect(oldTools).not.toContain("create_collection");
    expect(oldTools).not.toContain("save_workspace_note");

    // Revoking both connections ends them on the next request.
    await revokeConnection(store, alice, created.connection.id, Date.now());
    await revokeConnection(store, alice, readOnly.connection.id, Date.now());
    await expect(writer.callTool({ name: "list_workspaces", arguments: {} })).rejects.toThrow();
    await expect(reader.callTool({ name: "list_workspaces", arguments: {} })).rejects.toThrow();
    // The legacy token is unaffected by revoking connections.
    expect((await old.callTool({ name: "list_workspaces", arguments: {} })).isError).not.toBe(true);

    await db.pool.query(`DELETE FROM tabdump_users WHERE id = $1`, [alice]);
    for (const table of ["hubble_integration_connections", "hubble_integration_credentials", "hubble_integration_activity"]) {
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
    }
  });

  it("refuses to run before the auth schema exists, and leaves nothing behind", async () => {
    const db = await emptyDatabase();
    await expect(migrate("integrations", db.url)).rejects.toThrow();
    const { rows } = await db.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    expect(rows).toEqual([]);
  });
});
