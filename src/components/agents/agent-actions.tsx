"use client"

import { createContext, useContext } from "react"
import { Bot } from "lucide-react"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import type { AgentIntent, WorkingContext } from "@/lib/agents/command-centre/working-context"

/**
 * "Ask an agent about this" — from anywhere in Hubble a workspace is shown.
 *
 * ## One seam, provided by the shell
 *
 * The shell owns navigation, so it owns what these do: `ask` takes the user
 * to the Command Centre with the context (a session working in that
 * workspace is pointed at it, or it becomes the next session's context), and
 * `add` collects it for the next time the Command Centre opens, without
 * leaving. Surfaces — the selection toolbar, a tab's menu, a collection's
 * menu, the graph — only describe *what* is being asked about, as a working
 * context: ids inside one workspace.
 *
 * Rendered outside the shell (a view on its own, in a test), there is no
 * provider and every control built on this hides itself rather than offering
 * an action that goes nowhere.
 */
export type AgentActions = {
  /** The workspace on screen: where anything asked about here lives. */
  workspaceId: string
  ask: (context: WorkingContext, intent?: AgentIntent) => void
  add: (context: WorkingContext) => void
}

const AgentActionsContext = createContext<AgentActions | null>(null)

export const AgentActionsProvider = AgentActionsContext.Provider

export function useAgentActions(): AgentActions | null {
  return useContext(AgentActionsContext)
}

/** What each request is called for what it is about. Only the ones that make sense are offered. */
export const INTENT_LABELS = {
  tab: { ask: "Ask about this tab", explain: "Explain", summarize: "Summarize" },
  collection: { ask: "Ask about this collection", summarize: "Summarize", analyze: "Analyze", organize: "Organize" },
  selection: { ask: "Ask about these", summarize: "Summarize", compare: "Compare", organize: "Organize into collections" },
} as const satisfies Record<string, Partial<Record<AgentIntent, string>>>

export type AgentSubject = keyof typeof INTENT_LABELS

/**
 * The "Ask agent" submenu for a dropdown menu — one row in the parent menu,
 * the requests inside it. Nothing when there is no shell to send them to.
 */
export function AskAgentSubmenu({ subject, context }: { subject: AgentSubject; context: WorkingContext }) {
  const agent = useAgentActions()
  if (!agent) return null
  const labels: Partial<Record<AgentIntent, string>> = INTENT_LABELS[subject]
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Bot /> Ask agent
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {(Object.keys(labels) as AgentIntent[]).map((intent) => (
          <DropdownMenuItem key={intent} onClick={() => agent.ask(context, intent)}>
            {labels[intent]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => agent.add(context)}>Add to agent context</DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
