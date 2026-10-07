"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { ArrowUp, Bot, ChevronLeft, FolderGit2, RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { AgentIcon } from "@/components/agents/agent-icon"
import { AgentActivity } from "@/components/agents/agent-activity"
import { ActivityPopover } from "./activity-popover"
import { AgentHistoryList } from "./agent-history-list"
import { AgentRoster } from "./agent-roster"
import { ApprovalPrompt } from "./approval-prompt"
import { ConnectAgentDialog } from "./connect-agent-dialog"
import { Composer } from "./composer"
import { ContextPanel } from "./context-panel"
import { ContextPicker } from "./context-picker"
import { EventStream } from "./event-stream"
import { HandoffDialog, handoffAgentOptions } from "./handoff-dialog"
import type { HandoffStartResult } from "./handoff-dialog"
import { HistorySessionView } from "./history-session-view"
import { NewSessionDialog } from "./new-session-dialog"
import { SessionHeader } from "./session-header"
import { SessionList } from "./session-list"
import { TaskStatus } from "./task-status"
import { WorkingContextChip } from "./working-context-control"
import type { WorkingContextActions } from "./working-context-control"
import { useCommandPaletteHost } from "@/components/command-palette/palette-host"
import type { Command } from "@/components/command-palette/types"
import { useHistorySessionActivity, useSessionActivity } from "@/hooks/use-agent-activity"
import { useAgentHistory, useHistorySession } from "@/hooks/use-agent-history"
import { useLastTask } from "@/hooks/use-last-task"
import { contextPackAttachedContext } from "@/lib/agents/context-pack/attach"
import { handoffContextPack } from "@/lib/agents/context-pack/handoff"
import { contextProvenanceOf } from "@/lib/agents/context-pack/provenance"
import { handoffThatStarted, sessionContextPack } from "@/lib/agents/context-pack/session"
import { filesChangedOutside, measuredProjectFiles, useSessionContextPack } from "@/hooks/use-session-context-pack"
import { useWorkspaceProject } from "@/hooks/use-workspace-project"
import { AttachProjectDialog, WorkspaceProjectSection } from "./workspace-project"
import type { ProjectWorkActions } from "@/components/agents/project-work"
import { describeProject } from "@/lib/agents/project/describe"
import { PROJECT_STATE_COPY, projectKindLine } from "@/lib/agents/project/present"
import { readGitStatusCounts } from "@/lib/agents/project/checks"
import { checkRunningIn, latestGitCountsIn } from "@/lib/agents/project/changes"
import { workspaceProjectBindings, workspaceProjectId } from "@/lib/workspace/project"
import type { GitStatusCounts } from "@/lib/agents/project/checks"
import { selectHandoffContext } from "@/lib/agents/handoff/handoff"
import type { HandoffInclude } from "@/lib/agents/handoff/handoff"
import type { RuntimeHandoffPreview } from "@/lib/agents/runtime/protocol"
import { useAgentProjects } from "@/hooks/use-agent-projects"
import { useAgentRuntime } from "@/hooks/use-agent-runtime"
import { useAgentSession } from "@/hooks/use-agent-session"
import { useAgentSessions } from "@/hooks/use-agent-sessions"
import { useNow } from "@/hooks/use-now"
import { useRemoteProjects } from "@/hooks/use-remote-projects"
import { useProviderConnections } from "@/hooks/use-provider-connections"
import { useAgentPlatform } from "@/hooks/use-agent-platform"
import { useCollectionStore } from "@/hooks/use-collection-store"
import { useSessionContext } from "@/hooks/use-session-context"
import { useProjectContents } from "@/hooks/use-project-contents"
import { AgentSwitcher } from "./agent-switcher"
import { recordProjectEvent, recordProjectTask } from "@/lib/projects/activity"
import { contextSummary } from "@/lib/projects/state"
import { hasUsableMcpToken, useMcpTokens } from "@/hooks/use-mcp-tokens"
import { platformProvider } from "@/lib/agents/platform/catalog"
import { recoveryLabel, signInKind } from "@/lib/agents/platform/lifecycle"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"
import { grantWithinApproval, projectScopesForAgent } from "@/lib/agents/platform/roster"
import { agentConnectorSurface, agentProjectFolderPicker } from "@/lib/platform"
import {
  RUNTIME_ERROR_PRESENTATION,
  runtimeErrorTitle,
  SESSION_STATUS_LABEL,
  SESSION_VISUAL_STATE,
  canCreateSession,
  canSendMessage,
  isTerminalSession,
  runtimeBadge,
  runtimeBanner,
} from "@/lib/agents/command-centre/presentation"
import {
  addToContext,
  contextOfSession,
  describeWorkingContext,
  handoffTarget,
  intentPrompt,
  removeFromContext,
  summarizeWorkingContext,
  withinWorkspace,
  workspaceContext,
  workspaceIdOf,
  workspaceLinkOf,
} from "@/lib/agents/command-centre/working-context"
import {
  collectionToView,
  describeChange,
  markWorkspaceChangeUndone,
  recordWorkspaceChange,
  subscribeWorkspaceChanges,
  workspaceChanges,
} from "@/lib/agents/command-centre/workspace-activity"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { collectionsMatch } from "@/lib/collections/restore"
import { historySessionStatus } from "@/lib/agents/activity/history"
import { taskOutcome } from "@/lib/agents/activity/outcome"
import { lastTaskOf, lastTaskStateLabel, rememberLastTask } from "@/lib/agents/command-centre/last-task"
import type { LastTask } from "@/lib/agents/command-centre/last-task"
import { formatRelativeTime } from "@/lib/time-format"
import { recordLoopMilestone } from "@/lib/product/loop-log"
import { UNDO_REFUSED_WORKSPACE_CHANGED } from "@/lib/agents/activity/inspector"
import { canHandOffFrom } from "@/lib/agents/handoff/handoff"
import { runtimeHandoffTransport } from "@/lib/agents/handoff/transport"
import type { AgentHistorySession } from "@/lib/agents/activity/history"
import { cn } from "@/lib/utils"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { AgentHandoff, WorkingContext, WorkspaceLink } from "@/lib/agents/command-centre/working-context"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { Workspace } from "@/lib/workspace/types"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeErrorCode } from "@/lib/agents/runtime/protocol"

/**
 * Hubble's command centre — where the user works with an agent *inside* a
 * workspace.
 *
 * ## What this component is responsible for
 *
 * Composition. Every fact it renders arrives from the runtime through the
 * typed client (sessions, their workspace, what they are pointed at, what
 * they may do) or from the app's own live data (names). There is no local
 * model of a session and no second opinion about what is allowed.
 *
 * ## The loop it closes
 *
 *     workspace ──(a selection, a collection, a tab)──▶ context
 *          ▲                                              │
 *          │                                        agent session
 *          │                                              │
 *     applied change ◀──(approved)── agent action ◀───────┘
 *
 *   - **Workspace → context.** A session works in the workspace it was
 *     started from (fixed for its life). Its context — the whole workspace,
 *     or tabs and collections chosen in it — is attached through the Phase E
 *     bridge, *per session*, and reported back by the runtime as the
 *     session's focus. Requests from the workspace arrive as a handoff and
 *     go to a session in the same workspace, or become the context of the
 *     next one.
 *   - **Agent → workspace.** Approved changes are applied here, through the
 *     same collection store the workspace uses, then said in words — a row in
 *     the session, a notification with "View", an exact "Undo" while nothing
 *     has changed since.
 *
 * ## What it refuses to do
 *
 * It renders no session that does not exist, no event it was not sent, and no
 * context the runtime did not confirm. When the runtime cannot execute it says
 * so in one sentence and keeps the rest of Hubble usable.
 */
export function CommandCentreView({
  world,
  onClose,
  /** Injected in tests so the surface can be driven without a network. */
  client,
  poll,
  /**
   * The transport the remote-projects resource uses — a REST resource, not
   * the control plane's command endpoint. Injected for tests.
   */
  remoteFetch,
  /** Takes the user to Settings → AI Connectors. Optional; without it the dialog says where to go. */
  onOpenConnectors,
  activeWorkspaceId,
  handoff,
  onHandoffConsumed,
  onViewWorkspace,
  onUpdateWorkspaceBrief,
  onAttachWorkspaceProject,
  openSessionId,
  onOpenSessionConsumed,
}: {
  world: AgentContextWorld
  onClose: () => void
  client?: RuntimeClient
  poll?: boolean
  remoteFetch?: typeof fetch
  onOpenConnectors?: () => void
  /** The workspace the user came from: where a new session works, by default. */
  activeWorkspaceId?: string
  /** A request from the workspace — "ask an agent about these". Consumed once. */
  handoff?: AgentHandoff | null
  onHandoffConsumed?: (id: string) => void
  /** Shows a workspace (and a collection in it) — where "View" on an agent's change goes. */
  onViewWorkspace?: (workspaceId: string, collectionId?: string) => void
  /** Saves a workspace's brief (Hubble 1.5) to the app's workspace store. Absent: the brief is read-only here. */
  onUpdateWorkspaceBrief?: (workspaceId: string, brief: { description: string; focus: string }) => void
  /** Attaches a project to a workspace, or detaches with `null` (Hubble 1.6). Absent: read-only here. */
  onAttachWorkspaceProject?: (workspaceId: string, projectId: string | null) => void
  /** A session to open on arrival — the workspace’s last task, from the workspace (Stage 3). Consumed once it is found, or known to be gone. */
  openSessionId?: string
  onOpenSessionConsumed?: () => void
}) {
  const runtime = useAgentRuntime({
    ...(client ? { client } : {}),
    ...(poll === undefined ? {} : { poll }),
  })

  // Which workspaces each project belongs to (Hubble 1.6) — the runtime enforces it.
  const workspaceBindings = useMemo(() => workspaceProjectBindings(world.workspaces), [world.workspaces])
  const projects = useAgentProjects({
    client: runtime.client,
    executable: runtime.executable,
    workspaceBindings,
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
  const [creating, setCreating] = useState(false)
  /** Why the last start was refused, and for which agent — so it can say "Couldn't connect to Codex". */
  const [createError, setCreateError] = useState<{ code: RuntimeErrorCode; provider: AgentProviderId } | null>(null)

  /*
    Which session is on screen: derived from the runtime's own list, so a
    session that is gone stops being selected with no effect needed.
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
    The on-screen session, as freshly as it is known: the session's own read
    (re-read right after every command, such as attaching context) when it is
    for this session, the list's otherwise.
  */
  const current = useMemo(() => {
    if (!selected) return null
    const fresh = session.session?.sessionId === selected.view.sessionId ? session.session : null
    return fresh ? { ...selected, view: fresh } : selected
  }, [selected, session.session])
  /*
    The list, with the on-screen session as freshly as it is known — so its
    row never says "Running" while its header says "Waiting for approval".
  */
  const listedSessions = useMemo(
    () => (current ? sessions.sessions.map((entry) => (entry.view.sessionId === current.view.sessionId ? current : entry)) : sessions.sessions),
    [current, sessions.sessions]
  )

  /*
    The context the next new session starts with — what the user brought from
    the workspace when no session there could take it. Tied to its workspace:
    a session started somewhere else starts with the whole of that one.
  */
  const [draft, setDraft] = useState<WorkingContext | null>(null)

  /*
    The workspace the Command Centre is about: the on-screen session's, else
    the one a new session would start in — the draft's, else the active one.
    One answer for the brief, the Context Pack, the project and where a
    project is attached, so they can never describe different workspaces.
  */
  const workspaceShown = current ? workspaceIdOf(current.view) : (draft?.workspaceId ?? activeWorkspaceId)

  /*
    The workspace's project (Hubble 1.6), inspected by the runtime — which
    alone holds the path — again whenever an agent's change is measured.
  */
  const projectWorkspace = workspaceShown ? world.workspaces.find((workspace) => workspace.id === workspaceShown) : undefined
  const sessionProjectFiles = useMemo(
    () => (selectedSessionId ? measuredProjectFiles(session.events, selectedSessionId).map((file) => file.path) : []),
    [session.events, selectedSessionId]
  )
  const projectEventCount = useMemo(
    () => session.events.filter((event) => event.kind === "project_changed" || event.kind === "project_change_undone").length,
    [session.events]
  )
  const workspaceProject = useWorkspaceProject({
    client: runtime.client,
    status: runtime.status,
    executable: runtime.executable,
    workspace: projectWorkspace,
    projects: projects.projects,
    files: sessionProjectFiles,
    // Asked again once the runtime has been told the project: a look that
    // raced that sync was answered "not known yet" and would stay "Checking".
    refreshKey: `${projectEventCount}|${projects.syncState}`,
    rejected: projects.rejected,
  })
  /** A project as an agent is told it — its capabilities that agent's own, never another's. */
  const projectDescriptorFor = useCallback(
    (projectId: string | undefined, provider?: AgentProviderId) => {
      const project = projectId ? projects.projects.find((candidate) => candidate.id === projectId) : undefined
      if (!project) return undefined
      const providerCapabilities = provider ? runtime.status?.providers.find((entry) => entry.provider === provider)?.capabilities : undefined
      const inspection = workspaceProject.inspection?.projectId === project.id ? workspaceProject.inspection : undefined
      return describeProject({
        project,
        ...(inspection ? { inspection } : {}),
        local: Boolean(workspaceProject.supported),
        ...(providerCapabilities ? { providerCapabilities } : {}),
      })
    },
    [projects.projects, runtime.status, workspaceProject.inspection, workspaceProject.supported]
  )

  /*
    Session workspace context (Phase J.3): the Command Centre's own collection
    store — the same one the workspace view uses — so an approved change is
    made exactly as a person making it would, and names read here are live.
  */
  const collectionStore = useCollectionStore(world.workspaces as Workspace[])
  const liveWorld = useMemo(
    () => ({ workspaces: world.workspaces, collections: collectionStore.collections, dependencies: world.dependencies }),
    [world.workspaces, world.dependencies, collectionStore.collections]
  )

  /*
    The world the Phase E resolver reads: the app's data with the live
    collections, plus the projects this browser authorized.
  */
  const contextWorld = useMemo<AgentContextWorld>(
    () => ({ ...world, collections: collectionStore.collections, projects: projects.projects }),
    [world, collectionStore.collections, projects.projects]
  )

  const projectNameOf = useCallback(
    (projectId: string | undefined) =>
      projectId ? projects.projects.find((project) => project.id === projectId)?.name : undefined,
    [projects.projects]
  )
  const workspaceNameOf = useCallback(
    (workspaceId: string | undefined) =>
      workspaceId ? world.workspaces.find((workspace) => workspace.id === workspaceId)?.name : undefined,
    [world.workspaces]
  )

  const banner = runtimeBanner(runtime.status)
  const badge = runtimeBadge(runtime.status)
  const startableProviders = useMemo(() => runtime.status?.providers ?? [], [runtime.status])

  // The host's own answer: a local Hubble has no remote plane to ask.
  const remoteEnabled = runtime.status?.environment === "remote" && runtime.executable
  const remoteProjects = useRemoteProjects({
    enabled: remoteEnabled,
    ...(remoteFetch ? { fetch: remoteFetch } : {}),
  })

  /* This user's own provider connections — whose credentials a session runs on. */
  const connections = useProviderConnections()

  const [surface] = useState(() => agentConnectorSurface())

  /* The agent connector platform (Phase J): the roster of connected agents. */
  const providerKeyConnected = useCallback(
    (provider: AgentProviderId): boolean | undefined => {
      const spec = platformProvider(provider)
      // Only an agent whose sign-in *here* is a key Hubble stores. Where it
      // signs in on its own (the desktop app), a stored key is irrelevant.
      if (!spec || signInKind(spec, undefined, surface) !== "provider-key") return undefined
      if (connections.loading || connections.failure) return undefined
      return connections.forProvider(provider)?.status === "connected"
    },
    [connections, surface]
  )
  const mcpTokens = useMcpTokens({ enabled: surface === "web" })
  const mcpTokenIssued = hasUsableMcpToken(mcpTokens.state, now)

  const platform = useAgentPlatform({
    client: runtime.client,
    status: runtime.status,
    providerKeyConnected,
    surface,
    ...(mcpTokenIssued !== undefined ? { mcpTokenIssued } : {}),
  })
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectProvider, setConnectProvider] = useState<AgentProviderId | null>(null)

  const openConnect = useCallback((provider?: AgentProviderId) => {
    setConnectProvider(provider ?? null)
    setNewSessionOpen(false)
    setConnectOpen(true)
  }, [])

  /*
    The session the person was starting when a sign-in got in the way
    (Agent Authentication & Runtime). Kept while they recover in Connect
    Agent, and handed back to New session when they come back — the agent,
    the workspace and the title they chose, and the first message they
    typed (kept separately, below). Never a credential: there is none here.
  */
  const [resume, setResume] = useState<{ provider: AgentProviderId; workspaceId?: string; title?: string } | null>(null)
  const recoverFromNewSession = useCallback(
    (provider: AgentProviderId, draft?: { workspaceId?: string; title?: string }) => {
      setResume({ provider, ...draft })
      openConnect(provider)
    },
    [openConnect]
  )
  const returnToNewSession = useCallback(() => {
    if (!resume) return false
    setNewSessionOpen(true)
    return true
  }, [resume])

  /* The desktop app (Phase J.1): folders come only from the native picker. */
  const [pickFolder] = useState(() => agentProjectFolderPicker())
  const projectScopesFor = useCallback(
    (provider: AgentProviderId) => {
      // Exactly what the agent was approved for in Connect Agent — including
      // Run commands, when the person turned it on there — and nothing else.
      return projectScopesForAgent(platform.identity(provider))
    },
    [platform]
  )
  /*
    Signing in, from New session. One place for every provider and every
    method: Connect Agent shows the methods this agent offers here — its own
    sign-in, or a key Hubble stores — and the session the person was starting
    is kept for when they come back.
  */
  const signInFor = useCallback(
    (provider?: AgentProviderId, draft?: { workspaceId?: string; title?: string }) => {
      if (provider) recoverFromNewSession(provider, draft)
      else onOpenConnectors?.()
    },
    [onOpenConnectors, recoverFromNewSession]
  )

  const workspaceChoices = useMemo(
    () => world.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
    [world.workspaces]
  )

  /* ---------------- What agents changed, said in words. */

  const allChanges = useSyncExternalStore(subscribeWorkspaceChanges, workspaceChanges, workspaceChanges)
  const viewChange = useCallback(
    (change: AppliedWorkspaceChange) => onViewWorkspace?.(change.workspaceId, collectionToView(change)),
    [onViewWorkspace]
  )

  const handleApplied = useCallback(
    (change: AppliedWorkspaceChange) => {
      recordWorkspaceChange(change)
      // The same record, durably (agent history): names, counts and the
      // snapshot either side, for the session's history and its undo. The
      // runtime adds whose, where and which approval itself. A Hubble that
      // keeps no history refuses, and nothing else changes.
      void runtime.client.send({
        name: "record_workspace_change",
        sessionId: change.sessionId,
        change: {
          id: change.id,
          at: change.at,
          ok: change.ok,
          ...(change.planId ? { planId: change.planId } : {}),
          steps: change.steps,
          ...(change.before && change.after ? { before: change.before, after: change.after } : {}),
        },
      })
      const agent = agentDisplayName(change.provider)
      const where = workspaceNameOf(change.workspaceId) ?? "your workspace"
      if (!change.ok) {
        toast.error(`${agent} · Couldn't apply the approved change`, { description: `Nothing was changed in ${where}.` })
        return
      }
      toast.success(`${agent} · ${describeChange(change)}`, {
        description: `In ${where}`,
        ...(onViewWorkspace
          ? { action: { label: "View", onClick: () => onViewWorkspace(change.workspaceId, collectionToView(change)) } }
          : {}),
      })
    },
    [onViewWorkspace, workspaceNameOf, runtime.client]
  )

  /*
    The extracted text of project sources (Hubble 2.0), loaded only for the
    projects a live session works in and the one on screen: each session's
    snapshot carries the content of its own selected sources, nothing more.
  */
  const contentWorkspaces = useMemo(() => {
    const ids = new Set<string>()
    for (const { view } of sessions.sessions) if (view.context && !isTerminalSession(view.status)) ids.add(view.context.workspaceId)
    if (activeWorkspaceId) ids.add(activeWorkspaceId)
    return world.workspaces.filter((workspace) => ids.has(workspace.id))
  }, [sessions.sessions, activeWorkspaceId, world.workspaces])
  const projectContents = useProjectContents(contentWorkspaces)

  const sessionContext = useSessionContext({
    client: runtime.client,
    sessions: sessions.sessions,
    world,
    collections: collectionStore.collections,
    applyCollectionBatch: collectionStore.applyBatch,
    onApplied: handleApplied,
    contents: projectContents,
  })

  /*
    Exact undo, only while the workspace is still what the change left.
    Decided once per change of the collections or of the record — not per
    render: the surface re-renders every second for its clocks.
  */
  const undoable = useMemo(() => {
    const ids = new Set<string>()
    for (const change of allChanges) {
      if (!change.ok || change.undone || !change.before || !change.after) continue
      if (collectionsMatch(collectionStore.collections, change.workspaceId, change.after)) ids.add(change.id)
    }
    return ids
  }, [allChanges, collectionStore.collections])
  const canUndo = useCallback((change: AppliedWorkspaceChange) => undoable.has(change.id), [undoable])
  /*
    The one way a change is undone, wherever it is asked for: the store puts
    the workspace's collections back exactly (refusing, with nothing moved,
    if anything changed since), and only then is the undo recorded — as its
    own fact, after the change, which keeps its place in the history.
  */
  const tryUndo = useCallback(
    (change: AppliedWorkspaceChange): boolean => {
      if (!change.ok || change.undone || !change.before || !change.after) return false
      if (!collectionStore.restoreCollections(change.workspaceId, change.before, change.after)) return false
      markWorkspaceChangeUndone(change.id)
      // Told to agent history as its own fact, after the change.
      void runtime.client.send({
        name: "record_workspace_undo",
        workspaceId: change.workspaceId,
        sessionId: change.sessionId,
        changeId: change.id,
        at: Date.now(),
      })
      return true
    },
    [collectionStore, runtime.client]
  )
  const undoChange = useCallback(
    (change: AppliedWorkspaceChange) => {
      if (tryUndo(change)) {
        toast(`Undone in ${workspaceNameOf(change.workspaceId) ?? "the workspace"}`)
      } else {
        toast.info("Couldn't undo this change", { description: `${UNDO_REFUSED_WORKSPACE_CHANGED} Nothing was changed.` })
      }
    },
    [tryUndo, workspaceNameOf]
  )

  /* ---------------- Context: per session, inside its workspace. */

  const [contextBusy, setContextBusy] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)

  /**
   * Points a session at a context: its Context Pack (Hubble 1.5) — the
   * selection resolved inside the session's workspace by the Phase E bridge,
   * with the workspace's brief — attached; or, when the pack has nothing to
   * attach (the whole workspace, no brief), detached, because the session
   * reads its workspace itself. The runtime checks it again and reports it
   * back as the session's focus and context id.
   */
  const applyContext = useCallback(
    async (sessionId: string, next: WorkingContext): Promise<boolean> => {
      const built = sessionContextPack({
        world: contextWorld,
        workspaceId: next.workspaceId,
        selection: next,
        sessionId,
        changes: workspaceChanges(),
        ...(sessionId === selectedSessionId ? { handoffFrom: handoffThatStarted(sessionId, session.handoffs) } : {}),
        // The project it works in (Hubble 1.6), described for its own agent.
        ...(() => {
          const target = sessions.sessions.find((entry) => entry.view.sessionId === sessionId)?.view
          const project = projectDescriptorFor(target?.projectId, target?.provider)
          return project ? { project, projectFiles: filesChangedOutside(measuredProjectFiles(session.events, sessionId), project) } : {}
        })(),
      })
      if (!built.ok) {
        setContextError("Hubble couldn't prepare that context. Nothing was sent.")
        return false
      }
      const attached = contextPackAttachedContext(built.pack, Date.now())
      setContextBusy(true)
      const result = attached
        ? await runtime.client.send({ name: "attach_context", sessionId, context: attached })
        : await runtime.client.send({ name: "detach_context", sessionId })
      setContextBusy(false)
      if (!result.ok) {
        setContextError(
          result.error.code === "context_invalid"
            ? "That isn't in this session's workspace, so it wasn't added."
            : RUNTIME_ERROR_PRESENTATION[result.error.code].title
        )
        return false
      }
      setContextError(null)
      recordLoopMilestone("context_changed")
      // The person chose what a task works from (Hubble 2.0): counted, never named.
      recordLoopMilestone("context_selected")
      if (built.pack.sources.length > 0) recordProjectEvent({ workspaceId: built.pack.workspace.id, kind: "context_selected", count: built.pack.sources.length })
      await sessions.refresh()
      if (sessionId === selectedSessionId) await session.refresh()
      return true
    },
    [contextWorld, runtime.client, selectedSessionId, session, sessions, projectDescriptorFor]
  )

  const [draftText, setDraftText] = useState("")
  const [defaultProvider, setDefaultProvider] = useState<AgentProviderId | undefined>(undefined)
  const [firstMessage, setFirstMessage] = useState<string | undefined>(undefined)
  const [composerSeed, setComposerSeed] = useState<{ key: string; sessionId: string; text: string } | null>(null)
  const [queued, setQueued] = useState<{ sessionId: string; text: string } | null>(null)
  const [pickerFor, setPickerFor] = useState<{ sessionId: string | null; key: number } | null>(null)

  /* ---------------- Requests from the workspace. */

  const consumed = useRef<string | null>(null)
  useEffect(() => {
    if (!handoff || consumed.current === handoff.id) return
    // Wait until it is known which sessions exist; on a runtime that cannot
    // execute there will never be any, and the request becomes a draft.
    if (runtime.loading || (runtime.executable && !sessions.listed)) return
    consumed.current = handoff.id
    onHandoffConsumed?.(handoff.id)

    const scoped = withinWorkspace(handoff.context, liveWorld).context
    const prompt = intentPrompt(handoff.intent, describeWorkingContext(scoped, liveWorld)) ?? ""
    const target = runtime.executable ? handoffTarget(sessions.sessions, handoff, selectedSessionId) : null
    /*
      Synchronizing with an external input — a request handed over by the
      shell — once, after the sessions it may go to are known. There is no
      render-time derivation of "which session took it".
    */
    /* eslint-disable react-hooks/set-state-in-effect */
    if (target) {
      const targetView = sessions.sessions.find((entry) => entry.view.sessionId === target)!.view
      const existing = contextOfSession(targetView) ?? workspaceContext(scoped.workspaceId)
      const next = handoff.mode === "add" ? (addToContext(existing, scoped) ?? scoped) : scoped
      setRequestedSessionId(target)
      void applyContext(target, next)
      if (prompt) setComposerSeed({ key: handoff.id, sessionId: target, text: prompt })
      if (handoff.mode === "add") {
        toast(`Added to ${agentDisplayName(targetView.provider)}'s context`, {
          description: summarizeWorkingContext(describeWorkingContext(next, liveWorld)),
        })
      }
    } else {
      setRequestedSessionId(null)
      setDraft((existing) =>
        handoff.mode === "add" && existing ? (addToContext(existing, scoped) ?? scoped) : scoped
      )
      setDraftText(prompt)
      setDefaultProvider(handoff.provider)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [
    applyContext,
    handoff,
    liveWorld,
    onHandoffConsumed,
    runtime.executable,
    runtime.loading,
    selectedSessionId,
    sessions.listed,
    sessions.sessions,
  ])

  /* ---------------- Starting a session. */

  /*
    One create at a time (Agent Authentication & Runtime). `creating` disables
    the button, but only after a render; two presses in one frame would both
    get here. The ref is checked and set synchronously, so the second press
    finds a create in flight and does nothing — no second session, and no
    second copy of the workspace snapshot bound to one.
  */
  const createInFlight = useRef(false)

  const handleCreate = useCallback(
    async (input: Parameters<typeof sessions.createSession>[0]) => {
      if (createInFlight.current) return
      setCreateError(null)

      // Only an agent the user connected and approved, and never on a project
      // that grants it more than they approved it for.
      const agent = platform.identity(input.provider)
      const project = input.projectId
        ? projects.projects.find((candidate) => candidate.id === input.projectId)
        : undefined
      if (!agent || (project && !grantWithinApproval(agent, project.permissions.scopes))) {
        setCreateError({ code: "permission_denied", provider: input.provider })
        return
      }

      // Signed in, with a sign-in Hubble may use, and reachable — refused here
      // only when that is genuinely not so, and never by picking another way
      // to sign in: the dialog shows the action that fixes it.
      const prerequisite = platform.prerequisiteFor(input.provider)
      if (!prerequisite.ok) {
        setCreateError({ code: refusalFor(prerequisite.phase), provider: input.provider })
        return
      }

      // The workspace the session works in goes with it, for the agent to
      // query; the context brought from it, if it is that workspace's.
      // With the content of the sources it was given (Hubble 2.0), ranked by the first task when there is one.
      const contextSnapshot = input.workspaceId
        ? sessionContext.snapshotFor(input.workspaceId, {
            selection: draft && input.workspaceId === draft.workspaceId ? draft : null,
            ...(firstMessage ? { instruction: firstMessage } : {}),
          })
        : undefined
      // The new session's Context Pack: what was brought from the workspace,
      // if it is this one's, else the whole workspace — with its brief.
      const brought = input.workspaceId
        ? sessionContextPack({
            world: contextWorld,
            workspaceId: input.workspaceId,
            selection: draft && input.workspaceId === draft.workspaceId ? draft : null,
            changes: workspaceChanges(),
            // The project it will work in (Hubble 1.6), told from the start.
            ...(projectDescriptorFor(input.projectId, input.provider) ? { project: projectDescriptorFor(input.projectId, input.provider)! } : {}),
          })
        : undefined
      const startContext = (brought?.ok ? contextPackAttachedContext(brought.pack, Date.now()) : null) ?? undefined

      createInFlight.current = true
      setCreating(true)
      let outcome: Awaited<ReturnType<typeof sessions.createSession>>
      try {
        outcome = await sessions.createSession({
          ...input,
          ...(contextSnapshot ? { contextSnapshot } : {}),
          ...(startContext ? { context: startContext } : {}),
        })
      } finally {
        createInFlight.current = false
        setCreating(false)
      }

      if (typeof outcome === "string") {
        setCreateError({ code: outcome, provider: input.provider })
        return
      }
      setResume(null)
      recordLoopMilestone("session_started", { provider: input.provider })
      recordLoopMilestone("agent_selected", { provider: input.provider })
      if (firstMessage) recordLoopMilestone("task_submitted", { provider: input.provider })

      platform.recordSession(input.provider, outcome.sessionId, input.workspaceId)
      setRequestedSessionId(outcome.sessionId)
      setNewSessionOpen(false)
      if (startContext) setDraft(null)
      if (firstMessage) setQueued({ sessionId: outcome.sessionId, text: firstMessage })
      else if (draftText) setComposerSeed({ key: `new-${outcome.sessionId}`, sessionId: outcome.sessionId, text: draftText })
      setFirstMessage(undefined)
      setDraftText("")
    },
    [contextWorld, draft, draftText, firstMessage, platform, projects.projects, sessionContext, sessions, projectDescriptorFor]
  )

  /*
    A first message typed before the session existed is sent once the session
    can take one — the runtime decides when that is, and the session's own
    read says so.
  */
  const currentView = current?.view ?? null
  useEffect(() => {
    if (!queued || !currentView || currentView.sessionId !== queued.sessionId) return
    if (!canSendMessage(currentView.status) || session.pending) return
    const text = queued.text
    // Sending is the external effect; clearing the queue records that it happened.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueued(null)
    void session.sendMessage(text)
  }, [currentView, queued, session])

  /* ---------------- The on-screen session's relationship to its workspace. */

  const sessionWorkspaceId = currentView ? workspaceIdOf(currentView) : undefined
  const link: WorkspaceLink = currentView
    ? workspaceLinkOf(currentView, world.workspaces)
    : activeWorkspaceId
      ? { kind: "live", canChange: false }
      : { kind: "none" }
  const sessionContextView = useMemo(() => {
    if (!currentView) return null
    const own = contextOfSession(currentView)
    return own && link.kind !== "workspace-missing" ? describeWorkingContext(own, liveWorld) : null
  }, [currentView, link.kind, liveWorld])
  const draftView = useMemo(() => (draft ? describeWorkingContext(draft, liveWorld) : null), [draft, liveWorld])

  const agentName = currentView ? agentDisplayName(currentView.provider) : "The agent"
  const workspaceName = workspaceNameOf(workspaceShown)
  const delivered = currentView?.focus ? currentView.focus.delivered : undefined
  const sessionChanges = useMemo(
    () => (currentView ? allChanges.filter((change) => change.sessionId === currentView.sessionId) : []),
    [allChanges, currentView]
  )

  /*
    The Context Pack (Hubble 1.5): what the on-screen session is given — built
    by the same recipe applyContext attaches with, so comparing its id with
    the one the runtime reports says whether the agent has it. With no
    session, the pack a new session here would start with.
  */
  const packWorkspaceId = currentView ? (link.kind === "workspace-missing" ? undefined : sessionWorkspaceId) : workspaceShown
  const packProjectId = currentView ? currentView.projectId : workspaceProject.project?.id
  const packProvider = currentView?.provider
  const packProject = useMemo(() => projectDescriptorFor(packProjectId, packProvider), [projectDescriptorFor, packProjectId, packProvider])
  const { pack: sessionPack, state: packState, change: packChange, brief } = useSessionContextPack({
    world: contextWorld,
    session: currentView,
    workspaceId: packWorkspaceId,
    events: session.events,
    handoffs: session.handoffs,
    changes: allChanges,
    draft,
    ...(packProject ? { project: packProject } : {}),
  })
  const sendContextUpdate = useMemo(() => {
    if (!currentView || !sessionWorkspaceId || packState !== "changed") return undefined
    const sessionId = currentView.sessionId
    const own = contextOfSession(currentView) ?? workspaceContext(sessionWorkspaceId)
    return () => void applyContext(sessionId, own)
  }, [applyContext, currentView, packState, sessionWorkspaceId])

  /* The workspace's brief (Hubble 1.5): live, and edited in place. */
  const briefWorkspace = workspaceShown ? world.workspaces.find((workspace) => workspace.id === workspaceShown) : undefined
  const saveBrief = useMemo(
    () =>
      briefWorkspace && onUpdateWorkspaceBrief
        ? (next: { description: string; focus: string }) => onUpdateWorkspaceBrief(briefWorkspace.id, next)
        : undefined,
    [briefWorkspace, onUpdateWorkspaceBrief]
  )
  const collectionName = useCallback(
    (collectionId: string) => collectionStore.collections.find((collection) => collection.id === collectionId)?.name,
    [collectionStore.collections]
  )

  /*
    What the on-screen agent has been doing, from the same records the
    stream above reads — its events, its approvals and what was applied for it.
    Built once here and drawn in two places: the context panel, and the
    header popover where that panel is not on screen.
  */
  /*
    What the person can do about the session's project work (Hubble 1.6):
    undo, review and checks — only in a live session on a runtime that holds
    its changes. A past session is read-only.
  */
  const sessionEvents = session.events
  const checkRunning = useMemo(() => checkRunningIn(sessionEvents), [sessionEvents])
  const latestGit = useMemo((): GitStatusCounts | undefined => readGitStatusCounts(latestGitCountsIn(sessionEvents)), [sessionEvents])
  const projectActions = useMemo((): ProjectWorkActions | undefined => {
    if (!currentView?.projectId || !workspaceProject.supported || !runtime.executable) return undefined
    const sessionId = currentView.sessionId
    const described = projectDescriptorFor(currentView.projectId, currentView.provider)
    const checks =
      described?.capabilities.includes("run_checks") && workspaceProject.inspection?.projectId === currentView.projectId
        ? workspaceProject.inspection.checks
        : []
    return {
      undo: async (changeId) => {
        const result = await runtime.client.send({ name: "undo_project_change", sessionId, changeId })
        await session.refresh()
        workspaceProject.refresh()
        return result.ok ? result.value : null
      },
      review: async (changeId) => {
        const result = await runtime.client.send({ name: "review_project_change", sessionId, changeId })
        return result.ok ? result.value : null
      },
      checks,
      runCheck: async (check) => {
        const result = await runtime.client.send({ name: "run_project_check", sessionId, check })
        await session.refresh()
        return result.ok
      },
      checking: checkRunning,
    }
  }, [currentView, workspaceProject, runtime.executable, runtime.client, projectDescriptorFor, session, checkRunning])

  const sessionProjectName = projectNameOf(currentView?.projectId)
  const {
    entries: activity,
    inspect: inspectActivity,
    waiting: activityWaiting,
  } = useSessionActivity({
    session: currentView,
    events: session.events,
    approvals: session.approvals,
    changes: sessionChanges,
    handoffs: session.handoffs,
    agentName,
    ...(workspaceName ? { workspaceName } : {}),
    ...(sessionProjectName ? { projectName: sessionProjectName } : {}),
    now,
    canUndo,
    collectionName,
    ...(projectActions ? { projectLive: true } : {}),
  })
  const viewActivityChange = useCallback(
    (changeId: string) => {
      const change = sessionChanges.find((candidate) => candidate.id === changeId)
      if (change) viewChange(change)
    },
    [sessionChanges, viewChange]
  )
  // The inspector's Undo says the outcome itself, in place; no notification on top.
  const undoActivityChange = useCallback(
    (changeId: string) => {
      const change = sessionChanges.find((candidate) => candidate.id === changeId)
      return change ? tryUndo(change) : false
    },
    [sessionChanges, tryUndo]
  )
  const currentProvider = currentView?.provider
  const startAnotherSession = useCallback(() => {
    if (currentProvider) setDefaultProvider(currentProvider)
    setNewSessionOpen(true)
  }, [currentProvider])

  /*
    Where the on-screen session's task stands (Stage 3) — working, needs you,
    done, what changed, checks — from the records the timeline just read.
  */
  const sessionApprovals = session.approvals
  const sessionHandoffs = session.handoffs
  const outcome = useMemo(
    () =>
      currentView
        ? taskOutcome({
            status: currentView.status,
            sessionId: currentView.sessionId,
            events: sessionEvents,
            entries: activity,
            approvals: sessionApprovals,
            handoffs: sessionHandoffs,
            agentName,
            ...(sessionProjectName ? { projectName: sessionProjectName } : {}),
          })
        : null,
    [currentView, sessionEvents, activity, sessionApprovals, sessionHandoffs, agentName, sessionProjectName]
  )

  /*
    Remembered for the workspace (where a returning person is shown it), and
    counted in the local loop log as the task moves: approvals asked, tasks
    finished or failed. Each milestone once per session and occurrence.
  */
  // What the task was given, as counts — never names or text. A string, so the effect below re-runs only when it changes.
  const outcomeContext = sessionPack
    ? contextSummary({
        sources: sessionPack.sources.filter((source) => source.status === "ready").length,
        files: sessionPack.files.length,
        brief: Boolean(sessionPack.workspace.description || sessionPack.workspace.focus),
        previousResult: Boolean(sessionPack.previousResult),
      }) || undefined
    : undefined
  // Before a new session: what its first task would be given (the draft's pack), said on the start screen.
  const startUsing =
    !currentView && sessionPack
      ? contextSummary({
          sources: sessionPack.sources.filter((source) => source.status === "ready").length,
          files: sessionPack.files.length,
          brief: Boolean(sessionPack.workspace.description || sessionPack.workspace.focus),
          previousResult: Boolean(sessionPack.previousResult),
        }) || undefined
      : undefined
  const outcomeSessionId = currentView?.sessionId
  const outcomeWorkspaceId = sessionWorkspaceId
  const outcomeProjectId = currentView?.projectId
  const checksAvailable = Boolean(projectActions && projectActions.checks.length > 0)
  useEffect(() => {
    if (!outcome || !outcomeSessionId || !outcomeWorkspaceId || !currentProvider) return
    const task = lastTaskOf({
      workspaceId: outcomeWorkspaceId,
      sessionId: outcomeSessionId,
      provider: currentProvider,
      ...(outcomeProjectId ? { projectId: outcomeProjectId } : {}),
      outcome,
      checksAvailable,
    })
    if (task) {
      rememberLastTask(task)
      // The project's history (Hubble 2.0): this task, with what it was given, counted.
      recordProjectTask(task, outcomeContext)
    }
  }, [outcome, outcomeSessionId, outcomeWorkspaceId, outcomeProjectId, currentProvider, checksAvailable, outcomeContext])
  useEffect(() => {
    if (!outcome || !outcomeSessionId || !currentProvider) return
    // Counted once per approval and once per task — however often this re-reads, and across reloads.
    if (outcome.approval) recordLoopMilestone("approval_requested", { provider: currentProvider, once: outcome.approval.approvalId })
    if (outcome.task && (outcome.state === "done" || outcome.state === "failed")) {
      recordLoopMilestone(outcome.state === "done" ? "task_completed" : "task_failed", {
        provider: currentProvider,
        once: `${outcomeSessionId}:${outcome.taskSequence}`,
      })
    }
  }, [outcome, outcomeSessionId, currentProvider])

  /* Brings the approval the agent is stopped on into view, with Deny — the safe default — focused. */
  const mainRef = useRef<HTMLElement | null>(null)
  const showApproval = useCallback((approvalId: string) => {
    const card = mainRef.current?.querySelector<HTMLElement>(`[data-approval-id="${approvalId.replace(/["\\]/g, "\\$&")}"]`)
    if (!card) return
    card.scrollIntoView({ block: "nearest" })
    card.querySelector<HTMLButtonElement>("[data-approval-deny]")?.focus({ preventScroll: true })
  }, [])


  /* ---------------- Agent history: this workspace's past sessions. */

  /*
    Scoped to the workspace on screen, and only that one: the runtime answers
    for this account and this workspace, and nothing here asks about another.
    Re-read when the live sessions change shape — one appears, ends or goes —
    which is when history can have changed; never on a timer.
  */
  const historyWorkspaceId = activeWorkspaceId
  const liveSessionIds = useMemo(() => new Set(sessions.sessions.map((entry) => entry.view.sessionId)), [sessions.sessions])
  const historyRefreshKey = useMemo(
    () => sessions.sessions.map((entry) => `${entry.view.sessionId}:${isTerminalSession(entry.view.status) ? 1 : 0}`).join(","),
    [sessions.sessions]
  )
  const history = useAgentHistory({
    client: runtime.client,
    workspaceId: historyWorkspaceId,
    // Only once the runtime has answered the handshake: a command sent before
    // it carries no runtime id, is refused as `runtime_disconnected`, and that
    // refusal makes the client forget the id the handshake is about to set.
    enabled: Boolean(runtime.status?.runtimeId),
    refreshKey: `${runtime.status?.runtimeId ?? ""}|${historyRefreshKey}`,
  })
  const [historySelection, setHistorySelection] = useState<AgentHistorySession | null>(null)
  // A live session on screen wins; a history session of another workspace is never shown.
  const shownHistory = !current && historySelection?.workspaceId === historyWorkspaceId ? historySelection : null
  const historySession = useHistorySession({
    client: runtime.client,
    workspaceId: shownHistory?.workspaceId,
    sessionId: shownHistory?.sessionId ?? null,
  })
  const historyDetail = historySession.state.kind === "ready" ? historySession.state.detail : null
  const historyAgentName = shownHistory ? agentDisplayName(shownHistory.provider) : "The agent"
  const historyWorkspaceName = workspaceNameOf(shownHistory?.workspaceId)
  const historyProjectName = projectNameOf(historyDetail?.session.projectId)
  /*
    The same undo rule as a live change: offered only while the workspace
    still holds exactly what the change left. An old change is not undoable
    because it is old, and not undoable at all without both snapshots.
  */
  const canUndoHistory = useCallback(
    (change: AppliedWorkspaceChange) =>
      change.ok && !change.undone && Boolean(change.before && change.after) && collectionsMatch(collectionStore.collections, change.workspaceId, change.after!),
    [collectionStore.collections]
  )
  const { entries: historyEntries, inspect: inspectHistory, history: reconstructed } = useHistorySessionActivity({
    detail: historyDetail,
    agentName: historyAgentName,
    ...(historyWorkspaceName ? { workspaceName: historyWorkspaceName } : {}),
    ...(historyProjectName ? { projectName: historyProjectName } : {}),
    now,
    canUndo: canUndoHistory,
    collectionName,
  })
  /* What the past session was given (Hubble 1.5), from the records history kept. */
  const historyContext = useMemo(
    () =>
      reconstructed
        ? contextProvenanceOf({
            session: reconstructed.session,
            events: reconstructed.events,
            handoffs: reconstructed.handoffs,
            at: Number.MAX_SAFE_INTEGER,
            ...(historyWorkspaceName ? { workspaceName: historyWorkspaceName } : {}),
            collectionName,
            projectName: (projectId: string) => projectNameOf(projectId),
            agentName: agentDisplayName,
          })
        : undefined,
    [reconstructed, historyWorkspaceName, collectionName, projectNameOf]
  )
  const { recordUndo: recordHistoryUndo } = historySession
  const undoHistoryChange = useCallback(
    (changeId: string): boolean => {
      const change = reconstructed?.changes.find((candidate) => candidate.id === changeId)
      if (!change?.ok || change.undone || !change.before || !change.after) return false
      // The workspace is put back exactly, or not at all…
      if (!collectionStore.restoreCollections(change.workspaceId, change.before, change.after)) return false
      // …and only then is the undo told — to this page's record, if it
      // applied the change, and to history, as a new fact after the change.
      markWorkspaceChangeUndone(change.id)
      void recordHistoryUndo(change.id)
      return true
    },
    [reconstructed, collectionStore, recordHistoryUndo]
  )
  const viewHistoryChange = useCallback(
    (changeId: string) => {
      const change = reconstructed?.changes.find((candidate) => candidate.id === changeId)
      if (change) viewChange(change)
    },
    [reconstructed, viewChange]
  )
  const selectHistorySession = useCallback((entry: AgentHistorySession) => {
    setRequestedSessionId(null)
    setHistorySelection(entry)
  }, [])
  const selectLiveSession = useCallback((sessionId: string) => {
    setHistorySelection(null)
    setRequestedSessionId(sessionId)
  }, [])

  /*
    Arriving to open a particular session (the workspace’s "Open" on its last
    task): live if this runtime holds it, else from agent history, else the
    start screen, which says where the work was left.
  */
  useEffect(() => {
    if (!openSessionId) return
    if (runtime.loading || (runtime.executable && !sessions.listed)) return
    /*
      Synchronizing with an external input — a request handed over by the
      shell — once, after the sessions it may name are known; as the
      workspace's requests above.
    */
    /* eslint-disable react-hooks/set-state-in-effect */
    if (sessions.sessions.some((entry) => entry.view.sessionId === openSessionId)) {
      selectLiveSession(openSessionId)
      onOpenSessionConsumed?.()
      return
    }
    if (history.state.kind === "ready") {
      const listed = history.state.sessions.find((entry) => entry.sessionId === openSessionId)
      if (listed) selectHistorySession(listed)
      onOpenSessionConsumed?.()
      return
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // Still being asked: wait. Anything else (no history here, a refusal) — the start screen says where it was left.
    if (runtime.executable && (history.state.kind === "loading" || history.state.kind === "idle")) return
    onOpenSessionConsumed?.()
  }, [openSessionId, runtime.loading, runtime.executable, sessions.listed, sessions.sessions, history.state, selectLiveSession, selectHistorySession, onOpenSessionConsumed])

  /* ---------------- Explicit handoff (Hubble 1.4): "Continue with…". */

  /*
    The dialog's source, and the copy of its workspace the preview and the
    confirmation both carry — taken once, when the person opens it, so the
    runtime fingerprints exactly what they read.
  */
  const [handoffSource, setHandoffSource] = useState<{
    key: number
    sessionId: string
    provider: AgentProviderId
    title?: string
    statusLabel: string
    workspaceId: string
    projectId?: string
    transport: ReturnType<typeof runtimeHandoffTransport>
    /** "Switch agent → Gemini" (Hubble 2.0): the preview opens already aimed at that agent. */
    initialProvider?: AgentProviderId
  } | null>(null)
  const canContinue = Boolean(currentView && runtime.executable && sessionWorkspaceId && canHandOffFrom(currentView.status))
  const continueWith = useCallback((initialProvider?: AgentProviderId) => {
    if (!currentView || !sessionWorkspaceId) return
    setHandoffSource({
      ...(initialProvider ? { initialProvider } : {}),
      key: Date.now(),
      sessionId: currentView.sessionId,
      provider: currentView.provider,
      ...(currentView.title ? { title: currentView.title } : {}),
      statusLabel: SESSION_STATUS_LABEL[currentView.status],
      workspaceId: sessionWorkspaceId,
      ...(currentView.projectId ? { projectId: currentView.projectId } : {}),
      transport: runtimeHandoffTransport(runtime.client, currentView.sessionId, sessionContext.snapshotFor(sessionWorkspaceId, { selection: contextOfSession(currentView) })),
    })
  }, [currentView, runtime.client, sessionContext, sessionWorkspaceId])
  const handoffAgents = useMemo(
    () =>
      handoffAgentOptions(platform, (provider) => {
        const status = startableProviders.find((entry) => entry.provider === provider)
        return Boolean(status && canCreateSession(status))
      }),
    [platform, startableProviders]
  )
  /** Projects the new session may use with that agent: ones it is authorized for, within what it was approved for. */
  const handoffProjectsFor = useCallback(
    (provider: AgentProviderId) => {
      const agent = platform.identity(provider)
      const options = projects.projects
        .filter((project) => project.providers.includes(provider) && Boolean(agent && grantWithinApproval(agent, project.permissions.scopes)))
        .map((project) => ({ id: project.id, name: project.name }))
      const sourceProject = handoffSource?.projectId
      return { options, ...(sourceProject && options.some((option) => option.id === sourceProject) ? { defaultId: sourceProject } : {}) }
    },
    [platform, projects.projects, handoffSource?.projectId]
  )
  /*
    The Context Pack the handoff would pass (Hubble 1.5): the source's focus
    as the runtime holds it, in the workspace the preview names, with the
    modes the person kept — the same recipe the runtime sends it by.
  */
  const handoffSourceId = handoffSource?.sessionId
  const handoffPackFor = useCallback(
    (preview: RuntimeHandoffPreview, include: HandoffInclude, projectId?: string) => {
      const focus = sessions.sessions.find((entry) => entry.view.sessionId === handoffSourceId)?.view.focus
      // The project as the target agent will be told it (Hubble 1.6) — its own capabilities, as the runtime describes it.
      const project = include.workspace ? projectDescriptorFor(projectId, preview.targetProvider) : undefined
      return handoffContextPack({
        world: contextWorld,
        workspaceId: preview.workspaceId,
        ...(focus ? { focus: { tabIds: focus.tabIds, collectionIds: focus.collectionIds } } : {}),
        context: selectHandoffContext(preview.context, include),
        ...(project ? { project } : {}),
      })
    },
    [contextWorld, handoffSourceId, sessions.sessions, projectDescriptorFor]
  )
  const handleHandoffStarted = useCallback(
    async (result: HandoffStartResult) => {
      const source = handoffSource
      setHandoffSource(null)
      const target = result.session
      if (!target || !source) return
      recordLoopMilestone("handoff_started", { provider: target.provider })
      recordLoopMilestone("handoff_completed", { provider: target.provider })
      // Same project, another worker: part of the project's own history.
      if (target.provider !== source.provider) {
        recordLoopMilestone("agent_switched", { provider: target.provider })
        recordProjectEvent({ workspaceId: source.workspaceId, kind: "agent_switched", provider: target.provider, fromProvider: source.provider, sessionId: target.sessionId })
      }
      platform.recordSession(target.provider, target.sessionId, source.workspaceId)
      await sessions.refresh()
      setHistorySelection(null)
      setRequestedSessionId(target.sessionId)
      toast(`${agentDisplayName(target.provider)} received the handoff`, {
        description: `Continuing ${agentDisplayName(source.provider)}'s work${workspaceNameOf(source.workspaceId) ? ` in ${workspaceNameOf(source.workspaceId)}` : ""}`,
      })
    },
    [handoffSource, platform, sessions, workspaceNameOf]
  )
  /*
    The session on the other end of a handoff: live, if this runtime holds it;
    otherwise from agent history — always of this workspace, because a
    handoff never leaves one.
  */
  const openHandoffSession = useCallback(
    (sessionId: string, provider: AgentProviderId) => {
      if (sessions.sessions.some((entry) => entry.view.sessionId === sessionId)) {
        setHistorySelection(null)
        setRequestedSessionId(sessionId)
        return
      }
      const workspaceId = sessionWorkspaceId ?? historySelection?.workspaceId ?? activeWorkspaceId
      if (!workspaceId) return
      const listed = history.state.kind === "ready" ? history.state.sessions.find((entry) => entry.sessionId === sessionId) : undefined
      setRequestedSessionId(null)
      setHistorySelection(listed ?? { sessionId, workspaceId, provider, status: "disconnected", startedAt: 0, lastActivityAt: 0 })
    },
    [sessions.sessions, sessionWorkspaceId, historySelection?.workspaceId, activeWorkspaceId, history.state]
  )

  /* The workspace's project (Hubble 1.6), in the context panel — and how it is attached. */
  const [attachOpen, setAttachOpen] = useState(false)
  const attachTarget = projectWorkspace && link.kind !== "workspace-missing" ? projectWorkspace : undefined
  const canAttach = Boolean(attachTarget && onAttachWorkspaceProject && workspaceProject.supported)
  // A session on a project its workspace does not name keeps the plain line it always had.
  const sessionOnOtherProject = Boolean(currentView?.projectId && currentView.projectId !== workspaceProject.project?.id)
  const projectSection =
    attachTarget && !sessionOnOtherProject ? (
      <WorkspaceProjectSection
        state={workspaceProject.state}
        {...(workspaceProject.project ? { project: workspaceProject.project } : {})}
        inspection={workspaceProject.inspection}
        capabilities={packProject?.capabilities ?? []}
        {...(latestGit ? { git: latestGit } : {})}
        agentChangedFiles={sessionProjectFiles.length}
        {...(projectActions && projectActions.checks.length > 0 ? { checks: projectActions } : {})}
        {...(canAttach ? { onAttach: () => setAttachOpen(true) } : {})}
        {...(canAttach && workspaceProject.attached ? { onDetach: () => onAttachWorkspaceProject!(attachTarget.id, null) } : {})}
        onRetry={workspaceProject.refresh}
      />
    ) : undefined
  /** What New session says about a workspace's project, and whether it may start there. */
  const workspaceProjectFor = useCallback(
    (workspaceId: string) => {
      const projectId = workspaceProjectId(world.workspaces.find((workspace) => workspace.id === workspaceId))
      const project = projectId ? projects.projects.find((candidate) => candidate.id === projectId) : undefined
      if (!projectId || !project) return undefined
      // Only the workspace on screen has been inspected; the runtime checks any other as the session starts.
      if (projectId !== workspaceProject.project?.id) return { projectId, ready: true, notice: `${project.name} · Hubble checks it as the session starts` }
      const copy = PROJECT_STATE_COPY[workspaceProject.state]
      const ready = workspaceProject.state === "connected"
      return { projectId, ready, notice: ready ? `${project.name} · ${copy.title}` : `${project.name} · ${copy.title}. ${copy.detail}` }
    },
    [world.workspaces, projects.projects, workspaceProject.project?.id, workspaceProject.state]
  )

  const headerProject = currentView ? projectNameOf(currentView.projectId) : shownHistory ? undefined : workspaceProject.project?.name

  /* The start screen's project line (Stage 3): what an agent here would work on, and whether it can now. */
  const startProject = useMemo(() => {
    const project = workspaceProject.project
    if (!project) return undefined
    const inspection = workspaceProject.inspection
    const detail = inspection ? projectKindLine({ ...(inspection.type ? { type: inspection.type } : {}), ...(inspection.repository ? { repository: inspection.repository } : {}) }) : undefined
    const ready = workspaceProject.state === "connected"
    const copy = PROJECT_STATE_COPY[workspaceProject.state]
    return { name: project.name, ...(detail ? { detail } : {}), ready, ...(ready ? {} : { notice: `${copy.title}. ${copy.detail}` }) }
  }, [workspaceProject.project, workspaceProject.inspection, workspaceProject.state])

  /*
    Where the developer left off here (Stage 3): the workspace's last task,
    with its session's state now when this runtime still holds it, and a way
    back to it — live, or from agent history.
  */
  const lastTask = useLastTask(workspaceShown)
  const leftOff = useMemo(() => {
    if (!lastTask) return undefined
    const live = listedSessions.find((entry) => entry.view.sessionId === lastTask.sessionId)?.view
    const listed = history.state.kind === "ready" ? history.state.sessions.find((entry) => entry.sessionId === lastTask.sessionId) : undefined
    const liveLabel =
      live && (live.status === "running" || live.status === "connecting")
        ? "Working"
        : live && (live.status === "waiting_for_approval" || live.status === "waiting_for_input")
          ? "Needs you"
          : live && lastTask.state !== "done"
            ? SESSION_STATUS_LABEL[live.status]
            : undefined
    const onOpen = live ? () => selectLiveSession(live.sessionId) : listed ? () => selectHistorySession(listed) : undefined
    return { task: lastTask, ...(liveLabel ? { live: liveLabel } : {}), ...(onOpen ? { onOpen } : {}) }
  }, [lastTask, listedSessions, history.state, selectLiveSession, selectHistorySession])

  const activityTimeline = currentView ? (
    <AgentActivity
      entries={activity}
      provider={currentView.provider}
      agentName={agentName}
      state={SESSION_VISUAL_STATE[currentView.status]}
      statusLabel={SESSION_STATUS_LABEL[currentView.status]}
      now={now}
      inspect={inspectActivity}
      onUndo={undoActivityChange}
      {...(projectActions ? { project: projectActions } : {})}
      {...(onViewWorkspace ? { onViewChange: viewActivityChange } : {})}
      {...(runtime.executable ? { onNewSession: startAnotherSession } : {})}
      {...(canContinue ? { onContinue: () => continueWith() } : {})}
      onOpenSession={openHandoffSession}
    />
  ) : null

  const contextActions = useMemo((): WorkingContextActions => {
    if (!currentView || !sessionWorkspaceId || link.kind === "workspace-missing" || link.kind === "none") return {}
    const sessionId = currentView.sessionId
    const own = contextOfSession(currentView) ?? workspaceContext(sessionWorkspaceId)
    return {
      onRemove: (entry: { tabId: string } | { collectionId: string }) => void applyContext(sessionId, removeFromContext(own, entry)),
      onUseWholeWorkspace: () => void applyContext(sessionId, workspaceContext(sessionWorkspaceId)),
      onChoose: () => setPickerFor({ sessionId, key: Date.now() }),
    }
  }, [applyContext, currentView, link.kind, sessionWorkspaceId])

  const draftActions = useMemo((): WorkingContextActions => {
    if (!draft) return {}
    return {
      onRemove: (entry: { tabId: string } | { collectionId: string }) => setDraft(removeFromContext(draft, entry)),
      onUseWholeWorkspace: () => setDraft(null),
      onChoose: () => setPickerFor({ sessionId: null, key: Date.now() }),
    }
  }, [draft])

  const pickerWorkspaceId = pickerFor
    ? pickerFor.sessionId
      ? (sessionWorkspaceId ?? "")
      : (draft?.workspaceId ?? activeWorkspaceId ?? "")
    : ""
  const pickerWorkspace = world.workspaces.find((workspace) => workspace.id === pickerWorkspaceId) ?? null
  const pickerInitial: WorkingContext = pickerFor?.sessionId
    ? (currentView ? contextOfSession(currentView) : null) ?? workspaceContext(pickerWorkspaceId)
    : draft ?? workspaceContext(pickerWorkspaceId)

  const errorPresentation = session.error
    ? { ...RUNTIME_ERROR_PRESENTATION[session.error], title: runtimeErrorTitle(session.error, agentName) }
    : null

  /*
    While it is open, the Command Centre adds its own commands to the shell's
    palette: change what the open session is pointed at, go back to the whole
    workspace, or start a session where the user is.
  */
  const paletteHost = useCommandPaletteHost()
  const paletteCommands: Command[] = [
    {
      id: "cc-change-context",
      label: currentView ? `Change ${agentName}'s context` : "Change agent context",
      hint: workspaceName ? `Tabs and collections in ${workspaceName}` : undefined,
      group: "Agents",
      icon: Bot,
      disabled: !contextActions.onChoose,
      keywords: ["context", "attach", "tabs", "collection"],
      onSelect: () => contextActions.onChoose?.(),
    },
    {
      id: "cc-whole-workspace",
      label: "Use the whole workspace as context",
      group: "Agents",
      icon: Bot,
      disabled: !contextActions.onUseWholeWorkspace || sessionContextView?.scope === "workspace",
      keywords: ["clear context", "reset context"],
      onSelect: () => contextActions.onUseWholeWorkspace?.(),
    },
    {
      id: "cc-new-session",
      label: workspaceName ? `New agent session in ${workspaceName}` : "New agent session",
      group: "Agents",
      icon: Bot,
      disabled: !runtime.executable,
      onSelect: () => setNewSessionOpen(true),
    },
  ]
  useEffect(() => {
    paletteHost?.contribute("command-centre", paletteCommands)
  })
  useEffect(() => () => paletteHost?.contribute("command-centre", null), [paletteHost])

  /* ---------------- The agents a new session could start with. */

  const startableAgents = useMemo(
    () =>
      platform.roster.agents.flatMap((agent): StartableAgent[] => {
        const spec = platformProvider(agent.provider)
        if (!spec?.chat) return []
        // The same gate the start dialog applies: connected and signed in in
        // a way Hubble may use, sessions offered, and the runtime can start one.
        const status = startableProviders.find((provider) => provider.provider === agent.provider)
        const prerequisite = platform.prerequisiteFor(agent.provider)
        const ready = prerequisite.ok && Boolean(status && canCreateSession(status))
        const name = agentDisplayName(agent.provider)
        if (ready) return [{ provider: agent.provider, name, ready }]
        // Never a dead end: what is wrong, and — when connecting or signing in
        // fixes it — the action that does, through the existing Connect flow.
        if (prerequisite.ok) return [{ provider: agent.provider, name, ready, reason: "Unavailable here" }]
        const action = prerequisite.action
          ? prerequisite.phase
            ? recoveryLabel(prerequisite.phase, prerequisite.action)
            : "Connect"
          : undefined
        return [{ provider: agent.provider, name, ready, reason: prerequisite.reason, ...(action ? { action } : {}) }]
      }),
    [platform, startableProviders]
  )

  return (
    <div className="flex h-screen max-h-screen min-h-0 min-w-0 flex-1 flex-col">
      {/*
        Where you are, and whether agents can run here: the workspace on the
        left, the runtime on the right. Quiet when everything is fine.
      */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {(selected || shownHistory) && (
          <IconButton
            aria-label="All sessions"
            className="-ml-1.5 md:hidden"
            onClick={() => {
              setRequestedSessionId(null)
              setHistorySelection(null)
            }}
          >
            <ChevronLeft />
          </IconButton>
        )}
        <span className="text-h2 text-foreground">Command Centre</span>
        {workspaceName && (
          <>
            <span aria-hidden className="text-tertiary">
              /
            </span>
            <span className="min-w-0 truncate text-body text-muted-foreground">{workspaceName}</span>
          </>
        )}
        {/* The project the work is on (Stage 3): the session's, else the workspace's. */}
        {headerProject && (
          <span className="flex min-w-0 shrink items-center gap-1 text-body-sm text-tertiary max-sm:hidden" data-header-project>
            <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{headerProject}</span>
          </span>
        )}

        {!runtime.loading && (
          <div role="status" className="ml-auto flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                banner.tone === "good" ? "bg-success" : banner.tone === "bad" ? "bg-destructive" : banner.tone === "live" ? "bg-foreground" : "bg-tertiary"
              )}
            />
            <span className="shrink-0 text-body-sm text-muted-foreground">{badge}</span>
            {!runtime.executable && (
              <span className="hidden min-w-0 truncate text-body-sm text-tertiary lg:inline">· {banner.detail}</span>
            )}
            {banner.reconnectable && (
              <Button type="button" size="xs" variant="outline" onClick={() => void runtime.refresh()}>
                <RotateCw />
                Reconnect
              </Button>
            )}
          </div>
        )}

        <IconButton aria-label="Close command centre" className={cn("shrink-0", runtime.loading && "ml-auto")} onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1">
        <SessionList
          className={selected || shownHistory ? "max-md:hidden" : "max-md:w-full max-md:border-r-0"}
          sessions={listedSessions}
          selectedSessionId={selectedSessionId}
          projectNameOf={projectNameOf}
          workspaceNameOf={workspaceNameOf}
          onSelect={selectLiveSession}
          onNewSession={() => setNewSessionOpen(true)}
          canCreate={runtime.executable}
          now={now}
          history={
            <AgentHistoryList
              // A runtime that cannot be reached cannot be asked — never "no
              // activity", and never "doesn't keep history" either. (Across a
              // runtime restart the hook keeps the list it read while it re-reads.)
              state={!runtime.loading && !runtime.status && history.state.kind !== "ready" ? { kind: "disconnected" } : history.state}
              selectedSessionId={shownHistory?.sessionId ?? null}
              onSelect={selectHistorySession}
              {...(workspaceNameOf(historyWorkspaceId) ? { workspaceName: workspaceNameOf(historyWorkspaceId) } : {})}
              now={now}
              hiddenSessionIds={liveSessionIds}
              onLoadMore={history.loadMore}
              onRetry={history.retry}
            />
          }
        >
          <AgentRoster
            platform={platform}
            sessions={listedSessions}
            selectedSessionId={selectedSessionId}
            selectedEvents={session.events}
            workspaceNameOf={workspaceNameOf}
            onConnect={openConnect}
            onOpenAgent={(agent, latest) => {
              // The same gate as Start: a phase that proves nothing does not send the person to Connect.
              const startable = platform.prerequisiteFor(agent.provider).ok
              if (latest) selectLiveSession(latest.view.sessionId)
              else if (startable) {
                setDefaultProvider(agent.provider)
                setNewSessionOpen(true)
              }
              // Anything else is explained where it is decided: in Connect Agent.
              else openConnect(agent.provider)
            }}
          />
        </SessionList>

        <main ref={mainRef} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !selected && !shownHistory && "max-md:hidden")}>
          {shownHistory && !current ? (
            <HistorySessionView
              session={shownHistory}
              state={historySession.state}
              {...(historyWorkspaceName ? { workspaceName: historyWorkspaceName } : {})}
              now={now}
              onClose={() => setHistorySelection(null)}
              onRetry={historySession.retry}
              {...(historyContext ? { context: historyContext } : {})}
            >
              <AgentActivity
                entries={historyEntries}
                provider={shownHistory.provider}
                agentName={historyAgentName}
                state={SESSION_VISUAL_STATE[historySessionStatus(historyDetail?.session.status ?? shownHistory.status)]}
                statusLabel={SESSION_STATUS_LABEL[historySessionStatus(historyDetail?.session.status ?? shownHistory.status)]}
                now={now}
                inspect={inspectHistory}
                onUndo={undoHistoryChange}
                {...(onViewWorkspace ? { onViewChange: viewHistoryChange } : {})}
                {...(runtime.executable ? { onNewSession: () => setNewSessionOpen(true) } : {})}
                onOpenSession={openHandoffSession}
              />
            </HistorySessionView>
          ) : current && currentView ? (
            <>
              <SessionHeader
                session={current}
                {...(projectNameOf(currentView.projectId) ? { projectName: projectNameOf(currentView.projectId) } : {})}
                {...(workspaceName ? { workspaceName } : {})}
                link={link}
                {...(currentView.context ? { contextFreshness: sessionContext.freshnessOf(currentView.context, currentView.sessionId) } : {})}
                contextControl={
                  <WorkingContextChip
                    view={sessionContextView}
                    link={link}
                    agentName={agentName}
                    {...(delivered !== undefined ? { delivered } : {})}
                    busy={contextBusy}
                    pack={sessionPack}
                    {...(packState ? { packState } : {})}
                    {...(packChange ? { packChange } : {})}
                    {...(sendContextUpdate ? { onSendUpdate: sendContextUpdate } : {})}
                    {...contextActions}
                  />
                }
                contextPanelOpen={contextPanelOpen}
                onToggleContextPanel={() => setContextPanelOpen((open) => !open)}
                onDispose={() => void sessions.disposeSession(currentView.sessionId)}
                activityControl={
                  <ActivityPopover waiting={activityWaiting} className={contextPanelOpen ? "xl:hidden" : undefined}>
                    {activityTimeline}
                  </ActivityPopover>
                }
                {...(canContinue
                  ? {
                      agentControl: (
                        <AgentSwitcher
                          current={currentView.provider}
                          agents={handoffAgents}
                          {...(workspaceName ? { projectName: workspaceName } : {})}
                          onSwitch={(provider) => continueWith(provider)}
                          onConnect={openConnect}
                        />
                      ),
                    }
                  : {})}
              />

              <EventStream
                events={session.events}
                {...(currentView.context?.planOutcomes ? { planOutcomes: currentView.context.planOutcomes } : {})}
                changes={sessionChanges}
                {...(workspaceName ? { workspaceName } : {})}
                {...(onViewWorkspace ? { onViewChange: viewChange } : {})}
                onUndoChange={undoChange}
                canUndoChange={canUndo}
              >
                {session.approvals.map((approval) => (
                  <ApprovalPrompt
                    key={approval.approvalId}
                    approval={approval}
                    {...(projectNameOf(approval.projectId) ? { projectName: projectNameOf(approval.projectId) } : {})}
                    {...(approval.workspaceId && workspaceNameOf(approval.workspaceId)
                      ? { workspaceName: workspaceNameOf(approval.workspaceId) }
                      : {})}
                    pending={session.pending}
                    now={now}
                    {...(outcome?.task ? { task: outcome.task } : {})}
                    onRespond={(approvalId, decision) => {
                      recordLoopMilestone("approval_answered", { provider: approval.provider, approved: decision === "granted" })
                      void session.respondToApproval(approvalId, decision)
                    }}
                  />
                ))}

                {session.loading && session.events.length === 0 && (
                  <li className="py-2 text-body-sm text-tertiary">Loading the session…</li>
                )}

                {errorPresentation && (
                  <li role="alert" className="my-2 rounded-md border border-destructive/40 bg-surface px-3 py-2">
                    <p className="text-body-sm text-foreground">{errorPresentation.title}</p>
                    <p className="mt-0.5 text-body-sm text-tertiary">{errorPresentation.action}</p>
                    {errorPresentation.reconnect && (
                      <Button type="button" size="xs" variant="outline" className="mt-2" onClick={() => void runtime.refresh()}>
                        Reconnect
                      </Button>
                    )}
                  </li>
                )}

                {contextError && (
                  <li role="alert" className="my-2 rounded-md border border-warning/40 bg-surface px-3 py-2">
                    <p className="text-body-sm text-foreground">Context not changed</p>
                    <p className="mt-0.5 text-body-sm text-tertiary">{contextError}</p>
                  </li>
                )}
              </EventStream>

              {outcome && (
                <TaskStatus
                  outcome={outcome}
                  provider={currentView.provider}
                  {...(projectActions ? { project: projectActions } : {})}
                  onShowApproval={() => outcome.approval && showApproval(outcome.approval.approvalId)}
                  {...(onViewWorkspace ? { onViewWorkspaceChange: viewActivityChange } : {})}
                  {...(canContinue ? { onContinue: () => continueWith() } : {})}
                  {...(runtime.executable ? { onNewSession: startAnotherSession } : {})}
                />
              )}

              <Composer
                key={`${currentView.sessionId}:${composerSeed?.sessionId === currentView.sessionId ? composerSeed.key : ""}`}
                status={currentView.status}
                pending={session.pending}
                cancellable={currentView.cancellable}
                {...(composerSeed?.sessionId === currentView.sessionId ? { initialText: composerSeed.text } : {})}
                agentName={agentName}
                {...(workspaceName && link.kind !== "workspace-missing" && link.kind !== "none" ? { workspaceName } : {})}
                {...(projectNameOf(currentView.projectId) ? { projectName: projectNameOf(currentView.projectId) } : {})}
                contextControl={
                  <WorkingContextChip
                    view={sessionContextView}
                    link={link}
                    agentName={agentName}
                    {...(delivered !== undefined ? { delivered } : {})}
                    busy={contextBusy}
                    pack={sessionPack}
                    {...(packState ? { packState } : {})}
                    {...(sendContextUpdate ? { onSendUpdate: sendContextUpdate } : {})}
                    align="start"
                    {...contextActions}
                  />
                }
                onCancel={() => void session.cancelRun()}
                // Attached context rides with the next message on its own: the
                // runtime holds it and sends it once. Only the words go here.
                onSend={(text) => {
                  recordLoopMilestone("task_submitted", { provider: currentView.provider })
                  void session.sendMessage(text)
                }}
              />
            </>
          ) : (
            <CommandCentreEmptyState
              executable={runtime.executable}
              loading={runtime.loading}
              {...(workspaceName ? { workspaceName } : {})}
              {...(startProject ? { project: startProject } : {})}
              {...(leftOff ? { lastTask: leftOff } : {})}
              {...(canAttach ? { onConnectProject: () => setAttachOpen(true) } : {})}
              now={now}
              agents={startableAgents}
              defaultProvider={defaultProvider}
              initialText={draftText}
              {...(startUsing ? { using: startUsing } : {})}
              contextControl={
                draftView ? (
                  <WorkingContextChip view={draftView} link={link} agentName="The agent" align="start" pack={sessionPack} {...draftActions} />
                ) : undefined
              }
              onStart={(text, provider) => {
                setFirstMessage(text || undefined)
                setDefaultProvider(provider)
                setNewSessionOpen(true)
              }}
              onConnect={openConnect}
              onNewSession={() => setNewSessionOpen(true)}
            />
          )}
        </main>

        {/* A past session is told whole in its own pane; this panel describes a live one. */}
        {contextPanelOpen && !shownHistory && (
          <ContextPanel
            session={currentView}
            {...(workspaceName ? { workspaceName } : {})}
            link={link}
            context={currentView ? sessionContextView : draftView}
            {...(delivered !== undefined ? { delivered } : {})}
            agentName={agentName}
            busy={contextBusy}
            changes={sessionChanges}
            {...(onViewWorkspace ? { onViewChange: viewChange } : {})}
            {...(currentView && projectNameOf(currentView.projectId) ? { projectName: projectNameOf(currentView.projectId) } : {})}
            activity={activityTimeline}
            {...(currentView ? contextActions : draftActions)}
            pack={sessionPack}
            {...(packState ? { packState } : {})}
            {...(packChange ? { packChange } : {})}
            {...(sendContextUpdate ? { onSendUpdate: sendContextUpdate } : {})}
            {...(brief && link.kind !== "workspace-missing" ? { brief } : {})}
            {...(saveBrief ? { onSaveBrief: saveBrief } : {})}
            {...(projectSection ? { project: projectSection } : {})}
          />
        )}
      </div>

      {attachOpen && attachTarget && (
        <AttachProjectDialog
          open
          onOpenChange={setAttachOpen}
          workspaceName={attachTarget.name}
          projects={projects.projects}
          {...(workspaceProject.project ? { currentProjectId: workspaceProject.project.id } : {})}
          agents={startableProviders.filter((provider) => canCreateSession(provider)).map((provider) => provider.provider)}
          scopesFor={projectScopesFor}
          onAddProject={projects.addProject}
          {...(pickFolder ? { pickFolder } : {})}
          inspect={(projectId) => workspaceProject.inspect(projectId)}
          onAttach={(projectId) => onAttachWorkspaceProject?.(attachTarget.id, projectId)}
        />
      )}

      <NewSessionDialog
        // Remounted per opening so it starts from the agent it was opened for.
        // The `new-session:` prefix keeps this distinct from the connect dialog,
        // which is a sibling and would otherwise share the key `false-` when both are shut.
        key={`new-session:${newSessionOpen}-${resume?.provider ?? defaultProvider ?? ""}`}
        open={newSessionOpen}
        onOpenChange={(next) => {
          setNewSessionOpen(next)
          if (next) return
          // Closed by the person: what they were starting is let go of too.
          setFirstMessage(undefined)
          setResume(null)
        }}
        status={runtime.status}
        providers={startableProviders}
        projects={projects.projects}
        onAddProject={projects.addProject}
        workspaceProject={workspaceProjectFor}
        {...(remoteEnabled
          ? {
              remote: {
                projects: remoteProjects.projects,
                loading: remoteProjects.loading,
                unavailable: remoteProjects.unavailable,
                failure: remoteProjects.failure,
                creating: remoteProjects.creating,
                create: remoteProjects.create,
              },
            }
          : {})}
        connectionFor={connections.forProvider}
        onCreate={(input) => void handleCreate(input)}
        {...(onOpenConnectors || pickFolder ? { onConnectProvider: signInFor } : {})}
        creating={creating}
        now={now}
        {...(createError ? { error: runtimeErrorTitle(createError.code, agentDisplayName(createError.provider), { starting: true }) } : {})}
        workspaces={workspaceChoices}
        {...((resume?.workspaceId ?? draft?.workspaceId ?? activeWorkspaceId)
          ? { defaultWorkspaceId: resume?.workspaceId ?? draft?.workspaceId ?? activeWorkspaceId }
          : {})}
        {...(resume?.title ? { defaultTitle: resume.title } : {})}
        {...((resume?.provider ?? defaultProvider) ? { defaultProvider: resume?.provider ?? defaultProvider } : {})}
        contextSummaryFor={(workspaceId) =>
          draftView && draft?.workspaceId === workspaceId && draftView.scope !== "workspace" ? summarizeWorkingContext(draftView) : undefined
        }
        {...(firstMessage ? { firstMessage } : {})}
        connectionBlocker={(provider) => {
          const prerequisite = platform.prerequisiteFor(provider)
          if (prerequisite.ok) return undefined
          const name = agentDisplayName(provider)
          // Nothing to connect or sign in to fixes this one — signed in or not.
          // The exact reason, and no action that would pretend otherwise.
          const sessions = platform.sessionsFor(provider)
          if (!sessions.available) {
            return { label: "Sessions unavailable", sentence: sessions.reason, detail: sessions.reason }
          }
          // Not connected yet: the whole flow, from the start.
          if (!platform.identity(provider)) {
            return { label: prerequisite.reason, sentence: `${name} isn't connected yet.`, action: "Connect" }
          }
          return {
            label: prerequisite.reason,
            sentence: prerequisite.phase ? platform.sentenceOf(provider) : prerequisite.reason,
            ...(prerequisite.action && prerequisite.phase
              ? { action: recoveryLabel(prerequisite.phase, prerequisite.action) }
              : {}),
          }
        }}
        onConnectAgent={(provider, intent) => recoverFromNewSession(provider, intent)}
        {...(pickFolder ? { pickFolder } : {})}
        projectScopesFor={projectScopesFor}
      />

      <ConnectAgentDialog
        // Remounted per opening so it starts from the provider it was opened for.
        // The `connect:` prefix keeps this distinct from the new-session dialog,
        // which is a sibling and would otherwise share the key `false-` when both are shut.
        key={`connect:${connectOpen}-${connectProvider ?? ""}`}
        open={connectOpen}
        onOpenChange={(next) => {
          setConnectOpen(next)
          if (next) return
          // A sign-in may have changed what the runtime reports; ask again.
          void runtime.refresh()
          // Back to the session they were starting, with what they chose.
          returnToNewSession()
        }}
        platform={platform}
        initialProvider={connectProvider}
        apiKeys={connections}
        {...(onOpenConnectors ? { onOpenSettings: onOpenConnectors } : {})}
        onStartSession={() => {
          setConnectOpen(false)
          void runtime.refresh()
          if (!returnToNewSession()) setNewSessionOpen(true)
        }}
      />

      {handoffSource && (
        <HandoffDialog
          key={handoffSource.key}
          open
          onOpenChange={(open) => {
            // Closing before Continue is the cancel: nothing was started, and nothing is kept.
            if (!open) setHandoffSource(null)
          }}
          source={{
            provider: handoffSource.provider,
            agentName: agentDisplayName(handoffSource.provider),
            ...(handoffSource.title ? { title: handoffSource.title } : {}),
            statusLabel: handoffSource.statusLabel,
          }}
          {...(workspaceNameOf(handoffSource.workspaceId) ? { workspaceName: workspaceNameOf(handoffSource.workspaceId) } : {})}
          agents={handoffAgents}
          onConnect={(provider) => {
            setHandoffSource(null)
            openConnect(provider)
          }}
          projectsFor={handoffProjectsFor}
          transport={handoffSource.transport}
          onStarted={(result) => void handleHandoffStarted(result)}
          packFor={handoffPackFor}
          {...(handoffSource.initialProvider ? { initialProvider: handoffSource.initialProvider } : {})}
        />
      )}

      {pickerFor && (
        <ContextPicker
          key={pickerFor.key}
          open
          onOpenChange={(open) => {
            if (!open) setPickerFor(null)
          }}
          workspace={pickerWorkspace}
          collections={collectionStore.collections}
          dependencies={world.dependencies}
          initial={pickerInitial}
          agentName={pickerFor.sessionId ? agentName : "The agent"}
          onConfirm={(chosen) => {
            if (pickerFor.sessionId) void applyContext(pickerFor.sessionId, chosen)
            else setDraft(chosen.tabIds.length === 0 && chosen.collectionIds.length === 0 ? null : chosen)
          }}
        />
      )}
    </div>
  )
}

/** An agent the empty state offers. `action`: what fixes one that is not ready, through Connect Agent — absent when nothing the person does would. */
type StartableAgent = { provider: AgentProviderId; name: string; ready: boolean; reason?: string; action?: string }

/**
 * The refusal to show when a session was not started because its agent's
 * connection is not ready — the accurate one for the phase, never a generic
 * "not signed in" for an agent that is simply not installed or not answering.
 */
function refusalFor(phase: ConnectionPhase | undefined): RuntimeErrorCode {
  switch (phase) {
    case "timeout":
      return "timeout"
    case "connection_lost":
      return "runtime_disconnected"
    case "error":
      return "provider_error"
    case "runtime_unavailable":
      return "runtime_unavailable"
    case "not_installed":
    case "needs_adapter":
      return "provider_unavailable"
    default:
      return "authentication_required"
  }
}

/**
 * The command centre before a session is open: a starting point in the
 * workspace the user came from, not a promotion.
 *
 * Says what the work is on — the workspace's project, first, when it has one
 * (Stage 3) — where the developer left off, lets them start typing straight
 * away, and lists the agents that could take it. It shows no invented
 * metrics, no sample conversation and no placeholder agents.
 */
function CommandCentreEmptyState({
  executable,
  loading,
  workspaceName,
  project,
  lastTask,
  onConnectProject,
  now,
  agents,
  defaultProvider,
  initialText,
  contextControl,
  using,
  onStart,
  onConnect,
  onNewSession,
}: {
  /** What a task started here is given, counted: "5 sources · project brief" (Hubble 2.0). Said before anything is sent. */
  using?: string
  executable: boolean
  loading: boolean
  workspaceName?: string
  /** The workspace's project: its name, what it is, and whether an agent can work in it now. */
  project?: { name: string; detail?: string; ready: boolean; notice?: string }
  /** Where the developer left off in this workspace, with a way back to it when the session can be opened. */
  lastTask?: { task: LastTask; live?: string; onOpen?: () => void }
  /** Connects a project to this workspace. Absent: not possible here (and the project line says why). */
  onConnectProject?: () => void
  now: number
  agents: readonly StartableAgent[]
  defaultProvider?: AgentProviderId
  initialText: string
  contextControl?: React.ReactNode
  onStart: (text: string, provider: AgentProviderId | undefined) => void
  onConnect: (provider?: AgentProviderId) => void
  onNewSession: () => void
}) {
  const [text, setText] = useState(initialText)
  const [trackedInitial, setTrackedInitial] = useState(initialText)
  // A new request from the workspace replaces what was typed, as it would in a fresh composer.
  if (initialText !== trackedInitial) {
    setTrackedInitial(initialText)
    setText(initialText)
  }
  const ready = agents.filter((agent) => agent.ready)
  const chosen = ready.find((agent) => agent.provider === defaultProvider) ?? ready[0]

  return (
    /* A little above centre — where the conversation would start. */
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-24">
      <div className="w-full max-w-[600px]">
        <h1 className="text-statement text-foreground">
          {project && workspaceName ? `Work on ${project.name}` : workspaceName ? `Work on ${workspaceName}` : "Command Centre"}
        </h1>
        {project && workspaceName && (
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-body-sm text-tertiary" data-start-project>
            <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">
              {[project.detail, `in ${workspaceName}`].filter(Boolean).join(" · ")}
            </span>
          </p>
        )}
        <p className="mt-1.5 text-body text-muted-foreground">
          {project && workspaceName
            ? `Give an agent a task. It works on ${project.name} with what ${workspaceName} holds — its brief, tabs and collections — and asks you before it changes a file.`
            : workspaceName
              ? `Give any agent a task. It works from what ${workspaceName} holds — its brief, sources, tabs and earlier results — and sees no other project.`
              : "Work with your AI agents inside a Hubble project, on the context you choose."}
        </p>
        {project && !project.ready && project.notice && <p className="mt-1 text-body-sm text-warning">{project.notice}</p>}
        {!project && workspaceName && onConnectProject && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-body-sm text-tertiary">
            Connect a folder to let agents work on its files.
            <Button type="button" size="xs" variant="outline" onClick={onConnectProject}>
              Connect folder
            </Button>
          </p>
        )}

        {lastTask && <LeftOff {...lastTask} now={now} />}

        {loading ? (
          <p className="mt-6 text-body-sm text-tertiary">Checking the agent runtime…</p>
        ) : executable ? (
          <>
            <form
              className="mt-6 rounded-md border border-border bg-card transition-colors duration-(--duration-fast) ease-(--ease-color) focus-within:border-strong"
              onSubmit={(event) => {
                event.preventDefault()
                onStart(text.trim(), chosen?.provider)
              }}
            >
              <label className="sr-only" htmlFor="command-centre-first-message">
                Ask an agent
              </label>
              <textarea
                id="command-centre-first-message"
                rows={2}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return
                  event.preventDefault()
                  onStart(text.trim(), chosen?.provider)
                }}
                placeholder={
                  chosen
                    ? project
                      ? `Give ${chosen.name} a task in ${project.name}…`
                      : workspaceName
                        ? `Work on ${workspaceName} — what should ${chosen.name} do?`
                        : `Ask ${chosen.name}…`
                    : "Plan, research or organize anything…"
                }
                className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-body text-foreground outline-none placeholder:text-tertiary"
              />
              <div className="flex items-center gap-1.5 px-2 pb-2">
                {contextControl ?? (
                  <span className="flex h-6 items-center rounded-full bg-surface-hover px-2 text-body-sm text-muted-foreground">
                    <span className="text-tertiary">Context&nbsp;</span>Whole project
                  </span>
                )}
                <span className="min-w-0 flex-1" />
                {chosen && (
                  <span className="flex min-w-0 items-center gap-1 text-body-sm text-muted-foreground">
                    <AgentIcon connector={chosen.provider} size="xs" />
                    <span className="truncate">{chosen.name}</span>
                  </span>
                )}
                <Button type="submit" size="icon-sm" shape="pill" aria-label="Start with this message">
                  <ArrowUp />
                </Button>
              </div>
            </form>
            {chosen && using && (
              <p className="mt-1.5 text-meta text-muted-foreground" data-task-uses>
                {chosen.name} will use: {using}
              </p>
            )}

            <section aria-label="Agents for this workspace" className="mt-5">
              <h2 className="text-eyebrow text-tertiary">Agents</h2>
              {agents.length === 0 ? (
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <p className="text-body-sm text-tertiary">No agents connected yet.</p>
                  <Button type="button" size="xs" variant="outline" onClick={() => onConnect()}>
                    Connect an agent
                  </Button>
                </div>
              ) : (
                <ul className="mt-1 flex flex-col">
                  {agents.map((agent) => (
                    <li key={agent.provider} className="flex items-center gap-2 py-1">
                      <AgentIcon connector={agent.provider} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{agent.name}</span>
                      {agent.ready ? (
                        <Button type="button" size="xs" variant="ghost" onClick={() => onStart(text.trim(), agent.provider)} aria-label={`Start with ${agent.name}`}>
                          Start
                        </Button>
                      ) : (
                        <>
                          {agent.reason && <span className="min-w-0 shrink truncate text-label text-tertiary">{agent.reason}</span>}
                          {(agent.action || !agent.reason) && (
                            <Button type="button" size="xs" variant="outline" onClick={() => onConnect(agent.provider)} aria-label={`${agent.action ?? "Connect"} — ${agent.name}`}>
                              {agent.action ?? "Connect"}
                            </Button>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <Button type="button" size="xs" variant="ghost" className="mt-1 -ml-1.5" onClick={onNewSession}>
                More options…
              </Button>
            </section>
          </>
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

/**
 * Where the developer left off in this workspace (Stage 3): the last task, the
 * agent that worked on it, how it ended and what changed — so coming back is
 * a matter of reading one card, not reopening sessions to find out.
 */
function LeftOff({
  task,
  live,
  onOpen,
  now,
}: {
  task: LastTask
  /** The session's current state in words, when this runtime still holds it. Absent: as it was last seen. */
  live?: string
  onOpen?: () => void
  now: number
}) {
  const when = formatRelativeTime(task.at, now)
  return (
    <section aria-label="Where you left off" className="mt-5 rounded-md border border-subtle bg-card px-3 py-2.5" data-left-off={task.state}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-eyebrow text-tertiary">Where you left off</h2>
        {when && <span className="text-meta text-tertiary">{when}</span>}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <AgentIcon connector={task.provider} size="xs" />
        <p className="min-w-0 flex-1 truncate text-body-sm text-foreground">
          <span className="text-muted-foreground">{agentDisplayName(task.provider)} · </span>
          <span className={cn(task.attention && "text-link")}>{live ?? lastTaskStateLabel(task)}</span>
          <span className="text-tertiary"> · </span>
          {task.headline}
        </p>
        {onOpen && (
          <Button type="button" size="xs" variant="secondary" onClick={onOpen}>
            Open
          </Button>
        )}
      </div>
      {(task.task || task.facts.length > 0) && (
        <p className="mt-0.5 truncate text-meta text-tertiary" title={task.task}>
          {task.task && <span className="text-muted-foreground">“{task.task}”</span>}
          {task.task && task.facts.length > 0 && " · "}
          {task.facts.join(" · ")}
        </p>
      )}
    </section>
  )
}
