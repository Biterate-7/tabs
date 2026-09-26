"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { ChevronLeft, X } from "lucide-react"
import { AgentRoster } from "@/components/command-centre/agent-roster"
import { ApprovalPrompt } from "@/components/command-centre/approval-prompt"
import { Composer } from "@/components/command-centre/composer"
import { ContextPanel } from "@/components/command-centre/context-panel"
import { ContextPicker } from "@/components/command-centre/context-picker"
import { EventStream } from "@/components/command-centre/event-stream"
import { SessionHeader } from "@/components/command-centre/session-header"
import { SessionList } from "@/components/command-centre/session-list"
import { IconButton } from "@/components/ui/icon-button"
import type { UseAgentPlatform } from "@/hooks/use-agent-platform"
import { summarizeAttachment } from "@/lib/agents/command-centre/context-selection"
import { platformProvider } from "@/lib/agents/platform/catalog"
import { phaseSentence } from "@/lib/agents/platform/lifecycle"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import { cn } from "@/lib/utils"
import { DEMO_AGENTS, DEMO_NOW, DEMO_PROJECTS } from "./data"
import { useHubbleDemo } from "./demo-provider"

/**
 * The agents the demo roster shows, as the product's platform hook would
 * report them — built from the catalog rather than restated. Whether Hubble
 * starts sessions with an agent is `platformProvider(p).sessions`, the same
 * field the server's launch allowlist is tested against, so Codex reads
 * "Connected · sessions unavailable" here exactly as it does in Hubble.
 *
 * Every action that would reach a runtime is inert: the demo connects
 * nothing, detects nothing and signs nothing in.
 */
function demoPlatform(): UseAgentPlatform {
  const identity = (provider: AgentProviderId) => DEMO_AGENTS.find((agent) => agent.provider === provider)
  const phaseOf = (provider: AgentProviderId) => (identity(provider) ? ("connected" as const) : ("detected" as const))
  return {
    roster: { version: 1, agents: DEMO_AGENTS },
    detections: null,
    thisMachine: false,
    connections: {},
    pending: null,
    pendingAction: null,
    errors: {},
    surface: "web",
    connectorFor: () => {
      throw new Error("The landing page demo does not connect agents.")
    },
    phaseOf,
    sentenceOf: (provider) => {
      const spec = platformProvider(provider)
      return spec ? phaseSentence(spec, phaseOf(provider)) : ""
    },
    sessionsFor: (provider) => platformProvider(provider)?.sessions ?? { available: false, reason: "" },
    statusOf: () => undefined,
    identity,
    detect: async () => undefined,
    connect: async () => false,
    authenticate: async () => false,
    approve: () => undefined,
    disconnect: async () => undefined,
    recordSession: () => undefined,
  }
}

/** One for every demo window: it holds no state, only the catalog's answers. */
const DEMO_PLATFORM = demoPlatform()

/**
 * The Command Centre, laid out as CommandCentreView lays it out: the view
 * bar, then sessions (with the agent roster above them), the open session,
 * and what it can see.
 *
 * Built from CommandCentreView's own children, because CommandCentreView
 * mounts the control-plane hooks — the runtime client, polling, provider
 * connections, MCP tokens — and the demo must start none of them. The
 * context selection is the product's own `useAgentContext`, fed the demo's
 * workspaces: the picker's preview and the panel's counts come from the real
 * resolver.
 *
 * The view bar says what the demo is instead of reporting a runtime, because
 * there is none: nothing typed here runs anywhere.
 */
export function DemoCommandCentre({
  onClose,
  showSessions = true,
}: {
  onClose?: () => void
  /** False crops the view to the open session and its context — the landing page's context section. */
  showSessions?: boolean
}) {
  const { state, dispatch, world, context, send } = useHubbleDemo()
  const contextPanelOpen = state.contextPanelOpen
  const [pickerOpen, setPickerOpen] = useState(false)

  const selected = state.sessions.find((entry) => entry.view.sessionId === state.selectedSessionId) ?? null
  const selectedId = selected?.view.sessionId ?? null
  const events = selectedId ? (state.events[selectedId] ?? []) : []
  const approvals = selectedId ? (state.approvals[selectedId] ?? []) : []

  /*
    Open a session at its latest event, as the app does once a session's
    events arrive. The app gets there through EventStream following growth;
    here the events are already present at mount, so the stream's own
    scroller is moved directly — never scrollIntoView, which would also
    scroll the page to the window.
  */
  const streamRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroller = streamRef.current?.firstElementChild
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight
  }, [selectedId])

  const projectNameOf = (projectId: string | undefined) => DEMO_PROJECTS.find((p) => p.id === projectId)?.name
  const workspaceNameOf = (workspaceId: string | undefined) =>
    workspaceId ? state.store.workspaces.find((w) => w.id === workspaceId)?.name : undefined
  const projectName = selected ? projectNameOf(selected.view.projectId) : undefined

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {selected && showSessions && (
          <IconButton aria-label="All sessions" className="-ml-1.5 md:hidden" onClick={() => dispatch({ type: "select-session", id: null })}>
            <ChevronLeft />
          </IconButton>
        )}
        <span className="text-h2 text-foreground">Command Centre</span>
        {projectName && (
          <>
            <span aria-hidden className="text-tertiary">
              /
            </span>
            <span className="min-w-0 truncate text-body text-muted-foreground">{projectName}</span>
          </>
        )}
        <div role="status" className="ml-auto flex min-w-0 items-center gap-2">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-tertiary" />
          <span className="truncate text-body-sm text-muted-foreground">
            Demo<span className="hidden sm:inline"> · no agent runs on this page</span>
          </span>
        </div>
        {onClose && (
          <IconButton aria-label="Close command centre" className="shrink-0" onClick={onClose}>
            <X />
          </IconButton>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {showSessions && (
        <SessionList
          className={selected ? "max-md:hidden" : "max-md:w-full max-md:border-r-0"}
          sessions={state.sessions}
          selectedSessionId={selectedId}
          projectNameOf={projectNameOf}
          onSelect={(id) => dispatch({ type: "select-session", id })}
          onNewSession={() => undefined}
          // Starting a session needs a runtime, and this page has none.
          canCreate={false}
          now={DEMO_NOW}
        >
          <AgentRoster
            platform={DEMO_PLATFORM}
            sessions={state.sessions}
            selectedSessionId={selectedId}
            selectedEvents={events}
            workspaceNameOf={workspaceNameOf}
            onConnect={() => dispatch({ type: "settings-section", section: "agents" })}
            onOpenAgent={(agent, latest) => {
              if (latest) dispatch({ type: "select-session", id: latest.view.sessionId })
              else dispatch({ type: "settings-section", section: "agents" })
            }}
          />
        </SessionList>
        )}

        <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !selected && showSessions && "max-md:hidden")}>
          {selected ? (
            <>
              <SessionHeader
                session={selected}
                {...(projectName ? { projectName } : {})}
                contextPanelOpen={contextPanelOpen}
                onToggleContextPanel={() => dispatch({ type: "toggle-context-panel" })}
                onDispose={() => dispatch({ type: "dispose", sessionId: selected.view.sessionId })}
                {...(selected.view.context ? { workspaceContext: selected.view.context } : {})}
              />
              <div ref={streamRef} className="flex min-h-0 flex-1 flex-col">
              <EventStream events={events}>
                {approvals.map((approval) => (
                  <ApprovalPrompt
                    key={approval.approvalId}
                    approval={approval}
                    {...(approval.workspaceId && workspaceNameOf(approval.workspaceId)
                      ? { workspaceName: workspaceNameOf(approval.workspaceId) }
                      : {})}
                    pending={false}
                    now={DEMO_NOW}
                    // Already on screen when the page loads: taking focus
                    // would scroll the visitor to it.
                    autoFocus={false}
                    onRespond={(approvalId, decision) => dispatch({ type: "respond", approvalId, decision })}
                  />
                ))}
              </EventStream>
              </div>
              <Composer
                key={selected.view.sessionId}
                status={selected.view.status}
                pending={false}
                cancellable={selected.view.cancellable}
                {...(context.snapshot ? { contextSummary: summarizeAttachment(context.snapshot) } : {})}
                {...(projectName ? { projectName } : {})}
                onOpenContext={() => setPickerOpen(true)}
                onCancel={() => dispatch({ type: "cancel", sessionId: selected.view.sessionId })}
                onSend={(text) => send(selected.view.sessionId, text)}
              />
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-24">
              <div className="w-full max-w-[600px]">
                <h2 className="text-statement text-foreground">Command Centre</h2>
                <p className="mt-1.5 text-body text-muted-foreground">
                  Work with your AI agents using scoped projects and the Hubble context you choose to attach. Pick a session to see what its agent did.
                </p>
              </div>
            </div>
          )}
        </main>

        {contextPanelOpen && (
          <ContextPanel
            session={selected?.view ?? null}
            world={world}
            snapshot={context.snapshot}
            delta={context.delta}
            {...(projectName ? { projectName } : {})}
            runtimeStatus={null}
            refreshing={false}
            onEditContext={() => setPickerOpen(true)}
            onRefreshContext={() => void context.refresh()}
          />
        )}
      </div>

      <ContextPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        world={world}
        localRuntimeAllowed={false}
        initialSelection={context.selection}
        onConfirm={(selection) => void context.resolve(selection)}
      />
    </div>
  )
}
