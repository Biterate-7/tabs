// @vitest-environment node
/**
 * The handoff's definition of done against real PostgreSQL: two runtimes
 * sharing nothing but the database (the second on a new connection pool, the
 * first abandoned without a goodbye), with the schema applied exactly as
 * `npm run migrate:agent-history` applies it. See
 * ./__fixtures__/handoff-scenario.ts for the journey itself.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PostgresAgentHistoryStore, postgresAgentHistoryStoreFor } from "@/lib/agents/activity/history-store-postgres";
import { describePostgres, emptyDatabase } from "../../../../test/pg/database";
import { runHandoffScenario } from "./__fixtures__/handoff-scenario";
import { launchEntryFor } from "@/lib/agents/launch/allowlist";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * How each agent's calls to the context server are proven. Grok's launch
 * entry deliberately has none (it is refused Hubble's workspace tools in the
 * product); here it borrows Gemini's so the journey exercises two providers
 * that both carry context. The scripted agent ignores the flags.
 */
const contextIdentity = (provider: AgentProviderId) => launchEntryFor(provider === "grok" ? "gemini" : provider)!.acp!.contextIdentity;
import type { SessionContextServer } from "@/lib/agents/session-context/http";

const SCHEMA = readFileSync(path.join(__dirname, "..", "activity", "history-schema.sql"), "utf8");

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describePostgres("an explicit handoff survives a runtime restart", () => {
  it("source → handoff → target → restart → history → both timelines and the inspector", async () => {
    const database = await emptyDatabase();
    await database.pool.query(SCHEMA);
    // Applying the schema twice changes nothing — the migration is idempotent.
    await database.pool.query(SCHEMA);
    const store = await postgresAgentHistoryStoreFor(database.pool);
    expect(store).toBeInstanceOf(PostgresAgentHistoryStore);
    const { geminiId, grokId, handoff } = await runHandoffScenario({
      store: store!,
      storeAfterRestart: async () => (await postgresAgentHistoryStoreFor(await database.openPool()))!,
      servers,
      contextIdentity,
    });
    // The row itself: the explicit relationship, and nothing it should not hold.
    const rows = await database.pool.query(
      "SELECT source_session_id, target_session_id, status, workspace_id, data FROM tabdump_agent_handoffs WHERE id = $1",
      [handoff.handoffId]
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ source_session_id: geminiId, target_session_id: grokId, status: "ready", workspace_id: "w-research" }),
    ]);
    expect(JSON.stringify(rows.rows[0].data)).not.toMatch(/REPLY-SECRET|authorization|bearer|HUBBLE HANDOFF/i);
  }, 60_000);

  it("a database migrated only for 1.3 keeps history as before, and no handoffs", async () => {
    const database = await emptyDatabase();
    // The 1.3 schema: everything before the handoffs table.
    await database.pool.query(SCHEMA.slice(0, SCHEMA.indexOf("-- Hubble 1.4")));
    const store = await postgresAgentHistoryStoreFor(database.pool);
    expect(store).toBeDefined();
    await store!.write("local", {
      sessions: [{ sessionId: "s1", workspaceId: "w", provider: "gemini", status: "completed", startedAt: 1, lastActivityAt: 2 }],
      records: [],
      handoffs: [
        {
          handoffId: "h1",
          workspaceId: "w",
          sourceSessionId: "s1",
          sourceProvider: "gemini",
          targetProvider: "grok",
          status: "failed",
          failure: "session_not_created",
          context: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const page = await store!.listSessions("local", "w");
    expect(page.sessions).toEqual([expect.objectContaining({ sessionId: "s1" })]);
    expect(page.sessions[0]!.handoff).toBeUndefined();
  });
});
