"use client"

import { memo } from "react"
import { Plus } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { Button } from "@/components/ui/button"
import { SESSION_VISUAL_STATE } from "@/lib/agents/command-centre/presentation"
import { platformProvider } from "@/lib/agents/platform/catalog"
import { liveActivity } from "@/lib/agents/platform/chat"
import { CONNECTION_PHASE_LABEL, isChatReady } from "@/lib/agents/platform/lifecycle"
import { cn } from "@/lib/utils"
import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import type { UseAgentPlatform } from "@/hooks/use-agent-platform"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { AgentIdentity } from "@/lib/agents/platform/roster"
import type { SequencedControlEvent } from "@/lib/agents/runtime/protocol"

/**
 * The agents a user has connected, as persistent identities (Phase J).
 *
 * ## What each row says, and where it comes from
 *
 *   - **Who** — the provider's own mark and the name the agent was connected
 *     under, from the roster.
 *   - **Whether it can work** — the connection phase, derived from the runtime
 *     and the machine, never stored. A connected agent that was uninstalled
 *     since says "Not installed" here the next time Hubble checks.
 *   - **What it is doing** — its newest session's status, and for the session
 *     on screen, its newest event. An agent with no session says so.
 *   - **Where** — the Hubble workspace its current session is associated with.
 *
 * Nothing here is invented: there is no placeholder agent, no sample
 * activity, and an empty roster says how to connect one.
 */
export function AgentRoster({
  platform,
  sessions,
  selectedSessionId,
  selectedEvents,
  workspaceNameOf,
  onOpenAgent,
  onConnect,
}: {
  platform: UseAgentPlatform
  sessions: readonly CommandCentreSession[]
  selectedSessionId: string | null
  /** The on-screen session's events — the only ones this surface already holds. */
  selectedEvents: readonly SequencedControlEvent[]
  workspaceNameOf: (workspaceId: string | undefined) => string | undefined
  onOpenAgent: (agent: AgentIdentity, latest: CommandCentreSession | undefined) => void
  onConnect: (provider?: AgentProviderId) => void
}) {
  const agents = platform.roster.agents

  return (
    <section aria-label="Connected agents" className="border-b border-subtle pb-2">
      <div className="flex items-center justify-between gap-2 pr-2 pl-3">
        <h3 className="py-1 text-eyebrow text-muted-foreground">
          Agents {agents.length > 0 && <span className="text-tertiary">{agents.length}</span>}
        </h3>
        <Button type="button" size="xs" variant="ghost" onClick={() => onConnect()} aria-label="Connect agent">
          <Plus />
          Connect
        </Button>
      </div>

      {agents.length === 0 ? (
        <p className="px-3.5 pt-1 pb-1 text-body-sm text-tertiary">
          No agents connected. Connect Claude Code, Codex, Gemini CLI, Grok Build or any MCP agent.
        </p>
      ) : (
        <ul className="flex flex-col">
          {agents.map((agent) => {
            const latest = latestSessionFor(sessions, agent.provider)
            return (
              <AgentRow
                key={agent.id}
                agent={agent}
                phase={platform.phaseOf(agent.provider)}
                sessionsAvailable={platform.sessionsFor(agent.provider).available}
                latest={latest}
                events={latest && latest.view.sessionId === selectedSessionId ? selectedEvents : []}
                workspaceName={workspaceNameOf(latest?.view.workspaceId ?? agent.workspaceId)}
                selected={latest !== undefined && latest.view.sessionId === selectedSessionId}
                onOpen={() => onOpenAgent(agent, latest)}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}

function latestSessionFor(
  sessions: readonly CommandCentreSession[],
  provider: AgentProviderId
): CommandCentreSession | undefined {
  let latest: CommandCentreSession | undefined
  for (const session of sessions) {
    if (session.view.provider !== provider) continue
    if (!latest || session.view.updatedAt > latest.view.updatedAt) latest = session
  }
  return latest
}

const AgentRow = memo(function AgentRow({
  agent,
  phase,
  sessionsAvailable,
  latest,
  events,
  workspaceName,
  selected,
  onOpen,
}: {
  agent: AgentIdentity
  phase: ReturnType<UseAgentPlatform["phaseOf"]>
  /** False for an agent Hubble will not start sessions with; the row says so. */
  sessionsAvailable: boolean
  latest: CommandCentreSession | undefined
  events: readonly SequencedControlEvent[]
  workspaceName: string | undefined
  selected: boolean
  onOpen: () => void
}) {
  const ready = isChatReady(phase)
  // An MCP client is never started by Hubble, so it never has a session to
  // report on; what is true of it is how it reaches Hubble.
  const mcpOnly = platformProvider(agent.provider)?.chat === false
  const activity = !ready
    ? CONNECTION_PHASE_LABEL[phase]
    : mcpOnly
      ? "Reads Hubble over MCP"
      : !sessionsAvailable
        ? "Connected · sessions unavailable"
        : liveActivity(latest?.view, events)
  const state = latest && ready ? SESSION_VISUAL_STATE[latest.view.status] : "idle"

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${agent.name} — ${activity}`}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-2.5 py-2 pr-3 pl-3.5 text-left transition-colors duration-(--duration-fast) ease-(--ease-color)",
          "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
          selected ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
        )}
      >
        <span className="flex h-4 items-center">
          <AgentIcon connector={agent.provider} state={state} size="xs" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body-sm text-foreground">{agent.name}</span>
          <span className={cn("truncate text-meta", ready ? "text-tertiary" : "text-link")}>
            {activity}
            {workspaceName ? ` · ${workspaceName}` : ""}
          </span>
        </span>
      </button>
    </li>
  )
})
