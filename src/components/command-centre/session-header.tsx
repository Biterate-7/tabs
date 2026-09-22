"use client"

import { PanelRightClose, PanelRightOpen, Trash2 } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { AgentStatusPill } from "@/components/agents/agent-status-pill"
import { IconButton } from "@/components/ui/icon-button"
import {
  SESSION_ORIGIN_LABEL,
  SESSION_STATUS_LABEL,
  SESSION_VISUAL_STATE,
  sessionStatusTone,
} from "@/lib/agents/command-centre/presentation"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import type { CommandCentreSession } from "@/hooks/use-agent-sessions"

/**
 * Who is working, on what, and in what state.
 *
 * ## Why the provider is drawn, not named in a branch
 *
 * `AgentIcon` is the only component in the product that knows how a provider
 * is drawn, and it takes a provider string. This header therefore has no
 * Claude-shaped branch and needs none when a second provider arrives — which
 * is the structural requirement the brief makes: `AgentSessionView`, not
 * `ClaudeSessionView`.
 *
 * ## Why origin is stated
 *
 * "Controlled session" and "Observed externally" are genuinely different
 * facts about where the work came from, and TabDump is one of the few tools
 * that can tell them apart. The label comes from the correlation record the
 * host supplied; when there is no correlation the header says so rather than
 * assuming control.
 */
export function SessionHeader({
  session,
  projectName,
  contextPanelOpen,
  onToggleContextPanel,
  onDispose,
}: {
  session: CommandCentreSession
  projectName?: string
  contextPanelOpen: boolean
  onToggleContextPanel: () => void
  onDispose: () => void
}) {
  const { view } = session
  const state = SESSION_VISUAL_STATE[view.status]
  const identity = agentVisualIdentity(view.provider)

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-subtle px-4">
      <AgentIcon connector={view.provider} state={state} size="sm" />

      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-body-sm font-medium text-foreground">
            {view.title ?? identity.displayName}
          </h1>
          {projectName && (
            <span className="shrink-0 truncate text-label text-tertiary">{projectName}</span>
          )}
        </div>
        {/*
          The subtitle is prose, so it is set in the UI face.

          It was `text-meta`, which is the mono/tabular style — the design
          system reserves mono for structure and figures, and "Claude Code ·
          Not yet correlated" is neither. Set in mono it read as a status code
          rather than as a sentence about where this session came from.
        */}
        <span className="truncate text-label text-tertiary">
          {identity.displayName} · {SESSION_ORIGIN_LABEL[session.origin]}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <AgentStatusPill
          tone={sessionStatusTone(view.status)}
          label={SESSION_STATUS_LABEL[view.status]}
        />

        <IconButton aria-label="End session" className="size-7" destructive onClick={onDispose}>
          <Trash2 />
        </IconButton>

        {/*
          Hidden at exactly the width the panel itself is.

          Below `xl` there is no space for the context panel and it collapses
          (see context-panel.tsx); a toggle that survived that breakpoint would
          be a control whose only effect is on something the user cannot see —
          and it would go on claiming to "Hide context panel" while no panel
          was on screen.
        */}
        <IconButton
          aria-label={contextPanelOpen ? "Hide context panel" : "Show context panel"}
          className="hidden size-7 xl:inline-flex"
          onClick={onToggleContextPanel}
        >
          {contextPanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </IconButton>
      </div>
    </header>
  )
}
