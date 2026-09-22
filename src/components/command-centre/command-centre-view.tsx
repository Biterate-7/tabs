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
import { useRemoteProjects } from "@/hooks/use-remote-projects"
import { useProviderConnections } from "@/hooks/use-provider-connections"
import { RUNTIME_ERROR_PRESENTATION, runtimeBadge, runtimeBanner } from "@/lib/agents/command-centre/presentation"
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
  /**
   * The transport the remote-projects resource uses.
   *
   * Separate from `client` because it is a different resource with a different
   * shape — the control plane's typed command endpoint versus a REST resource
   * that carries files. Injected for the same reason: so the surface can be
   * driven without a network.
   */
  remoteFetch,
  /**
   * Takes the user to Settings → AI Connectors, where they connect their own
   * provider credentials.
   *
   * Optional, and the dialog degrades to a sentence without a button when it
   * is absent — a surface with nowhere to send somebody should not offer an
   * action that goes nowhere.
   */
  onOpenConnectors,
}: {
  world: AgentContextWorld
  onClose: () => void
  client?: RuntimeClient
  poll?: boolean
  remoteFetch?: typeof fetch
  onOpenConnectors?: () => void
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
  /**
   * `REMOTE · Ready`, `LOCAL · Ready`, or the plain refusal.
   *
   * The brief's requirement, and the reason it is a requirement: on a hosted
   * deployment the old sentence ("Agent runtime unavailable") was true when it
   * was written and is now false, because agents genuinely run — in a sandbox
   * TabDump creates, which is nobody's computer. Naming the plane is also the
   * honest half: a user is owed the difference between an agent editing files
   * on their laptop and one editing files in a container.
   */
  const badge = runtimeBadge(runtime.status)
  const startableProviders = runtime.status?.providers ?? []

  /*
    Whether to talk to the remote-projects endpoint at all.

    The host's own answer, relayed: a local TabDump has no remote plane and
    should not spend a request per mount being told 503. Never inferred from a
    hostname or a build flag.
  */
  const remoteEnabled = runtime.status?.environment === "remote" && runtime.executable

  const remoteProjects = useRemoteProjects({
    enabled: remoteEnabled,
    ...(remoteFetch ? { fetch: remoteFetch } : {}),
  })

  /*
    This user's own provider connections.

    Read so the start dialog can say whose credentials a session is about to
    run on — and so it can offer the Connect button when the answer is "none
    yet". Whether somebody has connected a key changes when they press a
    button in settings, not on a timer, so there is no polling here.
  */
  const connections = useProviderConnections()

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
        Where you are, and whether agents can run here.

        This row used to appear only when the runtime was *not* executable,
        which meant the healthy state said nothing at all: `runtimeBanner`
        has always had a "Local runtime ready" answer and nothing rendered it.
        A command centre that is silent about its runtime until something is
        wrong makes the user check the context panel to find out whether the
        thing they are about to type will run.

        So the row is permanent and carries two facts — location on the left,
        runtime on the right. It stays one line of quiet text when everything
        is fine, and only the unavailable case spends the horizontal space on
        the gate's full sentence.
      */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-subtle px-4">
        <span className="text-eyebrow text-tertiary">TabDump</span>
        <span aria-hidden className="text-tertiary">
          /
        </span>
        <span className="text-label text-foreground">Command Centre</span>
        {selected && projectNameOf(selected.view.projectId) && (
          <>
            <span aria-hidden className="text-tertiary">
              /
            </span>
            <span className="min-w-0 truncate text-label text-muted-foreground">
              {projectNameOf(selected.view.projectId)}
            </span>
          </>
        )}

        {!runtime.loading && (
          <div role="status" className="ml-auto flex min-w-0 items-center gap-2">
            <span aria-hidden className={cn("text-meta", AGENT_TONE_TEXT_CLASS[banner.tone])}>
              ●
            </span>
            <span className="shrink-0 text-label text-muted-foreground">{badge}</span>
            {/* After the title, so the row reads "● Agent runtime unavailable ·
                <why>" rather than trailing off into the headline. Truncates
                first, because the title is the part that must survive. */}
            {!runtime.executable && (
              <span className="hidden min-w-0 truncate text-body-sm text-tertiary lg:inline">
                · {banner.detail}
              </span>
            )}
            {banner.reconnectable && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void runtime.refresh()}
              >
                <RotateCw />
                Reconnect
              </Button>
            )}
          </div>
        )}

        {/*
          Back to the workspace.

          Anchored here rather than floating in the empty state, where it used
          to sit absolutely positioned against nothing — with no header on that
          column it read as a stray glyph in open space, and it disappeared
          entirely once a session was selected. In the bar it is in the same
          place at every moment of the surface's life.
        */}
        <IconButton
          aria-label="Close command centre"
          className={cn("size-7 shrink-0", runtime.loading && "ml-auto")}
          onClick={onClose}
        >
          <X />
        </IconButton>
      </div>

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
            />
          )}
        </main>

        {contextPanelOpen && (
          <ContextPanel
            session={session.session}
            world={contextWorld}
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
        status={runtime.status}
        providers={startableProviders}
        projects={projects.projects}
        onAddProject={projects.addProject}
        {...(remoteEnabled
          ? {
              remote: {
                projects: remoteProjects.projects,
                loading: remoteProjects.loading,
                unavailable: remoteProjects.unavailable,
                creating: remoteProjects.creating,
                create: remoteProjects.create,
              },
            }
          : {})}
        connectionFor={connections.forProvider}
        onCreate={(input) => void handleCreate(input)}
        {...(onOpenConnectors ? { onConnectProvider: onOpenConnectors } : {})}
        creating={creating}
        now={now}
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
}: {
  executable: boolean
  loading: boolean
  onNewSession: () => void
}) {
  return (
    /*
      Sits a little above centre rather than dead centre.

      With the composer gone there is nothing below this block, so true
      vertical centring left it stranded in the middle of a very tall empty
      column. Pulling it up to roughly the optical third puts it where the
      conversation would start.
    */
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-24">
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
