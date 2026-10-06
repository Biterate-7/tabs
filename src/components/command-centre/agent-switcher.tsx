"use client"

import { ArrowLeftRight } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { HandoffAgentOption } from "./handoff-dialog"

/**
 * Switching agents inside a project (Hubble 2.0): same project, different
 * worker. Picking an agent opens the handoff preview already aimed at it, so
 * the new agent starts from the same project context, the same selected
 * sources and this agent's result — never a blank chat, and never without
 * the person seeing what is passed.
 *
 * Agents that cannot take over here are listed with the reason, so "why
 * can't I pick Grok?" has an answer on screen.
 */
export function AgentSwitcher({
  current,
  agents,
  projectName,
  onSwitch,
  onConnect,
}: {
  current: AgentProviderId
  agents: readonly HandoffAgentOption[]
  projectName?: string
  onSwitch: (provider: AgentProviderId) => void
  onConnect: (provider: AgentProviderId) => void
}) {
  const others = agents.filter((agent) => agent.provider !== current)
  if (others.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="sm" variant="ghost" aria-label="Switch agent" />}>
        <ArrowLeftRight /> <span className="max-md:hidden">Switch agent</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Continue {projectName ? `${projectName} ` : "this work "}with…</DropdownMenuLabel>
          {others.map((agent) => (
            <DropdownMenuItem
              key={agent.provider}
              onClick={() => (agent.state === "ready" ? onSwitch(agent.provider) : agent.state === "not_connected" ? onConnect(agent.provider) : undefined)}
              disabled={agent.state === "unavailable"}
              aria-label={agent.state === "ready" ? `Continue with ${agent.name}` : `${agent.name} — ${agent.reason ?? "unavailable"}`}
            >
              <AgentIcon connector={agent.provider} size="xs" />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {agent.state !== "ready" && <span className="text-meta text-tertiary">{agent.state === "not_connected" ? "Connect" : (agent.reason ?? "Unavailable")}</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
