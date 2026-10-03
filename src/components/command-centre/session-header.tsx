"use client"

import { PanelRightClose, PanelRightOpen, Trash2 } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { AgentStatusPill } from "@/components/agents/agent-status-pill"
import { IconButton } from "@/components/ui/icon-button"
import { WorkingInIndicator } from "./working-context-control"
import {
  SESSION_ORIGIN_LABEL,
  SESSION_STATUS_LABEL,
  SESSION_VISUAL_STATE,
  sessionStatusTone,
} from "@/lib/agents/command-centre/presentation"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import type { ContextFreshness } from "@/hooks/use-session-context"
import type { WorkspaceLink } from "@/lib/agents/command-centre/working-context"

/**
 * Who is working, where, on what, and in what state — the workspace ↔ agent
 * relationship in one line.
 *
 *     [mark]  Compare the physics sources          Context · Physics · 3 tabs  ● Ready
 *             Claude Code · Working in Research ✓
 *
 * ## Why the provider is drawn, not named in a branch
 *
 * `AgentIcon` is the only component that knows how a provider is drawn, and
 * it takes a provider string: no Claude-shaped branch here, and none needed
 * when another agent arrives.
 *
 * ## Why "Working in" is always said
 *
 * A session works in the workspace it was started from, for its whole life —
 * switching workspaces in Hubble does not move it. Saying the workspace on
 * every session, by its live name, is what stops a user believing an agent is
 * working in the workspace on screen when it is working in another.
 */
export function SessionHeader({
  session,
  projectName,
  workspaceName,
  link,
  contextFreshness = "fresh",
  contextControl,
  contextPanelOpen,
  onToggleContextPanel,
  onDispose,
  activityControl,
}: {
  session: CommandCentreSession
  projectName?: string
  /** The session's workspace, by its live name. */
  workspaceName?: string
  link: WorkspaceLink
  /** Whether the runtime holds what this window would send (J.4). */
  contextFreshness?: ContextFreshness
  /** The context chip — rendered by the caller, which owns its popover. */
  contextControl?: React.ReactNode
  contextPanelOpen: boolean
  onToggleContextPanel: () => void
  onDispose: () => void
  /**
   * The activity timeline's own entry point, for where the context panel
   * (which carries it) is not on screen. Rendered by the caller, which owns
   * the popover and decides when it shows.
   */
  activityControl?: React.ReactNode
}) {
  const { view } = session
  const state = SESSION_VISUAL_STATE[view.status]
  const identity = agentVisualIdentity(view.provider)

  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
      <span className="text-muted-foreground">
        <AgentIcon connector={view.provider} state={state} size="sm" />
      </span>

      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-h2 text-foreground">{view.title ?? identity.displayName}</h1>
          {projectName && <span className="shrink-0 truncate text-body-sm text-tertiary">{projectName}</span>}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-meta text-tertiary">
          {view.title && <span className="shrink-0">{identity.displayName} ·</span>}
          <WorkingInIndicator
            workspaceName={workspaceName}
            link={link}
            {...(view.context ? { context: view.context } : {})}
            freshness={contextFreshness}
            origin={SESSION_ORIGIN_LABEL[session.origin]}
          />
        </div>
      </div>

      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
        {/* On a phone the row keeps only the actions; the context is one tap
            away in the composer, and the status in the session list line. */}
        <span className="flex min-w-0 items-center gap-1.5 max-sm:hidden">
          {contextControl && <span className="min-w-0 max-w-64">{contextControl}</span>}
          <AgentStatusPill tone={sessionStatusTone(view.status)} label={SESSION_STATUS_LABEL[view.status]} />
        </span>

        {activityControl}

        <IconButton aria-label="End session" destructive onClick={onDispose}>
          <Trash2 />
        </IconButton>

        {/*
          Hidden at exactly the width the panel itself is (see
          context-panel.tsx): below `xl` there is no panel to toggle.
        */}
        <IconButton
          aria-label={contextPanelOpen ? "Hide context panel" : "Show context panel"}
          className="hidden xl:inline-flex"
          onClick={onToggleContextPanel}
        >
          {contextPanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </IconButton>
      </div>
    </header>
  )
}
