// @vitest-environment node
/**
 * Agent history against real PostgreSQL — the store contract, and the real
 * migration script, from an empty database: the state
 * `npm run migrate:agent-history` meets in production.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { historyStoreContract, historySession } from "./history-store.contract";
import { PostgresAgentHistoryStore, postgresAgentHistoryStoreFor } from "./history-store-postgres";
import { describePostgres, emptyDatabase } from "../../../../test/pg/database";

const SCHEMA = readFileSync(path.join(__dirname, "history-schema.sql"), "utf8");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const run = promisify(execFile);

describePostgres("agent history against real PostgreSQL", () => {
  describe("the store contract", () => {
    historyStoreContract(async () => {
      const { pool } = await emptyDatabase();
      await pool.query(SCHEMA);
      return new PostgresAgentHistoryStore(pool);
    });
  });

  it("applies the schema twice without error (idempotent migration)", async () => {
    const { pool } = await emptyDatabase();
    await pool.query(SCHEMA);
    await pool.query(SCHEMA);
  });

  it("migrates an empty database with the real script, twice, and an empty history reads as empty", async () => {
    const { url, pool } = await emptyDatabase();
    const env = { ...process.env, POSTGRES_URL: url, DATABASE_URL: "" };
    const script = path.join(REPO_ROOT, "scripts", "migrate-agent-history.mjs");
    const first = await run(process.execPath, [script], { cwd: REPO_ROOT, env });
    expect(first.stdout).toContain("Agent history schema applied (via POSTGRES_URL)");
    // The connection string is a credential; only the variable's name is printed.
    expect(first.stdout + first.stderr).not.toContain(url);
    await run(process.execPath, [script], { cwd: REPO_ROOT, env });

    const store = await postgresAgentHistoryStoreFor(pool);
    expect(store).toBeDefined();
    expect(await store!.listSessions("local", "w-any")).toEqual({ sessions: [] });
  });

  it("is unavailable — not empty — on a database that has not been migrated", async () => {
    const { pool } = await emptyDatabase();
    expect(await postgresAgentHistoryStoreFor(pool)).toBeUndefined();
  });

  it("has no column a credential, a message, a command or a URL could be put in", async () => {
    const { pool } = await emptyDatabase();
    await pool.query(SCHEMA);
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name LIKE 'tabdump_agent_history_%' ORDER BY table_name, ordinal_position`
    );
    const columns = rows.map((row) => `${row.table_name}.${row.column_name}`);
    expect(columns).toEqual([
      "tabdump_agent_history_records.owner_id",
      "tabdump_agent_history_records.session_id",
      "tabdump_agent_history_records.kind",
      "tabdump_agent_history_records.record_key",
      "tabdump_agent_history_records.at",
      "tabdump_agent_history_records.data",
      "tabdump_agent_history_sessions.owner_id",
      "tabdump_agent_history_sessions.id",
      "tabdump_agent_history_sessions.workspace_id",
      "tabdump_agent_history_sessions.provider",
      "tabdump_agent_history_sessions.status",
      "tabdump_agent_history_sessions.title",
      "tabdump_agent_history_sessions.project_id",
      "tabdump_agent_history_sessions.context_unavailable",
      "tabdump_agent_history_sessions.truncated",
      "tabdump_agent_history_sessions.started_at",
      "tabdump_agent_history_sessions.last_activity_at",
      "tabdump_agent_history_sessions.ended_at",
    ]);
  });

  it("removes a session's records with the session", async () => {
    const { pool } = await emptyDatabase();
    await pool.query(SCHEMA);
    const store = new PostgresAgentHistoryStore(pool);
    await store.write("local", {
      sessions: [historySession()],
      records: [{ sessionId: "s1", kind: "undo", key: "x", at: 1, data: { changeId: "x", at: 1 } }],
    });
    await pool.query(`DELETE FROM tabdump_agent_history_sessions WHERE owner_id = 'local' AND id = 's1'`);
    const { rows } = await pool.query(`SELECT 1 FROM tabdump_agent_history_records`);
    expect(rows).toHaveLength(0);
  });
});
