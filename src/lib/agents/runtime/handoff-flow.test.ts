// @vitest-environment node
import { afterEach, it } from "vitest";
import { createMemoryAgentHistoryStore } from "@/lib/agents/activity/history-store";
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

/**
 * An explicit handoff end to end, with real ACP agents on the wire and the
 * real MCP context server, across a runtime restart (see
 * ./__fixtures__/handoff-scenario.ts). History is in memory here; the same
 * journey against real PostgreSQL is handoff-restart.pg.test.ts.
 */

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

it("Gemini → handoff → Grok → approval → undo → restart → history still shows Gemini → Grok", async () => {
  const store = createMemoryAgentHistoryStore();
  await runHandoffScenario({ store, storeAfterRestart: () => store, servers, contextIdentity });
}, 30_000);
