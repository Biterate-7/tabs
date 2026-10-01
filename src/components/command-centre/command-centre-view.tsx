"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { ArrowUp, Bot, ChevronLeft, RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { AgentIcon } from "@/components/agents/agent-icon"
import { AgentRoster } from "./agent-roster"
import { ApprovalPrompt } from "./approval-prompt"
import { ConnectAgentDialog } from "./connect-agent-dialog"
import { Composer } from "./composer"
import { ContextPanel } from "./context-panel"
import { ContextPicker } from "./context-picker"
import { EventStream } from "./event-stream"
import { NewSessionDialog } from "./new-session-dialog"
import { SessionHeader } from "./session-header"
import { SessionList } from "./session-list"
import { WorkingContextChip } from "./working-context-control"
import type { WorkingContextActions } from "./working-context-control"
import { useCommandPaletteHost } from "@/components/command-palette/palette-host"
import type { Command } from "@/components/command-palette/types"
import { useAgentContext } from "@/hooks/use-agent-context"
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
import { hasUsableMcpToken, useMcpTokens } from "@/hooks/use-mcp-tokens"
import { platformProvider } from "@/lib/agents/platform/catalog"
import { isChatReady, recoveryLabel, signInKind } from "@/lib/agents/platform/lifecycle"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"
import { grantWithinApproval, projectScopesForAgent } from "@/lib/agents/platform/roster"
import { agentConnectorSurface, agentProjectFolderPicker } from "@/lib/platform"
import {
  RUNTIME_ERROR_PRESENTATION,
  canCreateSession,
  canSendMessage,
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
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
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
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<RuntimeErrorCode | null>(null)

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
      const agent = agentVisualIdentity(change.provider).displayName
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
    [onViewWorkspace, workspaceNameOf]
  )

  const sessionContext = useSessionContext({
    client: runtime.client,
    sessions: sessions.sessions,
    world,
    collections: collectionStore.collections,
    applyCollectionBatch: collectionStore.applyBatch,
    onApplied: handleApplied,
  })

  /*
    Exact undo, only while the workspace is still what the change left.
    Decided once per change of the collections or of the record — not per
    render: the surface re-renders every second for its clocks.
  */
  const undoable = useMemo(() => {
    const now = new Map<string, string>()
    const ids = new Set<string>()
    for (const change of allChanges) {
      if (!change.ok || change.undone || !change.before || !change.after) continue
      if (!now.has(change.workspaceId)) {
        now.set(change.workspaceId, JSON.stringify(collectionStore.collections.filter((collection) => collection.workspaceId === change.workspaceId)))
      }
      if (now.get(change.workspaceId) === JSON.stringify(change.after)) ids.add(change.id)
    }
    return ids
  }, [allChanges, collectionStore.collections])
  const canUndo = useCallback((change: AppliedWorkspaceChange) => undoable.has(change.id), [undoable])
  const undoChange = useCallback(
    (change: AppliedWorkspaceChange) => {
      if (!change.before || !change.after) return
      if (collectionStore.restoreCollections(change.workspaceId, change.before, change.after)) {
        markWorkspaceChangeUndone(change.id)
        toast(`Undone in ${workspaceNameOf(change.workspaceId) ?? "the workspace"}`)
      } else {
        toast.info("Can't undo — the workspace has changed since", { description: "Nothing was changed." })
      }
    },
    [collectionStore, workspaceNameOf]
  )

  /* ---------------- Context: per session, inside its workspace. */

  const [contextBusy, setContextBusy] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)

  /**
   * Points a session at a context: resolved inside the session's workspace by
   * the Phase E bridge and attached — or, for the whole workspace, detached,
   * because the session reads its workspace itself. The runtime checks it
   * again and reports it back as the session's focus.
   */
  const applyContext = useCallback(
    async (sessionId: string, next: WorkingContext): Promise<boolean> => {
      const scoped = withinWorkspace(next, liveWorld).context
      const outcome = context.resolve(scoped)
      if (!outcome.ok) {
        setContextError("Hubble couldn't prepare that context. Nothing was sent.")
        return false
      }
      setContextBusy(true)
      const result = outcome.attached
        ? await runtime.client.send({ name: "attach_context", sessionId, context: outcome.attached })
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
      await sessions.refresh()
      if (sessionId === selectedSessionId) await session.refresh()
      return true
    },
    [context, liveWorld, runtime.client, selectedSessionId, session, sessions]
  )

  /*
    The context the next new session starts with — what the user brought from
    the workspace when no session there could take it. Tied to its workspace:
    a session started somewhere else starts with the whole of that one.
  */
  const [draft, setDraft] = useState<WorkingContext | null>(null)
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
        toast(`Added to ${agentVisualIdentity(targetView.provider).displayName}'s context`, {
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
        setCreateError("permission_denied")
        return
      }

      // Signed in, with a sign-in Hubble may use, and reachable — refused here
      // only when that is genuinely not so, and never by picking another way
      // to sign in: the dialog shows the action that fixes it.
      const prerequisite = platform.prerequisiteFor(input.provider)
      if (!prerequisite.ok) {
        setCreateError(refusalFor(prerequisite.phase))
        return
      }

      // The workspace the session works in goes with it, for the agent to
      // query; the context brought from it, if it is that workspace's.
      const contextSnapshot = input.workspaceId ? sessionContext.snapshotFor(input.workspaceId) : undefined
      const brought = draft && input.workspaceId === draft.workspaceId ? context.resolve(withinWorkspace(draft, liveWorld).context) : undefined
      const startContext = brought?.ok && brought.attached ? brought.attached : undefined

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
        setCreateError(outcome)
        return
      }
      setResume(null)

      platform.recordSession(input.provider, outcome.sessionId, input.workspaceId)
      setRequestedSessionId(outcome.sessionId)
      setNewSessionOpen(false)
      if (startContext) setDraft(null)
      if (firstMessage) setQueued({ sessionId: outcome.sessionId, text: firstMessage })
      else if (draftText) setComposerSeed({ key: `new-${outcome.sessionId}`, sessionId: outcome.sessionId, text: draftText })
      setFirstMessage(undefined)
      setDraftText("")
    },
    [context, draft, draftText, firstMessage, liveWorld, platform, projects.projects, sessionContext, sessions]
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

  const agentName = currentView ? agentVisualIdentity(currentView.provider).displayName : "The agent"
  const workspaceShown = currentView ? sessionWorkspaceId : (draft?.workspaceId ?? activeWorkspaceId)
  const workspaceName = workspaceNameOf(workspaceShown)
  const delivered = currentView?.focus ? currentView.focus.delivered : undefined
  const sessionChanges = useMemo(
    () => (currentView ? allChanges.filter((change) => change.sessionId === currentView.sessionId) : []),
    [allChanges, currentView]
  )

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

  const errorPresentation = session.error ? RUNTIME_ERROR_PRESENTATION[session.error] : null

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
      platform.roster.agents.flatMap((agent) => {
        const spec = platformProvider(agent.provider)
        if (!spec?.chat) return []
        // The same gate the start dialog applies: connected and signed in in
        // a way Hubble may use, sessions offered, and the runtime can start one.
        const status = startableProviders.find((provider) => provider.provider === agent.provider)
        const prerequisite = platform.prerequisiteFor(agent.provider)
        const ready = prerequisite.ok && Boolean(status && canCreateSession(status))
        return [{ provider: agent.provider, name: agent.name, ready, ...(prerequisite.ok ? {} : { reason: prerequisite.reason }) }]
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
        {selected && (
          <IconButton aria-label="All sessions" className="-ml-1.5 md:hidden" onClick={() => setRequestedSessionId(null)}>
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
          className={selected ? "max-md:hidden" : "max-md:w-full max-md:border-r-0"}
          sessions={sessions.sessions}
          selectedSessionId={selectedSessionId}
          projectNameOf={projectNameOf}
          workspaceNameOf={workspaceNameOf}
          onSelect={setRequestedSessionId}
          onNewSession={() => setNewSessionOpen(true)}
          canCreate={runtime.executable}
          now={now}
        >
          <AgentRoster
            platform={platform}
            sessions={sessions.sessions}
            selectedSessionId={selectedSessionId}
            selectedEvents={session.events}
            workspaceNameOf={workspaceNameOf}
            onConnect={openConnect}
            onOpenAgent={(agent, latest) => {
              const chat = platformProvider(agent.provider)?.chat === true
              const startable =
                chat && isChatReady(platform.phaseOf(agent.provider)) && platform.sessionsFor(agent.provider).available
              if (latest) setRequestedSessionId(latest.view.sessionId)
              else if (startable) {
                setDefaultProvider(agent.provider)
                setNewSessionOpen(true)
              }
              // Anything else is explained where it is decided: in Connect Agent.
              else openConnect(agent.provider)
            }}
          />
        </SessionList>

        <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !selected && "max-md:hidden")}>
          {current && currentView ? (
            <>
              <SessionHeader
                session={current}
                {...(projectNameOf(currentView.projectId) ? { projectName: projectNameOf(currentView.projectId) } : {})}
                {...(workspaceName ? { workspaceName } : {})}
                link={link}
                {...(currentView.context ? { contextFreshness: sessionContext.freshnessOf(currentView.context) } : {})}
                contextControl={
                  <WorkingContextChip
                    view={sessionContextView}
                    link={link}
                    agentName={agentName}
                    {...(delivered !== undefined ? { delivered } : {})}
                    busy={contextBusy}
                    {...contextActions}
                  />
                }
                contextPanelOpen={contextPanelOpen}
                onToggleContextPanel={() => setContextPanelOpen((open) => !open)}
                onDispose={() => void sessions.disposeSession(currentView.sessionId)}
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
                    onRespond={(approvalId, decision) => void session.respondToApproval(approvalId, decision)}
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
                    align="start"
                    {...contextActions}
                  />
                }
                onCancel={() => void session.cancelRun()}
                // Attached context rides with the next message on its own: the
                // runtime holds it and sends it once. Only the words go here.
                onSend={(text) => void session.sendMessage(text)}
              />
            </>
          ) : (
            <CommandCentreEmptyState
              executable={runtime.executable}
              loading={runtime.loading}
              {...(workspaceName ? { workspaceName } : {})}
              agents={startableAgents}
              defaultProvider={defaultProvider}
              initialText={draftText}
              contextControl={
                draftView ? (
                  <WorkingContextChip view={draftView} link={link} agentName="The agent" align="start" {...draftActions} />
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

        {contextPanelOpen && (
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
            runtimeStatus={runtime.status}
            {...(currentView ? contextActions : draftActions)}
          />
        )}
      </div>

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
        {...(createError ? { error: RUNTIME_ERROR_PRESENTATION[createError].title } : {})}
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
          const name = agentVisualIdentity(provider).displayName
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
 * Says where a session would work, lets the user start typing straight away,
 * and lists the agents that could take it. It shows no invented metrics, no
 * sample conversation and no placeholder agents.
 */
function CommandCentreEmptyState({
  executable,
  loading,
  workspaceName,
  agents,
  defaultProvider,
  initialText,
  contextControl,
  onStart,
  onConnect,
  onNewSession,
}: {
  executable: boolean
  loading: boolean
  workspaceName?: string
  agents: readonly { provider: AgentProviderId; name: string; ready: boolean; reason?: string }[]
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
          {workspaceName ? `Work with your ${workspaceName} workspace` : "Command Centre"}
        </h1>
        <p className="mt-1.5 text-body text-muted-foreground">
          {workspaceName
            ? "Connect an agent and start working with the tabs and collections in this workspace. It sees only this workspace."
            : "Work with your AI agents inside a Hubble workspace, on the context you choose."}
        </p>

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
                    ? `Ask ${chosen.name}${workspaceName ? ` about ${workspaceName}` : ""}…`
                    : "Plan, research or organize anything…"
                }
                className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-body text-foreground outline-none placeholder:text-tertiary"
              />
              <div className="flex items-center gap-1.5 px-2 pb-2">
                {contextControl ?? (
                  <span className="flex h-6 items-center rounded-full bg-surface-hover px-2 text-body-sm text-muted-foreground">
                    <span className="text-tertiary">Context&nbsp;</span>Whole workspace
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
                        <Button type="button" size="xs" variant="ghost" onClick={() => onStart(text.trim(), agent.provider)}>
                          Start
                        </Button>
                      ) : agent.reason ? (
                        <span className="shrink-0 text-label text-tertiary">{agent.reason}</span>
                      ) : (
                        <Button type="button" size="xs" variant="ghost" onClick={() => onConnect(agent.provider)}>
                          Connect
                        </Button>
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
