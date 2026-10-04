import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import type { RuntimeApprovalView, RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"
import { contextCountsLine } from "@/lib/agents/control/events"
import type { ControlContextDeliveryInfo } from "@/lib/agents/control/events"
import { contextOfSession } from "@/lib/agents/command-centre/working-context"
import { emptyContextWorld } from "@/lib/agents/context/world"
import { contextPackAttachedContext } from "@/lib/agents/context-pack/attach"
import { contextDeliveryOf } from "@/lib/agents/context-pack/provenance"
import { sessionContextPack } from "@/lib/agents/context-pack/session"
import { setWorkspaceBrief } from "@/lib/workspace/brief"
import { agentDisplayName, handoffLinksOf } from "@/lib/agents/handoff/handoff"
import type { SessionHandoff } from "@/lib/agents/handoff/handoff"
import type { AgentSessionStatus } from "@/lib/agents/control/session"
import {
  addTabsToCollection,
  createCollection,
  deleteCollection,
  moveTabToCollection,
  removeTabFromCollection,
  renameCollection,
} from "@/lib/collections/relations"
import { addDependency, removeDependency, updateDependencyType } from "@/lib/dependencies/relations"
import {
  addWorkspaces,
  assignTabsToSection,
  createSectionInWorkspace,
  createWorkspace,
  deleteSectionInWorkspace,
  renameSectionInWorkspace,
  deleteWorkspace,
  renameWorkspace,
  switchWorkspace,
  updateWorkspaceLogo,
  updateWorkspaceTabs,
} from "@/lib/workspace/store"
import { restoreWorkspaceCollections } from "@/lib/collections/restore"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { AgentHistoryDetail } from "@/lib/agents/activity/history"
import type { Collection } from "@/lib/collections/types"
import type { DependencyType, TabDependency } from "@/lib/dependencies/types"
import type { Tab } from "@/lib/tabs/types"
import type { WorkspaceStore } from "@/lib/workspace/types"
import {
  CLAUDE_SESSION,
  DEMO_KNOWN_APPROVALS,
  HANDOFF_PLAN,
  contextTool,
  demoSessionContext,
  DEMO_APPROVALS,
  DEMO_COLLECTIONS,
  DEMO_DEPENDENCIES,
  DEMO_EVENTS,
  DEMO_HISTORY,
  DEMO_NOW,
  DEMO_SESSIONS,
  DEMO_WORKSPACES,
  RESEARCH_ID,
  SWE_APPROVAL,
  SWE_TAB_IDS,
} from "./data"

/*
 * The demo's state, as a pure reducer.
 *
 * Every workspace and collection change goes through the product's own pure
 * helpers (lib/workspace/store, lib/collections/relations) — the same
 * functions AppShell and the collection store call — so a tab moved or a
 * collection gathered here behaves exactly as it does in Hubble. What this
 * module never does is persist: there is no storage key, no network, no
 * runtime. Reloading the page is a full reset, and so is `reset`.
 *
 * The agent side is a small, honest state machine over real session views and
 * control events. It replays what the Command Centre does with an answer —
 * an approved collection is created in the workspace, a denied one is not —
 * and a message typed into the composer gets a reply that says plainly that
 * no agent is connected to this page.
 *
 * An approval plays out in the steps the app goes through, one action each,
 * so the same states appear in the same order: `respond` (approved — the
 * session is running), `apply-approved` (the Command Centre applies the
 * change and records it, as an `AppliedWorkspaceChange`), `finish-approved`
 * (the agent replies and its run ends). `undo` reverses a recorded change
 * through the same restore the collection store uses, and records the undo
 * on the change — never by deleting it.
 */

/** The destinations the demo's rail can open. Mirrors AppShell's `view` union. */
export type DemoView =
  | "workspace"
  | "graph"
  | "favorites"
  | "recents"
  | "history-dump"
  | "command-centre"
  | "agent-history"
  | "settings"

export type DemoSettingsSection = "appearance" | "agents" | "workspaces" | "shortcuts"

export type DemoState = {
  view: DemoView
  store: WorkspaceStore
  collections: Collection[]
  dependencies: TabDependency[]
  sessions: CommandCentreSession[]
  events: Record<string, SequencedControlEvent[]>
  approvals: Record<string, RuntimeApprovalView[]>
  /** What the demo's "Command Centre" applied for its agents, as the app records it. */
  changes: AppliedWorkspaceChange[]
  /** The Command Centre's open session. `null` shows the list (master) on phones. */
  selectedSessionId: string | null
  /**
   * Agent history: sessions that ended before the visitor arrived, as Hubble
   * reads them back (lib/agents/activity/history.ts). An undo appends a
   * record; the session's own records are never rewritten.
   */
  history: AgentHistoryDetail[]
  /** The past session open in the Command Centre, by id. Exclusive with `selectedSessionId`. */
  selectedHistoryId: string | null
  /** Handoffs the visitor made (Hubble 1.4), as the runtime records them. */
  handoffs: SessionHandoff[]
  /**
   * Context attached to a session and not yet sent (Hubble 1.5): what its
   * next message delivers, as the runtime records it on that message.
   */
  pendingDelivery: Record<string, ControlContextDeliveryInfo>
  /**
   * What each approval in the demo would change once approved, by approval
   * id — Claude Code's SWE-bench collection, and whatever a handed-off agent
   * asks for. The Command Centre applies it exactly as it applies any other.
   */
  pendingChanges: Record<string, DemoPendingChange>
  /** Approvals raised during the visit, remembered after they are answered — as the Command Centre remembers them. */
  seenApprovals: RuntimeApprovalView[]
  paletteOpen: boolean
  /** The Command Centre's context panel (shown from `xl`, as in the app). */
  contextPanelOpen: boolean
  sidebarCollapsed: boolean
  mobileSidebarOpen: boolean
  settingsSection: DemoSettingsSection
  /** How many things the visitor has created, for deterministic ids. */
  created: number
}

export type DemoPendingChange = {
  sessionId: string
  workspaceId: string
  name: string
  tabIds: readonly string[]
  /** The agent's reply once it is applied, and once it is declined. */
  reply: string
  declined: string
}

const SWE_CHANGE: DemoPendingChange = {
  sessionId: CLAUDE_SESSION,
  workspaceId: SWE_APPROVAL.workspaceId ?? RESEARCH_ID,
  name: "SWE-bench",
  tabIds: SWE_TAB_IDS,
  reply: "Done. “SWE-bench” is in Research with the paper, the leaderboard and the repository. Nothing else changed.",
  declined: "Understood — I won't create it. The three SWE-bench tabs stay where they are in Research.",
}

/** Every approval the demo can describe: the fixture's, and those raised during the visit. */
export function demoKnownApprovals(state: Pick<DemoState, "seenApprovals">): ReadonlyMap<string, RuntimeApprovalView> {
  if (state.seenApprovals.length === 0) return DEMO_KNOWN_APPROVALS
  return new Map([...DEMO_KNOWN_APPROVALS, ...state.seenApprovals.map((approval) => [approval.approvalId, approval] as const)])
}

/**
 * The session a handoff starts, as the runtime describes it: the target
 * agent, working in the source's workspace, holding its context only if the
 * visitor passed it, and linked to the source by the handoff record.
 */
export function demoHandoffTarget(handoff: SessionHandoff, title: string | undefined, workspaceName: string): RuntimeSessionView {
  return {
    sessionId: handoff.targetSessionId!,
    provider: handoff.targetProvider,
    status: "running",
    runIds: [`${handoff.targetSessionId}-run-1`],
    awaitingApproval: false,
    cancellable: true,
    resumable: false,
    latestSequence: 0,
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
    workspaceId: handoff.workspaceId,
    ...(title ? { title } : {}),
    ...(handoff.context.workspace ? { context: demoSessionContext(handoff.workspaceId, workspaceName, true) } : {}),
    handoff: { from: { handoffId: handoff.handoffId, sessionId: handoff.sourceSessionId, provider: handoff.sourceProvider, status: "ready" } },
  }
}

export type DemoInit = {
  view?: DemoView
  currentId?: string
  selectedSessionId?: string | null
  selectedHistoryId?: string | null
  sidebarCollapsed?: boolean
  contextPanelOpen?: boolean
  settingsSection?: DemoSettingsSection
}

/**
 * The fixture's sessions as the runtime would hold them (Hubble 1.5): each
 * was started with its Context Pack — built by the product's own recipe from
 * the demo's workspaces — and its first message delivered it, which that
 * message records. A session with nothing to attach reads its workspace.
 */
function seedContext(
  sessions: readonly CommandCentreSession[],
  events: Record<string, SequencedControlEvent[]>,
  world: Pick<DemoState, "collections" | "dependencies"> & { workspaces: WorkspaceStore["workspaces"] }
): { sessions: CommandCentreSession[]; events: Record<string, SequencedControlEvent[]> } {
  const contextWorld = { ...emptyContextWorld(null), workspaces: world.workspaces, collections: world.collections, dependencies: world.dependencies }
  const nextEvents = { ...events }
  const nextSessions = sessions.map((entry) => {
    const workspaceId = entry.view.workspaceId
    if (!workspaceId) return entry
    const built = sessionContextPack({ world: contextWorld, workspaceId, selection: contextOfSession(entry.view), sessionId: entry.view.sessionId, changes: [] })
    const attached = built.ok ? contextPackAttachedContext(built.pack, DEMO_NOW) : null
    if (!attached) return entry
    const delivery = contextDeliveryOf(attached, workspaceId)
    const list = nextEvents[entry.view.sessionId] ?? []
    const first = list.findIndex((event) => event.kind === "message_sent" && !event.handoff)
    if (first >= 0 && delivery) nextEvents[entry.view.sessionId] = list.map((event, index) => (index === first ? { ...event, delivery } : event))
    return { ...entry, view: { ...entry.view, contextSnapshotId: attached.snapshotId, contextDelivered: first >= 0 } }
  })
  return { sessions: nextSessions, events: nextEvents }
}

export function createDemoState(init: DemoInit = {}): DemoState {
  const workspaces = DEMO_WORKSPACES.map((workspace) => ({ ...workspace, tabs: [...workspace.tabs] }))
  const collections = DEMO_COLLECTIONS.map((c) => ({ ...c, tabIds: [...c.tabIds] }))
  const dependencies = [...DEMO_DEPENDENCIES]
  const seeded = seedContext(
    withSequence([...DEMO_SESSIONS], DEMO_EVENTS as Record<string, SequencedControlEvent[]>),
    Object.fromEntries(Object.entries(DEMO_EVENTS).map(([id, list]) => [id, [...list]])),
    { workspaces, collections, dependencies }
  )
  return {
    view: init.view ?? "workspace",
    store: { version: 1, currentId: init.currentId ?? RESEARCH_ID, workspaces },
    collections,
    dependencies,
    sessions: seeded.sessions,
    events: seeded.events,
    approvals: Object.fromEntries(Object.entries(DEMO_APPROVALS).map(([id, list]) => [id, [...list]])),
    changes: [],
    selectedSessionId: init.selectedHistoryId ? null : init.selectedSessionId === undefined ? CLAUDE_SESSION : init.selectedSessionId,
    history: [...DEMO_HISTORY],
    selectedHistoryId: init.selectedHistoryId ?? null,
    handoffs: [],
    pendingDelivery: {},
    pendingChanges: { [SWE_APPROVAL.approvalId]: SWE_CHANGE },
    seenApprovals: [],
    paletteOpen: false,
    contextPanelOpen: init.contextPanelOpen ?? true,
    sidebarCollapsed: init.sidebarCollapsed ?? false,
    mobileSidebarOpen: false,
    settingsSection: init.settingsSection ?? "appearance",
    created: 0,
  }
}

export type DemoAction =
  | { type: "navigate"; view: DemoView }
  | { type: "switch-workspace"; id: string }
  | { type: "create-workspace"; name: string }
  | { type: "rename-workspace"; id: string; name: string }
  | { type: "delete-workspace"; id: string }
  | { type: "update-logo"; id: string; logo: string | undefined }
  | { type: "import-workspaces"; store: WorkspaceStore["workspaces"]; collections: Collection[] }
  | { type: "set-tabs"; workspaceId: string; tabs: Tab[] }
  | { type: "assign-section"; workspaceId: string; tabId: string; sectionId: string }
  | { type: "create-section"; parentId: string | null; name: string }
  | { type: "rename-section"; id: string; name: string }
  | { type: "delete-section"; id: string; reassignTo?: string }
  | { type: "add-dependency"; parentTabId: string; childTabId: string; dependencyType?: DependencyType }
  | { type: "remove-dependency"; id: string }
  | { type: "set-dependency-type"; id: string; dependencyType: DependencyType | undefined }
  | { type: "create-collection"; name: string; tabIds: string[] }
  | { type: "rename-collection"; id: string; name: string }
  | { type: "delete-collection"; id: string }
  | { type: "add-to-collection"; id: string; tabIds: string[] }
  | { type: "remove-from-collection"; id: string; tabId: string }
  | { type: "move-to-collection"; tabId: string; id: string }
  | { type: "select-session"; id: string | null }
  /** What a session is pointed at inside its workspace — as the runtime would record it, ids only. */
  | {
      type: "set-focus"
      sessionId: string
      focus: { tabIds: readonly string[]; collectionIds: readonly string[] } | null
      /** The Context Pack attached (Hubble 1.5): its id, and what its next message will record delivering. `null`: detached. */
      context?: { contextId: string; delivery?: ControlContextDeliveryInfo } | null
    }
  /** The person's brief for a workspace (Hubble 1.5), through the product's own store function. */
  | { type: "set-brief"; workspaceId: string; brief: { description: string; focus: string } }
  | { type: "respond"; approvalId: string; decision: "granted" | "denied" }
  /** The Command Centre applies an approved change, after the approval. */
  | { type: "apply-approved"; approvalId: string }
  /** The agent says what it did and its run ends, after the change is applied. */
  | { type: "finish-approved"; approvalId: string }
  | { type: "undo"; changeId: string }
  /** Opens a past session from agent history, or closes it. */
  | { type: "select-history"; id: string | null }
  /** Undoes a past session's change exactly — recorded as its own record after the change. */
  | { type: "undo-history"; sessionId: string; changeId: string }
  /**
   * The visitor continued a session with another agent (Hubble 1.4): the
   * handoff as the demo's transport recorded it, and the envelope the target
   * agent is told — built by the product's own functions.
   */
  | {
      type: "handoff-start"
      handoff: SessionHandoff
      envelope: string
      title?: string
      workspaceName: string
      /** The Context Pack sent with the envelope (Hubble 1.5), and the source focus it carried. */
      pack?: { contextId: string; delivery?: ControlContextDeliveryInfo; focus?: { tabIds: readonly string[]; collectionIds: readonly string[] } }
    }
  /** The handed-off agent reads the workspace and asks to change it. */
  | { type: "handoff-work"; sessionId: string; approval: RuntimeApprovalView }
  | { type: "send"; sessionId: string; text: string }
  | { type: "reply"; sessionId: string }
  | { type: "cancel"; sessionId: string }
  | { type: "dispose"; sessionId: string }
  | { type: "palette"; open: boolean }
  | { type: "toggle-sidebar" }
  | { type: "set-sidebar-collapsed"; collapsed: boolean }
  | { type: "toggle-context-panel" }
  | { type: "mobile-sidebar"; open: boolean }
  | { type: "settings-section"; section: DemoSettingsSection }
  | { type: "reset"; init?: DemoInit }

/** What the demo's agents say to a typed message. There is no agent behind this page, and the reply says so. */
export const DEMO_REPLY =
  "This is Hubble's demo, so no agent is connected and nothing you type leaves this page. In Hubble, the agent's reply streams in here, the Hubble tools it calls are listed above it, and anything that would change your workspace waits for your approval."

function appendEvents(
  state: DemoState,
  sessionId: string,
  inputs: readonly (Partial<SequencedControlEvent> & Pick<SequencedControlEvent, "kind" | "summary">)[]
): Record<string, SequencedControlEvent[]> {
  const session = state.sessions.find((entry) => entry.view.sessionId === sessionId)
  if (!session) return state.events
  const existing = state.events[sessionId] ?? []
  const last = existing[existing.length - 1]
  const startSequence = last?.sequence ?? 0
  const startTime = Math.max(last?.timestamp ?? DEMO_NOW, DEMO_NOW)
  const added = inputs.map((input, index) => ({
    id: `${sessionId}-e${startSequence + index + 1}`,
    sessionId,
    provider: session.view.provider,
    timestamp: startTime + (index + 1) * 1_000,
    sequence: startSequence + index + 1,
    ...input,
  }))
  return { ...state.events, [sessionId]: [...existing, ...added] }
}

function withSequence(sessions: CommandCentreSession[], events: Record<string, SequencedControlEvent[]>): CommandCentreSession[] {
  return sessions.map((entry) => {
    const list = events[entry.view.sessionId]
    const latest = list?.[list.length - 1]?.sequence ?? 0
    return latest === entry.view.latestSequence ? entry : { ...entry, view: { ...entry.view, latestSequence: latest } }
  })
}

function patchSession(
  sessions: CommandCentreSession[],
  sessionId: string,
  status: AgentSessionStatus,
  extra: Partial<CommandCentreSession["view"]> = {}
): CommandCentreSession[] {
  return sessions.map((entry) =>
    entry.view.sessionId === sessionId
      ? {
          ...entry,
          view: {
            ...entry.view,
            status,
            awaitingApproval: status === "waiting_for_approval",
            cancellable: status === "running" || status === "waiting_for_approval",
            updatedAt: DEMO_NOW,
            ...extra,
          },
        }
      : entry
  )
}

/** A collection the visitor or an approved agent created, with a stable id rather than a random one. */
function addCollection(state: DemoState, workspaceId: string, name: string, tabIds: string[]) {
  const created = state.created + 1
  const result = createCollection(state.collections, workspaceId, name, tabIds, DEMO_NOW)
  const id = `c-created-${created}`
  return {
    created,
    collections: result.collections.map((c) => (c === result.collection ? { ...c, id } : c)),
    id,
  }
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  const next = reduce(state, action)
  return next.events === state.events && next.sessions === state.sessions
    ? next
    : { ...next, sessions: withSequence(next.sessions, next.events) }
}

function reduce(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "navigate":
      return { ...state, view: action.view, paletteOpen: false, mobileSidebarOpen: false }

    case "switch-workspace":
      return { ...state, store: switchWorkspace(state.store, action.id), mobileSidebarOpen: false }

    case "create-workspace":
      return { ...state, store: createWorkspace(state.store, action.name), view: "workspace" }

    case "rename-workspace":
      return { ...state, store: renameWorkspace(state.store, action.id, action.name) }

    case "delete-workspace": {
      // The demo keeps at least one of its own workspaces, so the page never
      // lands on an empty shell that only a reload would fix.
      if (state.store.workspaces.length <= 1) return state
      return {
        ...state,
        store: deleteWorkspace(state.store, action.id),
        collections: state.collections.filter((c) => c.workspaceId !== action.id),
      }
    }

    case "update-logo":
      return { ...state, store: updateWorkspaceLogo(state.store, action.id, action.logo) }

    case "import-workspaces":
      return {
        ...state,
        store: addWorkspaces(state.store, action.store),
        collections: [...state.collections, ...action.collections],
      }

    case "set-tabs": {
      const store = updateWorkspaceTabs(state.store, action.workspaceId, action.tabs)
      const remaining = new Set(action.tabs.map((t) => t.id))
      const workspace = state.store.workspaces.find((w) => w.id === action.workspaceId)
      const removed = new Set((workspace?.tabs ?? []).filter((t) => !remaining.has(t.id)).map((t) => t.id))
      return {
        ...state,
        store,
        collections:
          removed.size === 0
            ? state.collections
            : state.collections.map((c) =>
                c.tabIds.some((id) => removed.has(id)) ? { ...c, tabIds: c.tabIds.filter((id) => !removed.has(id)) } : c
              ),
      }
    }

    case "assign-section":
      return { ...state, store: assignTabsToSection(state.store, action.workspaceId, [action.tabId], action.sectionId) }

    case "create-section": {
      const result = createSectionInWorkspace(state.store, state.store.currentId, action.parentId, action.name, "user")
      return result ? { ...state, store: result.store } : state
    }

    case "rename-section":
      return { ...state, store: renameSectionInWorkspace(state.store, state.store.currentId, action.id, action.name) }

    case "delete-section":
      return { ...state, store: deleteSectionInWorkspace(state.store, state.store.currentId, action.id, action.reassignTo) }

    case "add-dependency":
      return {
        ...state,
        dependencies: addDependency(state.dependencies, action.parentTabId, action.childTabId, action.dependencyType, DEMO_NOW),
      }

    case "remove-dependency":
      return { ...state, dependencies: removeDependency(state.dependencies, action.id) }

    case "set-dependency-type":
      return { ...state, dependencies: updateDependencyType(state.dependencies, action.id, action.dependencyType, DEMO_NOW) }

    case "create-collection": {
      const next = addCollection(state, state.store.currentId, action.name, action.tabIds)
      return { ...state, collections: next.collections, created: next.created }
    }

    case "rename-collection":
      return { ...state, collections: renameCollection(state.collections, action.id, action.name, DEMO_NOW) }

    case "delete-collection":
      return { ...state, collections: deleteCollection(state.collections, action.id) }

    case "add-to-collection":
      return { ...state, collections: addTabsToCollection(state.collections, action.id, action.tabIds, DEMO_NOW) }

    case "remove-from-collection":
      return { ...state, collections: removeTabFromCollection(state.collections, action.id, action.tabId, DEMO_NOW) }

    case "move-to-collection":
      return { ...state, collections: moveTabToCollection(state.collections, action.tabId, action.id, DEMO_NOW) }

    case "select-session":
      return { ...state, selectedSessionId: action.id, ...(action.id ? { selectedHistoryId: null } : {}) }

    case "select-history":
      return { ...state, selectedHistoryId: action.id, ...(action.id ? { selectedSessionId: null } : {}) }

    case "undo-history": {
      const detail = state.history.find((entry) => entry.session.sessionId === action.sessionId)
      const change = detail?.records.changes.find((candidate) => candidate.id === action.changeId)
      if (!detail || !change || !change.ok || !change.before || !change.after) return state
      if (detail.records.undos.some((undo) => undo.changeId === change.id)) return state
      // The same restore, the same refusal: nothing moves if the workspace changed since.
      const restored = restoreWorkspaceCollections(state.collections, change.workspaceId, change.before, change.after)
      if (!restored) return state
      const at = Math.max(detail.session.lastActivityAt, change.at, DEMO_NOW) + 1_000
      return {
        ...state,
        collections: restored.collections,
        history: state.history.map((entry) =>
          entry === detail ? { ...entry, records: { ...entry.records, undos: [...entry.records.undos, { changeId: change.id, at }] } } : entry
        ),
      }
    }

    case "set-focus": {
      const pendingDelivery = { ...state.pendingDelivery }
      if (action.context !== undefined) {
        delete pendingDelivery[action.sessionId]
        if (action.context?.delivery) pendingDelivery[action.sessionId] = action.context.delivery
      }
      return {
        ...state,
        pendingDelivery,
        sessions: state.sessions.map((entry) => {
          if (entry.view.sessionId !== action.sessionId) return entry
          const view = { ...entry.view }
          delete view.focus
          if (action.context !== undefined) {
            delete view.contextSnapshotId
            delete view.contextDelivered
            if (action.context) Object.assign(view, { contextSnapshotId: action.context.contextId, contextDelivered: false })
          }
          const empty = !action.focus || (action.focus.tabIds.length === 0 && action.focus.collectionIds.length === 0)
          return {
            ...entry,
            view: empty ? view : { ...view, focus: { tabIds: [...action.focus!.tabIds], collectionIds: [...action.focus!.collectionIds], delivered: false } },
          }
        }),
      }
    }

    case "set-brief": {
      const store = setWorkspaceBrief(state.store, action.workspaceId, action.brief, DEMO_NOW)
      return store === state.store ? state : { ...state, store }
    }

    case "respond": {
      const sessionId = Object.keys(state.approvals).find((id) =>
        state.approvals[id]?.some((approval) => approval.approvalId === action.approvalId)
      )
      if (!sessionId) return state
      const approval = state.approvals[sessionId].find((a) => a.approvalId === action.approvalId)!
      const approvals = {
        ...state.approvals,
        [sessionId]: state.approvals[sessionId].filter((a) => a.approvalId !== action.approvalId),
      }

      if (action.decision === "denied") {
        return {
          ...state,
          approvals,
          sessions: patchSession(state.sessions, sessionId, "ready"),
          events: appendEvents(state, sessionId, [
            // The control service's own words for a workspace decision.
            { kind: "approval_denied", summary: approval.workspaceId ? "Workspace change declined" : "Denied", approvalId: approval.approvalId },
            {
              kind: "message_received",
              summary: "Reply",
              messageId: `${approval.approvalId}-denied`,
              text: state.pendingChanges[approval.approvalId]?.declined ?? SWE_CHANGE.declined,
            },
          ]),
        }
      }

      // Granted: as in the runtime, the agent's run carries on while the
      // Command Centre applies the change (`apply-approved`, next).
      return {
        ...state,
        approvals,
        sessions: patchSession(state.sessions, sessionId, "running"),
        events: appendEvents(state, sessionId, [
          { kind: "approval_granted", summary: approval.workspaceId ? "Workspace change approved" : "Approved", approvalId: approval.approvalId },
        ]),
      }
    }

    case "apply-approved": {
      // An approval that changes the workspace: a new collection holding the
      // tabs the card named — Claude Code's, or a handed-off agent's.
      const pending = state.pendingChanges[action.approvalId]
      if (!pending) return state
      const sessionId = pending.sessionId
      const events = state.events[sessionId] ?? []
      const granted = events.some((event) => event.kind === "approval_granted" && event.approvalId === action.approvalId)
      if (!granted || state.changes.some((change) => change.approvalId === action.approvalId)) return state
      const session = state.sessions.find((entry) => entry.view.sessionId === sessionId)
      if (!session) return state

      // Applied the way the Command Centre applies it — through the product's
      // own collection reducer — and recorded with the collections either
      // side, which is what makes an exact undo possible.
      const workspaceId = pending.workspaceId
      const before = state.collections.filter((collection) => collection.workspaceId === workspaceId)
      const next = addCollection(state, workspaceId, pending.name, [...pending.tabIds])
      const after = next.collections.filter((collection) => collection.workspaceId === workspaceId)
      // No event: Claude Code reports no result for a Hubble tool call, so
      // in Hubble too the change is the Command Centre's record, not the journal's.
      const last = events[events.length - 1]
      const change: AppliedWorkspaceChange = {
        id: `demo-change-${next.created}`,
        sessionId,
        provider: session.view.provider,
        workspaceId,
        at: Math.max(last?.timestamp ?? DEMO_NOW, DEMO_NOW) + 500,
        ok: true,
        approvalId: action.approvalId,
        steps: [{ kind: "created", collectionId: next.id, name: pending.name, tabCount: pending.tabIds.length }],
        before,
        after,
      }
      return {
        ...state,
        collections: next.collections,
        created: next.created,
        changes: [...state.changes, change],
      }
    }

    case "finish-approved": {
      const change = state.changes.find((candidate) => candidate.approvalId === action.approvalId)
      if (!change) return state
      const messageId = `${action.approvalId}-granted`
      if ((state.events[change.sessionId] ?? []).some((event) => event.messageId === messageId)) return state
      return {
        ...state,
        // The run is over; the session is not — it waits for the next message.
        sessions: patchSession(state.sessions, change.sessionId, "ready"),
        events: appendEvents(state, change.sessionId, [
          {
            kind: "message_received",
            summary: "Reply",
            messageId,
            text: state.pendingChanges[action.approvalId]?.reply ?? SWE_CHANGE.reply,
          },
          { kind: "run_completed", summary: "Run completed." },
        ]),
      }
    }

    case "undo": {
      const change = state.changes.find((candidate) => candidate.id === action.changeId)
      if (!change || !change.ok || change.undone || !change.before || !change.after) return state
      // Refused, with nothing moved, if the workspace changed since — exactly as in Hubble.
      const restored = restoreWorkspaceCollections(state.collections, change.workspaceId, change.before, change.after)
      if (!restored) return state
      const last = (state.events[change.sessionId] ?? []).at(-1)
      // The demo's clock, kept moving forward: the undo is told after everything before it.
      const undoneAt = Math.max(last?.timestamp ?? DEMO_NOW, change.at, DEMO_NOW) + 1_000
      return {
        ...state,
        collections: restored.collections,
        changes: state.changes.map((candidate) => (candidate.id === change.id ? { ...candidate, undone: true, undoneAt } : candidate)),
      }
    }

    case "handoff-start": {
      const { handoff } = action
      const targetId = handoff.targetSessionId
      const source = state.sessions.find((entry) => entry.view.sessionId === handoff.sourceSessionId)
      if (!targetId || !source || state.sessions.some((entry) => entry.view.sessionId === targetId)) return state
      const handoffs = [...state.handoffs, handoff]
      const base = demoHandoffTarget(handoff, action.title, action.workspaceName)
      const pack = action.pack
      const focus = pack?.focus && (pack.focus.tabIds.length > 0 || pack.focus.collectionIds.length > 0) ? pack.focus : undefined
      const target: CommandCentreSession = {
        origin: "controlled",
        view: {
          ...base,
          ...(pack ? { contextSnapshotId: pack.contextId, contextDelivered: true } : {}),
          ...(focus ? { focus: { tabIds: [...focus.tabIds], collectionIds: [...focus.collectionIds], delivered: true } } : {}),
        },
      }
      // Both sessions' links, from the records — never from where they sit.
      const linked = [target, ...state.sessions].map((entry) => {
        const links = handoffLinksOf(entry.view.sessionId, handoffs)
        return links ? { ...entry, view: { ...entry.view, handoff: links } } : entry
      })
      const withTarget = { ...state, sessions: linked }
      const received = { handoffId: handoff.handoffId, workspaceId: handoff.workspaceId, peerProvider: handoff.sourceProvider, peerSessionId: handoff.sourceSessionId }
      const workspace = handoff.context.workspace
      const targetEvents = appendEvents(withTarget, targetId, [
        { kind: "session_started", summary: "Session started." },
        // What the agent was told, marked as the handoff by reference.
        {
          kind: "message_sent",
          summary: `Handoff from ${agentDisplayName(handoff.sourceProvider)}`,
          handoff: received,
          text: action.envelope,
          ...(pack?.delivery ? { delivery: pack.delivery } : {}),
        },
        { kind: "handoff_received", summary: `Handoff from ${agentDisplayName(handoff.sourceProvider)}`, handoff: received },
        ...(workspace
          ? [
              {
                kind: "context_loaded" as const,
                summary: contextCountsLine({ workspaceId: handoff.workspaceId, tabs: workspace.tabs, collections: workspace.collections }),
                context: { workspaceId: handoff.workspaceId, tabs: workspace.tabs, collections: workspace.collections },
              },
            ]
          : []),
      ])
      const events = appendEvents({ ...withTarget, events: targetEvents }, handoff.sourceSessionId, [
        {
          kind: "handoff_sent",
          summary: `Handed off to ${agentDisplayName(handoff.targetProvider)}`,
          handoff: { handoffId: handoff.handoffId, workspaceId: handoff.workspaceId, peerProvider: handoff.targetProvider, peerSessionId: targetId, outcome: "ready" },
        },
      ])
      return { ...withTarget, events, handoffs, selectedSessionId: targetId, selectedHistoryId: null }
    }

    case "handoff-work": {
      const session = state.sessions.find((entry) => entry.view.sessionId === action.sessionId)
      if (!session || session.view.status !== "running" || state.pendingChanges[action.approval.approvalId]) return state
      const workspaceId = session.view.workspaceId ?? RESEARCH_ID
      const workspace = state.store.workspaces.find((candidate) => candidate.id === workspaceId)
      const counts = {
        workspaceId,
        operation: "get_workspace_summary",
        ok: true,
        tabs: workspace?.tabs.length ?? 0,
        collections: state.collections.filter((collection) => collection.workspaceId === workspaceId).length,
      }
      return {
        ...state,
        approvals: { ...state.approvals, [action.sessionId]: [action.approval] },
        seenApprovals: [...state.seenApprovals, action.approval],
        pendingChanges: {
          ...state.pendingChanges,
          [action.approval.approvalId]: {
            sessionId: action.sessionId,
            workspaceId,
            name: HANDOFF_PLAN.name,
            tabIds: HANDOFF_PLAN.tabIds,
            reply: HANDOFF_PLAN.reply,
            declined: `Understood — I won't create “${HANDOFF_PLAN.name}”. Nothing in ${workspace?.name ?? "the workspace"} changed.`,
          },
        },
        sessions: patchSession(state.sessions, action.sessionId, "waiting_for_approval"),
        events: appendEvents(state, action.sessionId, [
          { kind: "tool_started", summary: "Reading the workspace", tool: contextTool("get_workspace_summary", `${action.sessionId}-call-1`) },
          // Summarised as the control service summarises it.
          { kind: "context_read", summary: contextCountsLine(counts), context: counts },
          { kind: "tool_started", summary: `Proposing “${HANDOFF_PLAN.name}”`, tool: contextTool("create_collection", `${action.sessionId}-call-2`) },
          { kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: action.approval.approvalId },
        ]),
      }
    }

    case "send": {
      const text = action.text.trim()
      if (!text) return state
      const messageId = `${action.sessionId}-typed-${(state.events[action.sessionId] ?? []).length + 1}`
      return {
        ...state,
        // The context rides with this message, as it does in Hubble — and the
        // message records what it delivered.
        sessions: patchSession(state.sessions, action.sessionId, "running").map((entry) =>
          entry.view.sessionId === action.sessionId
            ? {
                ...entry,
                view: {
                  ...entry.view,
                  ...(entry.view.focus ? { focus: { ...entry.view.focus, delivered: true } } : {}),
                  ...(entry.view.contextSnapshotId ? { contextDelivered: true } : {}),
                },
              }
            : entry
        ),
        pendingDelivery: Object.fromEntries(Object.entries(state.pendingDelivery).filter(([id]) => id !== action.sessionId)),
        events: appendEvents(state, action.sessionId, [
          {
            kind: "message_sent",
            summary: "Message sent.",
            messageId,
            text,
            ...(state.pendingDelivery[action.sessionId] ? { delivery: state.pendingDelivery[action.sessionId] } : {}),
          },
        ]),
      }
    }

    case "reply": {
      const session = state.sessions.find((entry) => entry.view.sessionId === action.sessionId)
      if (!session || session.view.status !== "running") return state
      const count = (state.events[action.sessionId] ?? []).length
      return {
        ...state,
        sessions: patchSession(state.sessions, action.sessionId, "ready"),
        events: appendEvents(state, action.sessionId, [
          { kind: "message_received", summary: "Reply", messageId: `${action.sessionId}-reply-${count + 1}`, text: DEMO_REPLY },
        ]),
      }
    }

    case "cancel": {
      const session = state.sessions.find((entry) => entry.view.sessionId === action.sessionId)
      if (!session || !session.view.cancellable) return state
      return {
        ...state,
        approvals: { ...state.approvals, [action.sessionId]: [] },
        sessions: patchSession(state.sessions, action.sessionId, "cancelled"),
        events: appendEvents(state, action.sessionId, [{ kind: "run_cancelled", summary: "Run cancelled." }]),
      }
    }

    case "dispose": {
      const sessions = state.sessions.filter((entry) => entry.view.sessionId !== action.sessionId)
      return {
        ...state,
        sessions,
        selectedSessionId: state.selectedSessionId === action.sessionId ? null : state.selectedSessionId,
      }
    }

    case "palette":
      return { ...state, paletteOpen: action.open }

    case "toggle-sidebar":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed }

    case "set-sidebar-collapsed":
      return state.sidebarCollapsed === action.collapsed ? state : { ...state, sidebarCollapsed: action.collapsed }

    case "toggle-context-panel":
      return { ...state, contextPanelOpen: !state.contextPanelOpen }

    case "mobile-sidebar":
      return { ...state, mobileSidebarOpen: action.open }

    case "settings-section":
      return { ...state, settingsSection: action.section, view: "settings" }

    case "reset":
      return createDemoState(action.init)
  }
}

/** The workspace on screen. `currentId` always names one — the store helpers keep that invariant. */
export function currentWorkspace(state: DemoState) {
  return state.store.workspaces.find((w) => w.id === state.store.currentId) ?? state.store.workspaces[0]
}
