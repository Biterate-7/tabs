"use client"

import { useCallback, useMemo, useState } from "react"
import { Plus, RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
import { ApprovalPrompt } from "./approval-prompt"
import { Composer } from "./composer"
import { ContextPanel } from "./context-panel"
import { ContextPicker } from "./context-picker"
import { EventStream } from "./event-stream"
import { NewSessionDialog } from "./new-session-dialog"
import { SessionHeader } from "./session-header"
import { SessionList } from "./session-list"
import { useAgentContext } from "@/hooks/use-agent-context"
import { useAgentProjects } from "@/hooks/use-agent-projects"
import { useAgentRuntime } from "@/hooks/use-agent-runtime"
import { useAgentSession } from "@/hooks/use-agent-session"
import { useAgentSessions } from "@/hooks/use-agent-sessions"
import { useNow } from "@/hooks/use-now"
import { RUNTIME_ERROR_PRESENTATION, runtimeBanner } from "@/lib/agents/command-centre/presentation"
import { summarizeAttachment } from "@/lib/agents/command-centre/context-selection"
import { cn } from "@/lib/utils"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeErrorCode } from "@/lib/agents/runtime/protocol"

/**
 * TabDump's command centre.
 *
 * ## What this component is responsible for
 *
 * Composition and nothing else. Every fact it renders arrives from one of five
 * hooks, each of which speaks to the Phase F runtime through the typed command
 * client; every action it offers is one of the fourteen commands the protocol
 * defines. There is no local model of a session, no derived run state, and no
 * second opinion about whether something is allowed — the host decides, and
 * this surface restates the answer.
 *
 * ## The layout
 *
 * Three columns, in the order the mental model runs: which session (left),
 * the session itself (centre), what it can see (right). The centre is the only
 * column that scrolls internally; the outer frame never does, so the composer
 * stays put while a long run streams above it.
 *
 * ## What it refuses to do
 *
 * It renders no session that does not exist, no event it was not sent, no
 * activity count it did not receive, and no file it has not been told about.
 * When the runtime cannot execute — a hosted deployment, or the packaged
 * desktop build, which ships no route handler at all — it says so in one
 * sentence and keeps the rest of TabDump usable, rather than presenting a
 * command centre whose every button would fail.
 */
export function CommandCentreView({
  world,
  onClose,
  /** Injected in tests so the surface can be driven without a network. */
  client,
  poll,
}: {
  world: AgentContextWorld
  onClose: () => void
  client?: RuntimeClient
  poll?: boolean
}) {
  const runtime = useAgentRuntime({
    ...(client ? { client } : {}),
    ...(poll === undefined ? {} : { poll }),
  })

  const projects = useAgentProjects({
    client: runtime.client,
    executable: runtime.executable,
    ...(runtime.status?.runtimeId ? { runtimeId: runtime.status.runtimeId } : {}),
  })

  const sessions = useAgentSessions({
    client: runtime.client,
    executable: runtime.executable,
    ...(runtime.status?.runtimeId ? { runtimeId: runtime.status.runtimeId } : {}),
    ...(poll === undefined ? {} : { poll }),
  })

  const now = useNow(1_000)

  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null)
  const [contextPanelOpen, setContextPanelOpen] = useState(true)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [contextPickerOpen, setContextPickerOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<RuntimeErrorCode | null>(null)

  /*
    Which session is on screen.

    Derived from the runtime's own list rather than held independently: a
    session that was disposed here, or lost when the host restarted, stops
    being in `sessions` and therefore stops being selected, with no effect
    needed to notice and no window in which the centre column renders a header
    for something that is gone.

    `requestedSessionId` is only the user's *request*; the list is what decides
    whether it is still a real session.
  */
  const selected = useMemo(
    () => sessions.sessions.find((entry) => entry.view.sessionId === requestedSessionId) ?? null,
    [sessions.sessions, requestedSessionId]
  )

  const selectedSessionId = selected?.view.sessionId ?? null

  const session = useAgentSession({
    client: runtime.client,
    sessionId: selectedSessionId,
    executable: runtime.executable,
    ...(poll === undefined ? {} : { poll }),
  })

  /*
    The world the resolver reads is the app's own data plus the projects this
    browser authorized — the latter live in the control plane's storage, not in
    the workspace stores, so they are joined here rather than by the shell.
  */
  const contextWorld = useMemo<AgentContextWorld>(
    () => ({ ...world, projects: projects.projects }),
    [world, projects.projects]
  )

  const context = useAgentContext({
    world: contextWorld,
    // The server's answer, relayed. Never a guess made in the browser.
    localRuntimeAllowed: runtime.executable,
  })

  const projectNameOf = useCallback(
    (projectId: string | undefined) =>
      projectId ? projects.projects.find((project) => project.id === projectId)?.name : undefined,
    [projects.projects]
  )

  const banner = runtimeBanner(runtime.status)
  const startableProviders = runtime.status?.providers ?? []

  const handleCreate = useCallback(
    async (input: Parameters<typeof sessions.createSession>[0]) => {
      setCreating(true)
      setCreateError(null)
      const outcome = await sessions.createSession(input)
      setCreating(false)

      if (typeof outcome === "string") {
        setCreateError(outcome)
        return
      }

      setRequestedSessionId(outcome.sessionId)
      setNewSessionOpen(false)
    },
    [sessions]
  )

  /*
    Attaching is resolve-then-send, in that order and in one turn.

    The resolve happens locally and can fail on its own terms — nothing
    selected, or a scope that names a different account — and only a snapshot
    that actually came back is ever sent. The selection is passed into
    `resolve` rather than being written to state first, because state would
    not have landed yet and the resolve would run against the previous choice.
  */
  const attachSelection = useCallback(
    async (selection: Parameters<typeof context.setSelection>[0]) => {
      const outcome = context.resolve(selection)
      if (!outcome.ok || !selectedSessionId) return

      await session.attachContext(outcome.attached)
    },
    [context, selectedSessionId, session]
  )

  const errorPresentation = session.error ? RUNTIME_ERROR_PRESENTATION[session.error] : null

  return (
    <div className="flex h-screen min-h-0 flex-1 flex-col">
      {/*
        The runtime's own answer, at the top, always.

        `executable: false` is not an error state and is not hidden — it is the
        truth about this build, and the rest of the surface stays browsable
        underneath it.
      */}
      {!runtime.executable && !runtime.loading && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-subtle bg-surface px-4 py-2"
        >
          <span aria-hidden className={cn("text-meta", AGENT_TONE_TEXT_CLASS[banner.tone])}>
            ●
          </span>
          <span className="text-body-sm text-foreground">{banner.title}</span>
          <span className="min-w-0 flex-1 truncate text-body-sm text-tertiary">{banner.detail}</span>
          {banner.reconnectable && (
            <Button type="button" size="xs" variant="outline" onClick={() => void runtime.refresh()}>
              <RotateCw />
              Reconnect
            </Button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <SessionList
          sessions={sessions.sessions}
          selectedSessionId={selectedSessionId}
          projectNameOf={projectNameOf}
          onSelect={setRequestedSessionId}
          onNewSession={() => setNewSessionOpen(true)}
          canCreate={runtime.executable}
          now={now}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <SessionHeader
                session={selected}
                {...(projectNameOf(selected.view.projectId)
                  ? { projectName: projectNameOf(selected.view.projectId) }
                  : {})}
                contextPanelOpen={contextPanelOpen}
                onToggleContextPanel={() => setContextPanelOpen((open) => !open)}
                onDispose={() => void sessions.disposeSession(selected.view.sessionId)}
              />

              <EventStream events={session.events}>
                {session.approvals.map((approval) => (
                  <ApprovalPrompt
                    key={approval.approvalId}
                    approval={approval}
                    {...(projectNameOf(approval.projectId)
                      ? { projectName: projectNameOf(approval.projectId) }
                      : {})}
                    pending={session.pending}
                    now={now}
                    onRespond={(approvalId, decision) =>
                      void session.respondToApproval(approvalId, decision)
                    }
                  />
                ))}

                {session.loading && session.events.length === 0 && (
                  <li className="py-2 text-body-sm text-tertiary">Loading the session…</li>
                )}

                {errorPresentation && (
                  <li className="my-2 rounded-md border border-destructive/40 bg-surface px-3 py-2">
                    <p className="text-body-sm text-foreground">{errorPresentation.title}</p>
                    <p className="mt-0.5 text-body-sm text-tertiary">{errorPresentation.action}</p>
                    {errorPresentation.reconnect && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        className="mt-2"
                        onClick={() => void runtime.refresh()}
                      >
                        Reconnect
                      </Button>
                    )}
                  </li>
                )}
              </EventStream>

              <Composer
                status={selected.view.status}
                pending={session.pending}
                cancellable={selected.view.cancellable}
                {...(context.snapshot
                  ? { contextSummary: summarizeAttachment(context.snapshot) }
                  : {})}
                {...(projectNameOf(selected.view.projectId)
                  ? { projectName: projectNameOf(selected.view.projectId) }
                  : {})}
                onOpenContext={() => setContextPickerOpen(true)}
                onCancel={() => void session.cancelRun()}
                /*
                  Context rides along only when the session has not already been
                  told this snapshot.

                  `attach_context` is what gives a session its context, and the
                  host records which snapshot that was. Passing the same one
                  again on every message would re-send the whole attachment each
                  turn — the agent already has it, and it is not free. The
                  comparison is on the snapshot id, which changes on every
                  refresh precisely because a refresh mints a new snapshot.
                */
                onSend={(text) =>
                  void session.sendMessage(
                    text,
                    context.snapshot && context.snapshot.id !== selected.view.contextSnapshotId
                      ? (context.attachedContext ?? undefined)
                      : undefined
                  )
                }
              />
            </>
          ) : (
            <CommandCentreEmptyState
              executable={runtime.executable}
              loading={runtime.loading}
              onNewSession={() => setNewSessionOpen(true)}
              onClose={onClose}
            />
          )}
        </main>

        {contextPanelOpen && (
          <ContextPanel
            session={session.session}
            snapshot={context.snapshot}
            delta={context.delta}
            {...(selected && projectNameOf(selected.view.projectId)
              ? { projectName: projectNameOf(selected.view.projectId) }
              : {})}
            runtimeStatus={runtime.status}
            refreshing={session.pending}
            onEditContext={() => setContextPickerOpen(true)}
            onRefreshContext={() => {
              // A refresh mints a second snapshot and re-attaches it, so the
              // agent is told the newer world explicitly rather than the panel
              // showing counts the session never received.
              const outcome = context.refresh()
              if (outcome.ok && selectedSessionId) void session.attachContext(outcome.attached)
            }}
          />
        )}
      </div>

      <NewSessionDialog
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        providers={startableProviders}
        projects={projects.projects}
        onAddProject={projects.addProject}
        onCreate={(input) => void handleCreate(input)}
        creating={creating}
        {...(createError ? { error: RUNTIME_ERROR_PRESENTATION[createError].title } : {})}
      />

      <ContextPicker
        open={contextPickerOpen}
        onOpenChange={setContextPickerOpen}
        world={contextWorld}
        localRuntimeAllowed={runtime.executable}
        initialSelection={context.selection}
        onConfirm={(selection) => void attachSelection(selection)}
      />
    </div>
  )
}

/**
 * The command centre before anything has been started.
 *
 * Says what the surface is for, then offers the one action that makes sense.
 * It shows no invented metrics, no sample conversation and no placeholder
 * agents — a first-run screen that fabricates activity teaches the user to
 * distrust every number the product shows afterwards.
 */
function CommandCentreEmptyState({
  executable,
  loading,
  onNewSession,
  onClose,
}: {
  executable: boolean
  loading: boolean
  onNewSession: () => void
  onClose: () => void
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-6">
      <IconButton aria-label="Close command centre" className="absolute top-3 right-3" onClick={onClose}>
        <X />
      </IconButton>

      <div className="w-full max-w-md text-center">
        <h1 className="text-h2 text-foreground">Command Centre</h1>
        <p className="mt-2 text-body-sm text-muted-foreground">
          Work with your AI agents using scoped projects and the TabDump context you choose to
          attach.
        </p>

        {loading ? (
          <p className="mt-6 text-body-sm text-tertiary">Checking the agent runtime…</p>
        ) : executable ? (
          <Button type="button" className="mt-6" onClick={onNewSession}>
            <Plus />
            New agent session
          </Button>
        ) : (
          <p className="mt-6 text-body-sm text-tertiary">
            Agents cannot run in this build. You can still browse workspaces, tabs, collections and
            the relationship graph.
          </p>
        )}
      </div>
    </div>
  )
}
