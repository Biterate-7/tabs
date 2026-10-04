"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, X } from "lucide-react"
import { AgentActivity } from "@/components/agents/agent-activity"
import { ActivityPopover } from "@/components/command-centre/activity-popover"
import { AgentHistoryList } from "@/components/command-centre/agent-history-list"
import { AgentRoster } from "@/components/command-centre/agent-roster"
import { ApprovalPrompt } from "@/components/command-centre/approval-prompt"
import { Composer } from "@/components/command-centre/composer"
import { ContextPanel } from "@/components/command-centre/context-panel"
import { ContextPicker } from "@/components/command-centre/context-picker"
import { EventStream } from "@/components/command-centre/event-stream"
import { HandoffDialog, handoffAgentOptions } from "@/components/command-centre/handoff-dialog"
import type { HandoffTransport } from "@/lib/agents/handoff/transport"
import { HistorySessionView } from "@/components/command-centre/history-session-view"
import { SessionHeader } from "@/components/command-centre/session-header"
import { SessionList } from "@/components/command-centre/session-list"
import { WorkingContextChip } from "@/components/command-centre/working-context-control"
import { IconButton } from "@/components/ui/icon-button"
import { useHistorySessionActivity, useSessionActivity } from "@/hooks/use-agent-activity"
import type { AgentHistoryListState } from "@/hooks/use-agent-history"
import { historySessionStatus } from "@/lib/agents/activity/history"
import type { UseAgentPlatform } from "@/hooks/use-agent-platform"
import { SESSION_STATUS_LABEL, SESSION_VISUAL_STATE } from "@/lib/agents/command-centre/presentation"
import { collectionsMatch } from "@/lib/collections/restore"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import {
  contextOfSession,
  describeWorkingContext,
  removeFromContext,
  workspaceContext,
  workspaceIdOf,
  workspaceLinkOf,
} from "@/lib/agents/command-centre/working-context"
import { focusFromAttachments } from "@/lib/agents/session-context/focus"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { agentDisplayName, canHandOffFrom } from "@/lib/agents/handoff/handoff"
import type { WorkingContext } from "@/lib/agents/command-centre/working-context"
import { platformProvider } from "@/lib/agents/platform/catalog"
import { phaseSentence, sessionPrerequisite } from "@/lib/agents/platform/lifecycle"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import { cn } from "@/lib/utils"
import { DEMO_AGENTS, DEMO_NOW, DEMO_PROJECTS, DEMO_SESSION_PROVIDERS } from "./data"
import { useHubbleDemo } from "./demo-provider"
import { demoKnownApprovals } from "./demo-state"

/**
 * The agents the demo roster shows, as the product's platform hook would
 * report them — built from the catalog rather than restated. Whether Hubble
 * starts sessions with an agent is `platformProvider(p).sessions`, the same
 * field the server's launch allowlist is tested against, so an agent Hubble
 * will not start sessions with reads "Signed in · sessions unavailable" here
 * exactly as it does in Hubble — signed in, never "Connected".
 *
 * Every action that would reach a runtime is inert: the demo connects
 * nothing, detects nothing and signs nothing in.
 */
function demoPlatform(): UseAgentPlatform {
  const identity = (provider: AgentProviderId) => DEMO_AGENTS.find((agent) => agent.provider === provider)
  const phaseOf = (provider: AgentProviderId): ConnectionPhase => {
    if (!identity(provider)) return "detected"
    const spec = platformProvider(provider)
    return spec?.chat && !spec.sessions.available ? "sessions_unavailable" : "connected"
  }
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
    readinessOf: () => undefined,
    prerequisiteFor: (provider) => {
      const spec = platformProvider(provider)
      if (!spec) return { ok: false, reason: "" }
      return sessionPrerequisite({
        provider: spec,
        phase: phaseOf(provider),
        approved: Boolean(identity(provider)),
        sessions: spec.sessions,
      })
    },
    statusOf: () => undefined,
    identity,
    detect: async () => undefined,
    connect: async () => false,
    retry: async () => false,
    authenticate: async () => false,
    approve: () => undefined,
    disconnect: async () => undefined,
    recordSession: () => undefined,
  }
}

/** One for every demo window: it holds no state, only the catalog's answers. */
const DEMO_PLATFORM = demoPlatform()

/** The agents a handoff can go to, from the same roster answers — by the Command Centre's own helper. */
const DEMO_HANDOFF_AGENTS = handoffAgentOptions(DEMO_PLATFORM, (provider) => DEMO_SESSION_PROVIDERS.has(provider))

/**
 * The Command Centre, laid out as CommandCentreView lays it out: the view
 * bar, then sessions (with the agent roster above them), the open session,
 * and what it can see.
 *
 * Built from CommandCentreView's own children, because CommandCentreView
 * mounts the control-plane hooks — the runtime client, polling, provider
 * connections, MCP tokens — and the demo must start none of them. A session's
 * context is resolved by the product's own `useAgentContext`, fed the demo's
 * workspaces, and recorded on the session the way the runtime records it —
 * the tab and collection references of what was attached.
 *
 * The view bar says what the demo is instead of reporting a runtime, because
 * there is none: nothing typed here runs anywhere.
 *
 * The agent's activity — the timeline, the action inspector, Undo — is the
 * app's own `AgentActivity`, fed by the product's `useSessionActivity` from
 * the demo's records (its events, approvals and applied changes) exactly as
 * CommandCentreView feeds it from the runtime's. Only the data differs; a
 * structural test keeps it that way (demo-parity.test.tsx).
 */
export function DemoCommandCentre({
  onClose,
  showSessions = true,
}: {
  onClose?: () => void
  /** False crops the view to the open session and its context — the landing page's context section. */
  showSessions?: boolean
}) {
  const { state, dispatch, world, context, send, respond, undo, undoHistory, handoff } = useHubbleDemo()
  const contextPanelOpen = state.contextPanelOpen
  const [pickerKey, setPickerKey] = useState<number | null>(null)
  /** The session a handoff was opened for — as the Command Centre holds it. */
  const [handoffFor, setHandoffFor] = useState<{ key: number; sessionId: string; transport: HandoffTransport } | null>(null)
  const seenApprovals = state.seenApprovals
  const knownApprovals = useMemo(() => demoKnownApprovals({ seenApprovals }), [seenApprovals])

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

  // The session's workspace ↔ agent relationship, exactly as the Command Centre derives it.
  const liveWorld = useMemo(
    () => ({ workspaces: state.store.workspaces, collections: state.collections, dependencies: state.dependencies }),
    [state.store.workspaces, state.collections, state.dependencies]
  )
  const link = selected ? workspaceLinkOf(selected.view, state.store.workspaces) : ({ kind: "none" } as const)
  const sessionWorkspaceId = selected ? workspaceIdOf(selected.view) : undefined
  // The same rule as the Command Centre: a session in a workspace, done with its turn.
  const canContinue = Boolean(selected && sessionWorkspaceId && canHandOffFrom(selected.view.status))
  const workspaceName = workspaceNameOf(sessionWorkspaceId)
  const own = selected ? contextOfSession(selected.view) : null
  const contextView = own ? describeWorkingContext(own, liveWorld) : null
  const agentName = selected ? agentVisualIdentity(selected.view.provider).displayName : "The agent"
  const delivered = selected?.view.focus?.delivered

  /* ---------------- What the agent did — the app's own derivation, on the demo's records. */

  const sessionChanges = useMemo(
    () => (selectedId ? state.changes.filter((change) => change.sessionId === selectedId) : []),
    [state.changes, selectedId]
  )
  const canUndo = useCallback(
    (change: AppliedWorkspaceChange) =>
      change.ok && !change.undone && Boolean(change.after) && collectionsMatch(state.collections, change.workspaceId, change.after!),
    [state.collections]
  )
  const sessionHandoffs = useMemo(
    () => (selectedId ? state.handoffs.filter((entry) => entry.sourceSessionId === selectedId || entry.targetSessionId === selectedId) : []),
    [state.handoffs, selectedId]
  )
  const activity = useSessionActivity({
    session: selected?.view ?? null,
    events,
    approvals,
    changes: sessionChanges,
    handoffs: sessionHandoffs,
    agentName,
    ...(workspaceName ? { workspaceName } : {}),
    ...(projectName ? { projectName } : {}),
    now: DEMO_NOW,
    knownApprovals,
    canUndo,
  })
  /** "View" — the workspace the change was made in, as the app's View goes there. */
  const viewChange = (change: AppliedWorkspaceChange) => {
    dispatch({ type: "switch-workspace", id: change.workspaceId })
    dispatch({ type: "navigate", view: "workspace" })
  }
  const viewChangeById = (changeId: string) => {
    const change = sessionChanges.find((candidate) => candidate.id === changeId)
    if (change) viewChange(change)
  }
  /** The other end of a handoff: a live session if the demo holds it, else its history — as in the app. */
  const openHandoffSession = (sessionId: string) => {
    if (state.sessions.some((entry) => entry.view.sessionId === sessionId)) dispatch({ type: "select-session", id: sessionId })
    else if (state.history.some((entry) => entry.session.sessionId === sessionId)) dispatch({ type: "select-history", id: sessionId })
  }
  const activityView = selected ? (
    <AgentActivity
      entries={activity.entries}
      provider={selected.view.provider}
      agentName={agentName}
      state={SESSION_VISUAL_STATE[selected.view.status]}
      statusLabel={SESSION_STATUS_LABEL[selected.view.status]}
      now={DEMO_NOW}
      inspect={activity.inspect}
      onUndo={undo}
      onViewChange={viewChangeById}
      {...(canContinue ? { onContinue: () => setHandoffFor({ key: Date.now(), sessionId: selected.view.sessionId, transport: handoff(selected.view.sessionId) }) } : {})}
      onOpenSession={openHandoffSession}
    />
  ) : null
  const handoffSource = handoffFor ? state.sessions.find((entry) => entry.view.sessionId === handoffFor.sessionId)?.view : undefined

  /*
    Agent history — the app's own list, pane, hook and AgentActivity, fed the
    demo's past sessions (data.ts) for the workspace on screen, exactly as
    CommandCentreView feeds them from the runtime's answer.
  */
  const historyWorkspaceId = state.store.currentId
  const historyState = useMemo<AgentHistoryListState>(
    () => ({
      kind: "ready",
      workspaceId: historyWorkspaceId,
      sessions: state.history
        .filter((entry) => entry.session.workspaceId === historyWorkspaceId)
        .map((entry) => entry.session)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt),
      hasMore: false,
      loadingMore: false,
    }),
    [state.history, historyWorkspaceId]
  )
  const liveIds = useMemo(() => new Set(state.sessions.map((entry) => entry.view.sessionId)), [state.sessions])
  const openHistory = !selected
    ? (state.history.find((entry) => entry.session.sessionId === state.selectedHistoryId && entry.session.workspaceId === historyWorkspaceId) ?? null)
    : null
  const historyAgentName = openHistory ? agentVisualIdentity(openHistory.session.provider).displayName : "The agent"
  const historyWorkspaceName = workspaceNameOf(openHistory?.session.workspaceId)
  const historyActivity = useHistorySessionActivity({
    detail: openHistory,
    agentName: historyAgentName,
    ...(historyWorkspaceName ? { workspaceName: historyWorkspaceName } : {}),
    ...(openHistory && projectNameOf(openHistory.session.projectId) ? { projectName: projectNameOf(openHistory.session.projectId) } : {}),
    now: DEMO_NOW,
    canUndo,
  })
  const historyStatus = openHistory ? historySessionStatus(openHistory.session.status) : null

  /** Points the open session at a context — resolved by the real bridge, recorded as its focus. */
  function applyContext(next: WorkingContext) {
    if (!selected) return
    const outcome = context.resolve(next)
    if (!outcome.ok) return
    dispatch({
      type: "set-focus",
      sessionId: selected.view.sessionId,
      focus: outcome.attached ? focusFromAttachments(outcome.attached.attachments) : null,
    })
  }
  const actions =
    own && sessionWorkspaceId
      ? {
          onRemove: (entry: { tabId: string } | { collectionId: string }) => applyContext(removeFromContext(own, entry)),
          onUseWholeWorkspace: () => applyContext(workspaceContext(sessionWorkspaceId)),
          onChoose: () => setPickerKey(Date.now()),
        }
      : {}
  const chip = (align: "start" | "end") => (
    <WorkingContextChip
      view={contextView}
      link={link}
      agentName={agentName}
      {...(delivered !== undefined ? { delivered } : {})}
      align={align}
      {...actions}
    />
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {(selected || openHistory) && showSessions && (
          <IconButton
            aria-label="All sessions"
            className="-ml-1.5 md:hidden"
            onClick={() => {
              dispatch({ type: "select-session", id: null })
              dispatch({ type: "select-history", id: null })
            }}
          >
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
          className={selected || openHistory ? "max-md:hidden" : "max-md:w-full max-md:border-r-0"}
          sessions={state.sessions}
          selectedSessionId={selectedId}
          projectNameOf={projectNameOf}
          workspaceNameOf={workspaceNameOf}
          onSelect={(id) => dispatch({ type: "select-session", id })}
          onNewSession={() => undefined}
          // Starting a session needs a runtime, and this page has none.
          canCreate={false}
          now={DEMO_NOW}
          history={
            <AgentHistoryList
              state={historyState}
              selectedSessionId={openHistory?.session.sessionId ?? null}
              onSelect={(entry) => dispatch({ type: "select-history", id: entry.sessionId })}
              {...(workspaceNameOf(historyWorkspaceId) ? { workspaceName: workspaceNameOf(historyWorkspaceId) } : {})}
              now={DEMO_NOW}
              hiddenSessionIds={liveIds}
            />
          }
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

        <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !selected && !openHistory && showSessions && "max-md:hidden")}>
          {openHistory && historyStatus ? (
            <HistorySessionView
              session={openHistory.session}
              state={{ kind: "ready", detail: openHistory }}
              {...(historyWorkspaceName ? { workspaceName: historyWorkspaceName } : {})}
              now={DEMO_NOW}
              onClose={() => dispatch({ type: "select-history", id: null })}
            >
              <AgentActivity
                entries={historyActivity.entries}
                provider={openHistory.session.provider}
                agentName={historyAgentName}
                state={SESSION_VISUAL_STATE[historyStatus]}
                statusLabel={SESSION_STATUS_LABEL[historyStatus]}
                now={DEMO_NOW}
                inspect={historyActivity.inspect}
                onUndo={(changeId) => undoHistory(openHistory.session.sessionId, changeId)}
                onViewChange={(changeId) => {
                  const change = historyActivity.history?.changes.find((candidate) => candidate.id === changeId)
                  if (change) viewChange(change)
                }}
                onOpenSession={openHandoffSession}
              />
            </HistorySessionView>
          ) : selected ? (
            <>
              <SessionHeader
                session={selected}
                {...(projectName ? { projectName } : {})}
                {...(workspaceName ? { workspaceName } : {})}
                link={link}
                contextControl={chip("end")}
                contextPanelOpen={contextPanelOpen}
                onToggleContextPanel={() => dispatch({ type: "toggle-context-panel" })}
                onDispose={() => dispatch({ type: "dispose", sessionId: selected.view.sessionId })}
                activityControl={
                  <ActivityPopover waiting={activity.waiting} className={contextPanelOpen ? "xl:hidden" : undefined}>
                    {activityView}
                  </ActivityPopover>
                }
              />
              <div ref={streamRef} className="flex min-h-0 flex-1 flex-col">
              <EventStream
                events={events}
                changes={sessionChanges}
                {...(workspaceName ? { workspaceName } : {})}
                onViewChange={viewChange}
                onUndoChange={(change) => undo(change.id)}
                canUndoChange={canUndo}
              >
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
                    onRespond={respond}
                  />
                ))}
              </EventStream>
              </div>
              <Composer
                key={selected.view.sessionId}
                status={selected.view.status}
                pending={false}
                cancellable={selected.view.cancellable}
                agentName={agentName}
                {...(workspaceName ? { workspaceName } : {})}
                {...(projectName ? { projectName } : {})}
                contextControl={chip("start")}
                onCancel={() => dispatch({ type: "cancel", sessionId: selected.view.sessionId })}
                onSend={(text) => send(selected.view.sessionId, text)}
              />
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-24">
              <div className="w-full max-w-[600px]">
                <h2 className="text-statement text-foreground">Command Centre</h2>
                <p className="mt-1.5 text-body text-muted-foreground">
                  Work with your AI agents inside a Hubble workspace, on the context you choose. Pick a session to see what its agent did.
                </p>
              </div>
            </div>
          )}
        </main>

        {/* A past session is told whole in its own pane; this panel describes a live one — as in the app. */}
        {contextPanelOpen && !openHistory && (
          <ContextPanel
            session={selected?.view ?? null}
            {...(workspaceName ? { workspaceName } : {})}
            link={link}
            context={contextView}
            {...(delivered !== undefined ? { delivered } : {})}
            agentName={agentName}
            {...(projectName ? { projectName } : {})}
            runtimeStatus={null}
            changes={sessionChanges}
            onViewChange={viewChange}
            {...(activityView ? { activity: activityView } : {})}
            {...actions}
          />
        )}
      </div>

      {handoffFor && handoffSource && (
        <HandoffDialog
          key={handoffFor.key}
          open
          onOpenChange={(open) => {
            if (!open) setHandoffFor(null)
          }}
          source={{
            provider: handoffSource.provider,
            agentName: agentDisplayName(handoffSource.provider),
            ...(handoffSource.title ? { title: handoffSource.title } : {}),
            statusLabel: SESSION_STATUS_LABEL[handoffSource.status],
          }}
          {...(workspaceNameOf(handoffSource.workspaceId) ? { workspaceName: workspaceNameOf(handoffSource.workspaceId) } : {})}
          agents={DEMO_HANDOFF_AGENTS}
          onConnect={() => {
            setHandoffFor(null)
            dispatch({ type: "settings-section", section: "agents" })
          }}
          transport={handoffFor.transport}
          onStarted={(result) => {
            setHandoffFor(null)
            if (result.session) dispatch({ type: "select-session", id: result.session.sessionId })
          }}
        />
      )}

      {pickerKey !== null && own && (
        <ContextPicker
          key={pickerKey}
          open
          onOpenChange={(open) => {
            if (!open) setPickerKey(null)
          }}
          workspace={world.workspaces.find((workspace) => workspace.id === own.workspaceId) ?? null}
          collections={world.collections}
          dependencies={world.dependencies}
          initial={own}
          agentName={agentName}
          onConfirm={applyContext}
        />
      )}
    </div>
  )
}
