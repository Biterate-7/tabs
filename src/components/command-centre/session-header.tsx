"use client"

import { Check, Minus, PanelRightClose, PanelRightOpen, Trash2 } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { AgentStatusPill } from "@/components/agents/agent-status-pill"
import { IconButton } from "@/components/ui/icon-button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { READ_CAPABILITIES, SESSION_CONTEXT_ACCESS_LABELS, WRITE_CAPABILITIES } from "@/lib/agents/session-context/capabilities"
import {
  SESSION_ORIGIN_LABEL,
  SESSION_STATUS_LABEL,
  SESSION_VISUAL_STATE,
  sessionStatusTone,
} from "@/lib/agents/command-centre/presentation"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import type { RuntimeSessionContextView } from "@/lib/agents/runtime/protocol"
import type { ContextFreshness } from "@/hooks/use-session-context"

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
  workspaceContext,
  contextFreshness = "fresh",
  contextUnavailable = false,
}: {
  session: CommandCentreSession
  projectName?: string
  contextPanelOpen: boolean
  onToggleContextPanel: () => void
  onDispose: () => void
  /** The TabDump workspace the agent works in, when the session has one (Phase J.3). */
  workspaceContext?: RuntimeSessionContextView
  /** Whether the runtime holds what this window would send (J.4). */
  contextFreshness?: ContextFreshness
  /** Started from a workspace, but this agent cannot be given it safely (J.4). */
  contextUnavailable?: boolean
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
        {workspaceContext && <WorkspaceContextIndicator context={workspaceContext} freshness={contextFreshness} />}
        {!workspaceContext && contextUnavailable && <ContextUnavailableIndicator />}
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

/**
 * "This agent can see your workspace" — said once, small, and without the
 * machinery (Phase J.3, J.4). The pill says which workspace and whether the
 * agent's copy is current; opening it says what the agent can read, that any
 * change asks first, and the context version. Nothing here names MCP, a port,
 * a server name or a token.
 */
function WorkspaceContextIndicator({
  context,
  freshness,
}: {
  context: RuntimeSessionContextView
  freshness: ContextFreshness
}) {
  const canWrite = context.capabilities.some((capability) => WRITE_CAPABILITIES.includes(capability))
  const reads = READ_CAPABILITIES.filter((capability) => context.capabilities.includes(capability))
  const stale = freshness === "update_available"
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Workspace context: ${context.workspaceName}${stale ? ", update available" : ""}`}
        className="flex max-w-56 items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-label text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="text-tertiary">Context</span>
        <span className="truncate text-foreground">{context.workspaceName}</span>
        {stale ? (
          <span className="shrink-0 text-warning">· Update available</span>
        ) : (
          <Check className="size-3 shrink-0 text-success" aria-hidden />
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <div className="flex flex-col gap-2.5">
          <div>
            <p className="text-eyebrow text-tertiary">Workspace</p>
            <p className="truncate text-body-sm text-foreground">{context.workspaceName}</p>
            <p className="text-label text-tertiary">
              Version {context.version} · {stale ? "Update available" : "Current"}
            </p>
          </div>
          <div>
            <p className="text-eyebrow text-tertiary">Reads</p>
            <p aria-label="What the agent can read" className="text-body-sm text-foreground">
              {reads.map((capability) => SESSION_CONTEXT_ACCESS_LABELS[capability]).join(" · ")}
            </p>
          </div>
          <div>
            <p className="text-eyebrow text-tertiary">Writes</p>
            <p className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
              {canWrite ? (
                <>
                  <Check className="size-3.5 shrink-0 text-success" aria-hidden />
                  Collections — approval required
                </>
              ) : (
                <>
                  <Minus className="size-3.5 shrink-0" aria-hidden />
                  Not allowed in this session
                </>
              )}
            </p>
          </div>
          <p className="text-meta text-tertiary">Only this workspace. Switching workspaces does not move this session.</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Said, not left to be inferred from a missing pill (J.4): this agent was
 * started from a workspace but cannot be given it safely.
 */
function ContextUnavailableIndicator() {
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Workspace context unavailable for this agent"
        className="flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-label text-tertiary transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span>Context</span>
        <Minus className="size-3 shrink-0" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <p className="text-body-sm text-foreground">No workspace context</p>
        <p className="mt-1 text-body-sm text-muted-foreground">
          TabDump can&apos;t tell this agent&apos;s own tools apart from its TabDump tools, so it doesn&apos;t give it your
          workspace. The session works without it.
        </p>
      </PopoverContent>
    </Popover>
  )
}
