import { AGENT_PERMISSION_SCOPES } from "@/lib/agents/control/permissions";
import { approveAgent, EMPTY_ROSTER, saveAgentRoster } from "../roster";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * Seeds the roster as if the user had already connected and approved an agent.
 *
 * Since Phase J a session can only be started for an agent in the roster. The
 * command-centre suites written before that test *starting* sessions, not
 * *connecting* agents, so they seed a fully approved identity and keep
 * testing what they always tested. Connecting is covered by its own suites.
 */
export function seedConnectedAgent(provider: AgentProviderId = "claude-code"): void {
  saveAgentRoster(
    approveAgent(EMPTY_ROSTER, {
      provider,
      name: provider,
      scopes: AGENT_PERMISSION_SCOPES,
      now: 1_700_000_000_000,
    })
  );
}
