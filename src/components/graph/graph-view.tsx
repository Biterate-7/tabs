"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ChevronLeft, Waypoints } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { EmptyState } from "@/components/ui/empty-state"
import { GraphCanvas, type GraphCanvasHandle, type HoverInfo } from "./graph-canvas"
import { GraphSidebar } from "./graph-sidebar"
import { GraphControls } from "./graph-controls"
import { GraphNodeTooltip } from "./graph-node-tooltip"
import { GraphContextMenu, type GraphContextMenuState } from "./graph-context-menu"
import { GraphEdgePopover, type GraphEdgePopoverState } from "./graph-edge-popover"
import { GraphNodeNotesView } from "./graph-node-notes-view"
import { GraphLinkDialog, type GraphLinkDialogMode } from "./graph-link-dialog"
import { buildDependencyEdges, buildGraphEdges, buildGraphNodes, buildWorkspaceLookup, edgeKey } from "@/lib/graph/relations"
import { buildClusterTree, computeClusterAnchors } from "@/lib/graph/clusters"
import { computeLocalDistances } from "@/lib/graph/local-graph"
import { createTimestamp } from "@/lib/timestamps"
import { computeLayoutKey } from "@/lib/graph/precompute"
import { searchGraphNodes } from "@/lib/graph/search"
import {
  defaultGraphState,
  loadGraphState,
  pruneGraphState,
  saveGraphState,
} from "@/lib/graph/persistence"
import type {
  CameraState,
  ConnectionFilters,
  GraphDepth,
  GraphDisplaySettings,
  GraphEdge,
  GraphPersistedState,
  GraphViewMode,
} from "@/lib/graph/types"
import { openTab } from "@/lib/browser/open-tab"
import { copyText } from "@/lib/workspace/export"
import { removeTabs } from "@/lib/workspace/cleanup"
import { moveTabsBetweenWorkspaces, updateWorkspaceTabs } from "@/lib/workspace/store"
import type { WorkspaceStore } from "@/lib/workspace/types"
import { countsFor, dependenciesOf, usedBy } from "@/lib/dependencies/relations"
import { validateDependency } from "@/lib/dependencies/validation"
import { buildDependencyTree } from "@/lib/dependencies/tree"
import { useDependencyStore } from "@/hooks/use-dependency-store"
import type { DependencyType } from "@/lib/dependencies/types"
import { useCollectionStore } from "@/hooks/use-collection-store"
import { getCollectionsForWorkspace } from "@/lib/collections/relations"
import { validateAddTabToCollection } from "@/lib/collections/validation"
import { GatherDialog } from "@/components/workspace/gather-dialog"
import { RenameCollectionDialog } from "@/components/workspace/rename-collection-dialog"
import { DeleteCollectionDialog } from "@/components/workspace/delete-collection-dialog"

import { useAgentSpatial } from "@/hooks/use-agent-spatial"
import { useAgentIntelligence } from "@/hooks/use-agent-intelligence"
import { useAgentConnectors } from "@/hooks/use-agent-connectors"
import { buildInspectorSelection } from "@/lib/agents/spatial/inspector"
import { runIdForWorkItemSelection } from "@/lib/agents/spatial/scene"
import { getRunsTouchingArtifact } from "@/lib/agents/intelligence/relationships"
import { runSpatialId } from "@/lib/agents/spatial/types"
import { searchAgentWork } from "@/lib/agents/spatial/search"
import { CONNECTOR_STATUS_LABELS } from "@/lib/agents/connectors/types"
import { GraphAgentPanel } from "./graph-agent-panel"
import { AgentWorld } from "@/components/agents/agent-world"
import { useAgentWorld } from "@/hooks/use-agent-world"
import { buildWorldRoster } from "@/lib/agents/world/roster"
import { handoffsForCharacter } from "@/lib/agents/world/scene"
import type { AgentActivityItem } from "@/components/agents/agent-activity-list"
import type { WorldCharacterDetail } from "@/components/agents/agent-world-detail"
import type { AgentStoreApi } from "@/hooks/use-agent-store"

const CAMERA_FLUSH_DELAY_MS = 200
const SAVE_DEBOUNCE_MS = 400

/**
 * The visual states the sidebar's "now" list shows.
 *
 * Only states that mean something is happening. A completed or failed run is
 * history, and the panel already shows history — repeating it under a heading
 * that says "now" would make a finished run look live.
 */
const LIVE_ACTIVITY_STATES = new Set(["working", "thinking", "communicating", "waiting", "starting"])

type LinkDialogState = { mode: GraphLinkDialogMode; tabId: string } | null

export function GraphView({
  store,
  onStoreUpdate,
  onClose,
  agentStore,
  agentSessionsAvailable,
}: {
  store: WorkspaceStore
  onStoreUpdate: (store: WorkspaceStore) => void
  onClose: () => void
  /**
   * The agent domain, mounted once at the shell and handed down.
   *
   * It used to be mounted here, alongside the observer that feeds it. Both
   * moved out when the Agent World became a view of its own: two surfaces
   * that each mounted their own store would have been two debounced writers
   * racing on one localStorage key, and two observers would have been two
   * ingestion paths for the same observations. One of each, at the shell,
   * removes the question rather than relying on the two views never being
   * open at once. See AppShell, and connectors/single-loop.test.ts.
   */
  agentStore: AgentStoreApi
  /** Whether Claude Code sessions can currently be observed, from the shell's observer. */
  agentSessionsAvailable: boolean
}) {
  const canvasHandleRef = useRef<GraphCanvasHandle>(null)
  const [graphState, setGraphState] = useState<GraphPersistedState>(() => {
    if (typeof window === "undefined") return defaultGraphState()
    const validIds = new Set(store.workspaces.flatMap((w) => w.tabs.map((t) => t.id)))
    return pruneGraphState(loadGraphState(), validIds)
  })
  const [query, setQuery] = useState("")
  const [hover, setHover] = useState<HoverInfo | null>(null)
  // The selected node's live on-screen anchor, reported by GraphCanvas —
  // deliberately independent of `hover` above (see onSelectedNodeScreenChange
  // in graph-canvas.tsx) so the persistent Tab Peek popup below stays
  // attached to the selection and never closes just because the cursor
  // moved somewhere else on the canvas.
  const [selectedNodeScreen, setSelectedNodeScreen] = useState<HoverInfo | null>(null)
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState | null>(null)
  const [edgePopover, setEdgePopover] = useState<GraphEdgePopoverState | null>(null)
  // Deliberately independent of node selection — opening the notes page is
  // its own explicit action (context menu "Notes", or the sidebar's Notes
  // button), not something that fires just from selecting/clicking a node.
  // See handleOpenNotes below.
  const [notesOpenTabId, setNotesOpenTabId] = useState<string | null>(null)
  const [linkDialog, setLinkDialog] = useState<LinkDialogState>(null)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null)
  const [gatherDialogState, setGatherDialogState] = useState<{ workspaceId: string; tabIds: string[] } | null>(null)
  const [renameCollectionId, setRenameCollectionId] = useState<string | null>(null)
  const [deleteCollectionId, setDeleteCollectionId] = useState<string | null>(null)

  const pendingCameraRef = useRef<CameraState | null>(null)
  const cameraFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const workspaceLookup = useMemo(() => buildWorkspaceLookup(store.workspaces), [store.workspaces])
  const validTabIds = useMemo(
    () => new Set(store.workspaces.flatMap((w) => w.tabs.map((t) => t.id))),
    [store.workspaces]
  )
  const {
    dependencies,
    addDependency: storeAddDependency,
    removeDependency: storeRemoveDependency,
    updateDependencyType: storeUpdateDependencyType,
  } = useDependencyStore(validTabIds)

  const {
    collections: allCollections,
    createCollection: createCollectionStore,
    renameCollection: renameCollectionStore,
    deleteCollection: deleteCollectionStore,
    addTabToCollection: addTabToCollectionStore,
  } = useCollectionStore(store.workspaces)

  const scopedTabs = useMemo(() => {
    const all = store.workspaces.flatMap((w) => w.tabs)
    if (graphState.settings.workspaceFilter === "all") return all
    return all.filter((t) => workspaceLookup.get(t.id)?.id === graphState.settings.workspaceFilter)
  }, [store.workspaces, graphState.settings.workspaceFilter, workspaceLookup])

  const allNodes = useMemo(() => buildGraphNodes(scopedTabs, workspaceLookup), [scopedTabs, workspaceLookup])
  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes])

  // Unscoped by the workspace filter — the dependency sidebar needs to
  // resolve a dependency's title/favicon/domain even when that tab happens
  // to be filtered out of the currently visible graph.
  const everyNode = useMemo(
    () => buildGraphNodes(store.workspaces.flatMap((w) => w.tabs), workspaceLookup),
    [store.workspaces, workspaceLookup]
  )
  const everyNodeById = useMemo(() => new Map(everyNode.map((n) => [n.id, n])), [everyNode])

  const allSections = useMemo(() => store.workspaces.flatMap((w) => w.sections ?? []), [store.workspaces])

  // Hierarchical Category → Subcategory (→ Collection) structure driving the
  // graph's clustering forces and nested boundary rendering — see
  // lib/graph/clusters.ts. Computed from the same scoped tab set as the rest
  // of the graph so a workspace filter narrows clusters the same way it
  // narrows nodes/edges.
  //
  // Declared BEFORE the edges below because the edge builder now takes the
  // cluster anchors as layout information: they decide the order each
  // relationship's O(n) chain runs in, which is what keeps a chain from
  // linking tabs on opposite sides of the canvas. See relations.ts's
  // buildChainOrder. It does not change which tabs are related.
  const clusterTree = useMemo(
    () => buildClusterTree(scopedTabs, allSections, allCollections),
    [scopedTabs, allSections, allCollections]
  )
  const clusterAnchors = useMemo(() => computeClusterAnchors(clusterTree), [clusterTree])

  const allEdges = useMemo(
    () =>
      buildGraphEdges(
        scopedTabs,
        workspaceLookup,
        graphState.settings.filters,
        graphState.manualConnections,
        allSections,
        (tabId) => clusterAnchors.get(tabId)?.categoryAnchor ?? undefined
      ),
    [
      scopedTabs,
      workspaceLookup,
      graphState.settings.filters,
      graphState.manualConnections,
      allSections,
      clusterAnchors,
    ]
  )

  /**
   * Whether the persisted positions are the FINISHED layout for exactly this
   * graph — written by the pre-open settle (app-shell.tsx) and compared
   * against what is about to be drawn. Computed once per mount, not per
   * render, and deliberately from the FIRST cluster tree/node set this view
   * saw: it answers "may the canvas open static", which is a question about
   * the initial mount only. Anything the user changes from here on (a
   * filter, a deleted tab) re-runs the canvas's physics normally.
   */
  const [layoutSettled] = useState(
    () =>
      Boolean(graphState.layoutKey) &&
      graphState.layoutKey ===
        computeLayoutKey(
          clusterTree,
          allNodes.map((n) => n.id),
          graphState.settings
        )
  )

  const allDependencyEdges = useMemo(
    () => (graphState.settings.filters.dependencies ? buildDependencyEdges(scopedTabs, dependencies) : []),
    [scopedTabs, dependencies, graphState.settings.filters.dependencies]
  )

  // Dependency edges count toward local-graph reachability alongside every
  // other relationship — a "local graph" centered on a tab should include
  // what it depends on (and what depends on it), not just its non-directional
  // relationships.
  const bfsEdges = useMemo<GraphEdge[]>(
    () => [
      ...allEdges,
      ...allDependencyEdges.map((e) => ({ id: e.id, source: e.parentTabId, target: e.childTabId, reasons: [] })),
    ],
    [allEdges, allDependencyEdges]
  )

  const view = graphState.settings.view
  const selectedTabId = graphState.settings.selectedTabId
  const centerTabId = view === "local" ? selectedTabId : null
  const hasCenter = Boolean(centerTabId && nodeById.has(centerTabId))

  /**
   * The agent work layer.
   *
   * Reads the agent store the shell mounted, which the observer feeds — this
   * view owns no polling and makes no request of its own. It is also strictly
   * a reader: nothing here can change a run, a status or a relationship.
   */
  const agentTabBounds = useMemo(() => {
    const points = Object.values(graphState.positions)
    if (points.length === 0) return null
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const point of points) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
    return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null
  }, [graphState.positions])

  /**
   * Connector state, read-only.
   *
   * No `restore` here: AppShell owns that, because the manager outlives any
   * one view and a connector the user enabled must not stay dormant until
   * they happen to open the graph. This view reads the same singleton, so it
   * and the settings panel can never disagree about what is connected.
   */
  const connectors = useAgentConnectors()

  /**
   * The connector strip's view models.
   *
   * Only what the user has actually enabled: a provider they have never
   * connected is not a row in the workspace sidebar, it is an option in
   * settings. Status words come from the connector layer rather than being
   * re-derived here, so the sidebar and the settings page can never disagree
   * about what state something is in.
   */
  const agentPanelConnectors = useMemo(
    () =>
      connectors.connectors
        .filter((view) => view.enabled)
        .map((view) => ({
          provider: view.descriptor.provider,
          displayName: view.descriptor.displayName,
          statusLabel: CONNECTOR_STATUS_LABELS[view.status.kind],
          connected: view.status.kind === "connected",
          // Carried raw as well as resolved, so the strip can draw the
          // provider's mark in the state its connector is in. The word stays
          // the connector layer's to decide.
          statusKind: view.status.kind,
        })),
    [connectors.connectors]
  )

  /**
   * Connected providers that could appear in the world as idle stand-ins.
   *
   * Connected ones only. The dedicated Agent World view draws the whole
   * roster, connected or not, because it is the surface someone opens to find
   * out what the feature is; this is a small window onto work in progress
   * beside the canvas, and filling it with agents that are not running would
   * crowd out the one that is. Both go through `buildWorldRoster`, so the two
   * surfaces cannot disagree about a provider's name or status.
   */
  const idleWorldProviders = useMemo(
    () => buildWorldRoster(connectors.connectors),
    [connectors.connectors]
  )

  /** Provider id → display name, for the provider filter. Built from the catalogue, not hard-coded. */
  const providerLabels = useMemo(() => {
    const labels: Record<string, string> = {}
    for (const view of connectors.connectors) {
      labels[view.descriptor.provider] = view.descriptor.displayName
    }
    return labels
  }, [connectors.connectors])

  const agentSpatial = useAgentSpatial({
    state: agentStore.state,
    workspaceId: store.currentId,
    tabBounds: agentTabBounds,
  })

  /**
   * The Phase 16 derived intelligence layer.
   *
   * Reads the same store the spatial layer does and owns no state of its own —
   * it groups the domain once per state object so the inspector, the canvas
   * and the search box share one traversal rather than each doing their own.
   */
  const agentIntelligence = useAgentIntelligence({
    state: agentStore.state,
    workspaceId: store.currentId,
    selectedId: agentSpatial.selectedId,
  })

  const agentLayer = useMemo(
    () => ({
      scene: agentSpatial.scene,
      positions: agentSpatial.positions,
      emphasized: agentSpatial.emphasized,
      selectedId: agentSpatial.selectedId,
      /** Objects the selected run touches, so the canvas can emphasise them. */
      highlighted: agentIntelligence.highlighted,
    }),
    [
      agentSpatial.scene,
      agentSpatial.positions,
      agentSpatial.emphasized,
      agentSpatial.selectedId,
      agentIntelligence.highlighted,
    ]
  )

  /** Tab titles for the inspector, so it can name a run's context tabs without importing the tab store. */
  const agentTabTitles = useMemo(() => {
    const titles = new Map<string, string>()
    for (const workspace of store.workspaces) {
      for (const tab of workspace.tabs) {
        titles.set(tab.id, tab.title?.trim() || tab.domain)
      }
    }
    return titles
  }, [store.workspaces])

  /**
   * The Agent World.
   *
   * Reads the same memoised index the inspector and the canvas do, so opening
   * the world costs a scene derivation and not a second traversal of the
   * domain. It is built whether or not the world is on screen — the build is
   * a pure `useMemo` over state that is already in hand, and gating it behind
   * `worldOpen` would only move the work to the moment the user clicks.
   */
  const agentWorld = useAgentWorld({
    index: agentIntelligence.index,
    workspaceId: store.currentId,
    tabTitles: agentTabTitles,
    idleProviders: idleWorldProviders,
  })

  const [worldOpen, setWorldOpen] = useState(false)

  /**
   * What is running right now, for the sidebar's NOW section.
   *
   * Derived from the world's own characters rather than from the runs
   * directly, so the list and the room cannot disagree about what state an
   * agent is in — there is one derivation, and both read it. Filtered to the
   * states that mean something is happening: a finished run belongs in the
   * history the panel already shows, not in a list headed "now".
   */
  const agentActivity = useMemo<AgentActivityItem[]>(
    () =>
      agentWorld.scene.characters
        .filter((character) => character.runId && LIVE_ACTIVITY_STATES.has(character.state))
        .map((character) => ({
          id: runSpatialId(character.runId!),
          provider: character.provider,
          agentName: character.agentName,
          state: character.state,
          activity: character.activity,
          progress: character.progress,
        })),
    [agentWorld.scene.characters]
  )

  /**
   * Detail for the character the world has open.
   *
   * A callback rather than a prepared map: the world asks for the one
   * character that is selected, so this runs for one run rather than for
   * twenty. Everything it returns is already-sanitised domain state reached
   * through the index.
   */
  const worldDetail = useCallback(
    (characterId: string): WorldCharacterDetail | null => {
      const character = agentWorld.scene.characters.find((entry) => entry.id === characterId)
      if (!character?.runId) return null
      const runId = character.runId
      const index = agentIntelligence.index

      return {
        // Newest first — the domain stores events oldest-first and caps them
        // at 200, so this is a reverse of a bounded array.
        events: [...agentStore.state.events]
          .filter((event) => event.runId === runId)
          .reverse()
          .slice(0, 8),
        files: (index.artifactLinksByRun.get(runId) ?? []).flatMap((link) => {
          const artifact = index.artifactsById.get(link.artifactId)
          // `relativePath` only. `projectPath` is an absolute local path and
          // never leaves the domain — see intelligence/types.ts.
          return artifact
            ? [{ artifactId: artifact.id, relativePath: artifact.relativePath, role: link.role }]
            : []
        }),
        workItems: (index.workItemsByRun.get(runId) ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
        })),
        handoffs: handoffsForCharacter(agentWorld.scene, characterId),
      }
    },
    [agentWorld.scene, agentIntelligence.index, agentStore.state.events]
  )

  const agentInspection = useMemo(
    () =>
      buildInspectorSelection({
        state: agentStore.state,
        scene: agentSpatial.scene,
        selectedId: agentSpatial.selectedId,
        tabTitles: agentTabTitles,
        intelligence: agentIntelligence.index,
      }),
    [
      agentStore.state,
      agentSpatial.scene,
      agentSpatial.selectedId,
      agentTabTitles,
      agentIntelligence.index,
    ]
  )

  /**
   * Agent search results.
   *
   * Scoped to the current scene, which means they inherit the active filter
   * and the current workspace — a result always corresponds to something the
   * user can then be shown.
   */
  const agentSearchResults = useMemo(
    () =>
      searchAgentWork(
        agentSpatial.scene,
        {
          artifacts: agentStore.state.artifacts,
          artifactLinks: agentStore.state.artifactLinks,
          workspaceId: store.currentId,
          visibleRunIds: new Set(
            agentSpatial.scene.nodes.filter((n) => n.kind === "run").map((n) => n.runId)
          ),
        },
        query
      ),
    [agentSpatial.scene, agentStore.state.artifacts, agentStore.state.artifactLinks, store.currentId, query]
  )

  const workspaceAgentRunCount = useMemo(
    () => agentStore.state.runs.filter((run) => run.workspaceId === store.currentId).length,
    [agentStore.state.runs, store.currentId]
  )

  /** What the world is called when the user has not named it themselves. */
  const currentWorkspaceName = useMemo(
    () => store.workspaces.find((workspace) => workspace.id === store.currentId)?.name ?? null,
    [store.workspaces, store.currentId]
  )

  /**
   * Selecting a search result.
   *
   * Selects the entity and focuses its spatial node, reusing the canvas's
   * existing focus mechanism rather than introducing a second viewport
   * controller. Purely presentational — nothing about the agent domain
   * changes.
   */
  function handleSelectAgentResult(id: string) {
    agentSpatial.select(id)

    // A work item has no body on the canvas, so "focus it" means focus the run
    // that owns it. Resolved through the scene rather than by parsing the id,
    // so an item whose run is no longer visible focuses nothing instead of
    // sending the camera to a node that is not there.
    const focusId = runIdForWorkItemSelection(agentSpatial.scene, id) ?? id
    const point = agentSpatial.positions.get(focusId)
    if (point) {
      canvasHandleRef.current?.focusPoint(point.x, point.y)
      return
    }

    // A file that the scene has not disclosed yet has no position — selecting
    // it is what discloses it, and that happens on the next render. So focus
    // a run that worked on it instead, which is on screen now. Workspace-
    // scoped, so an identically-named file elsewhere cannot move the camera.
    if (focusId.startsWith("artifact:")) {
      const artifactId = focusId.slice("artifact:".length)
      for (const runId of getRunsTouchingArtifact(
        agentIntelligence.index,
        store.currentId,
        artifactId
      )) {
        const runPoint = agentSpatial.positions.get(runSpatialId(runId))
        if (runPoint) {
          canvasHandleRef.current?.focusPoint(runPoint.x, runPoint.y)
          return
        }
      }
    }
  }

  const { visibleNodes, visibleEdges, visibleDependencyEdges, centerDistances } = useMemo(() => {
    if (hasCenter && centerTabId) {
      const distances = computeLocalDistances(centerTabId, bfsEdges, graphState.settings.depth)
      const ids = new Set(distances.keys())
      return {
        visibleNodes: allNodes.filter((n) => ids.has(n.id)),
        visibleEdges: allEdges.filter((e) => ids.has(e.source) && ids.has(e.target)),
        visibleDependencyEdges: allDependencyEdges.filter((e) => ids.has(e.parentTabId) && ids.has(e.childTabId)),
        centerDistances: distances,
      }
    }
    return { visibleNodes: allNodes, visibleEdges: allEdges, visibleDependencyEdges: allDependencyEdges, centerDistances: undefined }
  }, [hasCenter, centerTabId, allNodes, allEdges, allDependencyEdges, bfsEdges, graphState.settings.depth])

  const searchResults = useMemo(() => searchGraphNodes(allNodes, query), [allNodes, query])
  const searchMatches = useMemo(
    () => (query.trim() ? new Set(searchResults.map((n) => n.id)) : null),
    [query, searchResults]
  )

  const selectedNode = selectedTabId ? (everyNodeById.get(selectedTabId) ?? null) : null
  const notesNode = notesOpenTabId ? (everyNodeById.get(notesOpenTabId) ?? null) : null
  const dependenciesOfSelected = useMemo(
    () => (selectedTabId ? dependenciesOf(selectedTabId, dependencies) : []),
    [selectedTabId, dependencies]
  )
  const usedByOfSelected = useMemo(
    () => (selectedTabId ? usedBy(selectedTabId, dependencies) : []),
    [selectedTabId, dependencies]
  )
  const dependencyTree = useMemo(
    () => (selectedTabId ? buildDependencyTree(selectedTabId, dependencies, validTabIds) : []),
    [selectedTabId, dependencies, validTabIds]
  )

  const selectedCollection = selectedCollectionId
    ? (allCollections.find((c) => c.id === selectedCollectionId) ?? null)
    : null

  // Debounced localStorage write — state itself always updates immediately
  // so the UI (checkboxes, pills, selection) never feels laggy; only the
  // persistence side-effect is throttled, since a fling-scroll can call
  // this several times per second via camera updates.
  useEffect(() => {
    const timer = setTimeout(() => {
      saveGraphState(pruneGraphState(graphState, validTabIds))
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [graphState, validTabIds])

  useEffect(() => {
    return () => {
      if (cameraFlushTimer.current) clearTimeout(cameraFlushTimer.current)
    }
  }, [])

  function updateSettings(patch: Partial<GraphPersistedState["settings"]>) {
    setGraphState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }))
  }

  function handleCameraChange(camera: CameraState) {
    pendingCameraRef.current = camera
    if (cameraFlushTimer.current) return
    cameraFlushTimer.current = setTimeout(() => {
      cameraFlushTimer.current = null
      const nextCamera = pendingCameraRef.current
      if (nextCamera) updateSettings({ camera: nextCamera })
    }, CAMERA_FLUSH_DELAY_MS)
  }

  function handleNodeMoved(id: string, x: number, y: number) {
    setGraphState((prev) => ({ ...prev, positions: { ...prev.positions, [id]: { x, y } } }))
  }

  /**
   * A boundary-square drag moves a whole cluster at once, so its tabs arrive
   * as one batch rather than one call per tab. Alongside each new position it
   * carries how far that tab's cluster territory travelled — without saving
   * that too, the next session would rebuild the territory at its canonical
   * spot and pull the tabs straight back (see GraphPersistedState.boundaryOffsets).
   */
  function handleBoundaryMembersMoved(
    moves: { id: string; x: number; y: number; offset: { x: number; y: number } }[]
  ) {
    if (moves.length === 0) return
    setGraphState((prev) => {
      const positions = { ...prev.positions }
      const boundaryOffsets = { ...prev.boundaryOffsets }
      for (const move of moves) {
        positions[move.id] = { x: move.x, y: move.y }
        boundaryOffsets[move.id] = move.offset
      }
      return { ...prev, positions, boundaryOffsets }
    })
  }

  /**
   * Writes back offsets the engine had to repair on the way in.
   *
   * Saved state from the build that displaced tabs one at a time holds a
   * different offset for different members of the same cluster, which is the
   * record of a cluster torn in half (see boundary-frames.ts). The engine
   * re-unites them in memory on every load; this is what stops that being
   * necessary a second time, so the saved blob converges on a coherent state
   * instead of carrying the corruption forever.
   *
   * A MERGE, never a replace: only the tabs actually repaired appear here.
   * Tabs filtered out of the current view (Local mode, a workspace filter)
   * still exist and keep whatever they had, and positions, manual connections
   * and settings are not touched at all.
   */
  function handleBoundaryOffsetsNormalized(offsets: Record<string, { x: number; y: number }>) {
    const ids = Object.keys(offsets)
    if (ids.length === 0) return
    setGraphState((prev) => {
      const boundaryOffsets = { ...prev.boundaryOffsets }
      let changed = false
      for (const id of ids) {
        const next = offsets[id]
        const current = boundaryOffsets[id]
        if (current && current.x === next.x && current.y === next.y) continue
        boundaryOffsets[id] = next
        changed = true
      }
      return changed ? { ...prev, boundaryOffsets } : prev
    })
  }

  function handleSelectResult(id: string) {
    setQuery("")
    updateSettings({ selectedTabId: id })
    canvasHandleRef.current?.centerOnNode(id)
  }

  function handleFiltersChange(filters: ConnectionFilters) {
    updateSettings({ filters })
  }

  function handleDisplayChange(display: GraphDisplaySettings) {
    updateSettings({ display })
  }

  function handleViewChange(view: GraphViewMode) {
    updateSettings({ view })
  }

  function handleDepthChange(depth: GraphDepth) {
    updateSettings({ depth })
  }

  function handleWorkspaceFilterChange(workspaceFilter: string | "all") {
    updateSettings({ workspaceFilter })
  }

  function handleFit() {
    canvasHandleRef.current?.fitToView()
  }

  function closeMenus() {
    setContextMenu(null)
    setEdgePopover(null)
  }

  function findTabWorkspace(tabId: string) {
    return store.workspaces.find((w) => w.tabs.some((t) => t.id === tabId))
  }

  // Same tab.notes field, same updateWorkspaceTabs/onStoreUpdate path
  // WorkspaceView's handleNotesChange uses for TabNotesButton — the Graph
  // view is just another UI entry point onto it, not a second notes store.
  function handleNotesChange(tabId: string, notes: string) {
    const workspace = findTabWorkspace(tabId)
    if (!workspace) return
    const trimmed = notes.trim()
    const next = updateWorkspaceTabs(
      store,
      workspace.id,
      workspace.tabs.map((t) => (t.id === tabId ? { ...t, notes: trimmed || undefined } : t))
    )
    onStoreUpdate(next)
  }

  function handleOpenNotes(tabId: string) {
    setNotesOpenTabId(tabId)
  }

  function handleToggleFavorite(tabId: string) {
    const workspace = findTabWorkspace(tabId)
    if (!workspace) return
    const next = updateWorkspaceTabs(
      store,
      workspace.id,
      workspace.tabs.map((t) => (t.id === tabId ? { ...t, isFavorite: !t.isFavorite } : t))
    )
    onStoreUpdate(next)
  }

  // Batches a lastAccessedAt update across every workspace in one
  // onStoreUpdate call — used for both a single open and a bulk "open all in
  // collection" so opening N tabs at once causes one re-render, not N.
  function markAccessed(ids: string[]) {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const now = Date.now()
    const workspaces = store.workspaces.map((w) => {
      let changed = false
      const tabs = w.tabs.map((t) => {
        if (!idSet.has(t.id)) return t
        changed = true
        return { ...t, lastAccessedAt: now }
      })
      return changed ? { ...w, tabs, updatedAt: now } : w
    })
    onStoreUpdate({ ...store, workspaces })
  }

  // The one place a tab actually being opened from the Graph is recorded —
  // double-click, the sidebar dependency panel's "Open", and the context
  // menu's Open/Open in new tab all funnel through this, mirroring
  // WorkspaceView's handleOpenTab. Never fires from hover (see
  // GraphCanvas's onHoverChange) or from a node simply being rendered.
  function handleOpenTab(tabId: string, opts?: { newTab?: boolean }) {
    const node = everyNodeById.get(tabId)
    if (!node) return
    openTab(node.tab.url, opts)
    markAccessed([tabId])
  }

  function handleRemoveTab(tabId: string) {
    const workspace = findTabWorkspace(tabId)
    if (!workspace) return
    const next = updateWorkspaceTabs(store, workspace.id, removeTabs(workspace.tabs, [tabId]))
    onStoreUpdate(next)
    if (selectedTabId === tabId) updateSettings({ selectedTabId: null })
    toast.success("Removed from workspace")
  }

  function handleMoveToWorkspace(tabId: string, targetWorkspaceId: string) {
    const result = moveTabsBetweenWorkspaces(store, [tabId], targetWorkspaceId)
    if (result.moved.length === 0) return
    onStoreUpdate(result.store)
    const target = store.workspaces.find((w) => w.id === targetWorkspaceId)
    toast.success(`Moved to ${target?.name ?? "workspace"}`)
  }

  function handleAddManualLink(a: string, b: string) {
    if (a === b) return
    const exists = graphState.manualConnections.some(
      (c) => (c.a === a && c.b === b) || (c.a === b && c.b === a)
    )
    if (exists) {
      toast.info("Already linked")
      return
    }
    // Clock read here, at the mutation, rather than inside the updater React
    // may evaluate more than once — the link's createdAt is persisted graph
    // state, so a discarded second reading would be a real (if small) lie.
    const createdAt = createTimestamp()
    setGraphState((prev) => ({
      ...prev,
      manualConnections: [...prev.manualConnections, { a, b, createdAt }],
    }))
    toast.success("Tabs linked")
  }

  function handleRemoveManualLink(edge: GraphEdge) {
    setGraphState((prev) => ({
      ...prev,
      manualConnections: prev.manualConnections.filter(
        (c) => !((c.a === edge.source && c.b === edge.target) || (c.a === edge.target && c.b === edge.source))
      ),
    }))
    setEdgePopover(null)
    toast.success("Manual link removed")
  }

  function handleAddDependency(parentTabId: string, childTabId: string, type: DependencyType | undefined) {
    const validation = validateDependency(dependencies, parentTabId, childTabId)
    if (!validation.ok) {
      toast.info(validation.reason === "self" ? "A tab can't depend on itself" : "Already a dependency")
      return
    }
    storeAddDependency(parentTabId, childTabId, type)
    toast.success("Dependency added")
  }

  function handleRemoveDependency(depId: string) {
    storeRemoveDependency(depId)
    setEdgePopover((prev) => (prev?.kind === "dependency" && prev.edge.id === depId ? null : prev))
    toast.success("Dependency removed")
  }

  function handleChangeDependencyType(depId: string, type: DependencyType | undefined) {
    storeUpdateDependencyType(depId, type)
  }

  function handleSelectTab(id: string) {
    updateSettings({ selectedTabId: id })
    canvasHandleRef.current?.centerOnNode(id)
  }

  function handleSelectCollection(id: string | null) {
    setSelectedCollectionId(id)
    if (id) updateSettings({ selectedTabId: null })
  }

  function handleSelectCluster(id: string | null) {
    setSelectedClusterId(id)
    if (id) updateSettings({ selectedTabId: null })
  }

  function handleShowClusterBoundariesChange(showClusterBoundaries: boolean) {
    updateSettings({ showClusterBoundaries })
  }

  function handleAddNodeToCollection(tabId: string, collectionId: string) {
    const collection = allCollections.find((c) => c.id === collectionId)
    if (!collection) return
    const tabWorkspaceId = workspaceLookup.get(tabId)?.id
    const validation = validateAddTabToCollection(allCollections, collectionId, tabId, tabWorkspaceId)
    if (!validation.ok) {
      if (validation.reason !== "duplicate") toast.error("Couldn't add that tab to the collection")
      return
    }
    addTabToCollectionStore(collectionId, tabId)
    toast.success(`Added to ${collection.name}`)
  }

  function handleGatherNewCollectionForNode(tabId: string) {
    const workspaceId = workspaceLookup.get(tabId)?.id
    if (!workspaceId) return
    setGatherDialogState({ workspaceId, tabIds: [tabId] })
  }

  function handleGatherConfirm(name: string) {
    if (!gatherDialogState) return
    const collection = createCollectionStore(gatherDialogState.workspaceId, name, gatherDialogState.tabIds)
    toast.success(
      gatherDialogState.tabIds.length > 0 ? `Gathered into "${name}"` : `Created "${name}"`
    )
    setGatherDialogState(null)
    setSelectedCollectionId(collection.id)
    updateSettings({ selectedTabId: null })
  }

  function handleRenameCollectionConfirm(name: string) {
    if (renameCollectionId) renameCollectionStore(renameCollectionId, name)
    setRenameCollectionId(null)
  }

  function handleDeleteCollectionConfirm() {
    if (deleteCollectionId) {
      deleteCollectionStore(deleteCollectionId)
      if (selectedCollectionId === deleteCollectionId) setSelectedCollectionId(null)
      toast.success("Collection deleted")
    }
    setDeleteCollectionId(null)
  }

  function handleOpenAllInSelectedCollection() {
    if (!selectedCollection) return
    for (const tabId of selectedCollection.tabIds) {
      const node = everyNodeById.get(tabId)
      if (node) openTab(node.tab.url, { newTab: true })
    }
    markAccessed(selectedCollection.tabIds)
  }

  function handleFocusCollection() {
    if (selectedCollectionId) canvasHandleRef.current?.focusCollection(selectedCollectionId)
  }

  const renameCollectionTarget = renameCollectionId
    ? (allCollections.find((c) => c.id === renameCollectionId) ?? null)
    : null
  const deleteCollectionTarget = deleteCollectionId
    ? (allCollections.find((c) => c.id === deleteCollectionId) ?? null)
    : null

  const contextNode = contextMenu?.node
  const otherWorkspaces = contextNode
    ? store.workspaces
        .filter((w) => w.id !== workspaceLookup.get(contextNode.id)?.id)
        .map((w) => ({ id: w.id, name: w.name }))
    : []
  const contextNodeDependencyCount = contextNode
    ? (() => {
        const counts = countsFor(contextNode.id, dependencies)
        return counts.dependencies + counts.usedBy
      })()
    : 0
  const contextNodeCollections = contextNode
    ? getCollectionsForWorkspace(allCollections, workspaceLookup.get(contextNode.id)?.id ?? "").map((c) => ({
        id: c.id,
        name: c.name,
      }))
    : []

  // Dependency mode deliberately ignores the graph's workspace filter — a
  // tab can depend on a resource living in a different workspace, so the
  // picker searches every tab, not just the ones currently on screen.
  // Manual "link to…" keeps its original scoped-to-visible-nodes behavior.
  const linkDialogSourceNode = linkDialog
    ? ((linkDialog.mode === "dependency" ? everyNodeById : nodeById).get(linkDialog.tabId) ?? null)
    : null
  const linkDialogCandidates = useMemo(() => {
    if (!linkDialog) return []
    const pool = linkDialog.mode === "dependency" ? everyNode : allNodes
    return pool.filter((n) => n.id !== linkDialog.tabId)
  }, [linkDialog, allNodes, everyNode])
  const linkDialogExistingTargetIds = useMemo(() => {
    if (!linkDialog || linkDialog.mode !== "dependency") return undefined
    return new Set(dependenciesOf(linkDialog.tabId, dependencies).map((d) => d.childTabId))
  }, [linkDialog, dependencies])

  const totalTabCount = store.workspaces.reduce((sum, w) => sum + w.tabs.length, 0)

  let emptyState: { title: string; description: string } | null = null
  if (scopedTabs.length === 0) {
    emptyState = {
      title: "No tabs to visualize yet.",
      description: "Import some tabs into TabDump to build your graph.",
    }
  } else if (scopedTabs.length === 1) {
    emptyState = {
      title: "Not enough connections yet.",
      description: "Add more tabs to start building your graph.",
    }
  } else if (view === "local" && !hasCenter) {
    emptyState = {
      title: "Select a tab to see its local graph.",
      description: "Click any node, or search for one, to center the graph on it.",
    }
  } else if (view === "local" && visibleNodes.length === 1) {
    emptyState = {
      title: "This tab isn't connected to anything yet.",
      description: "Try a different depth, or enable more connection types in the sidebar.",
    }
  } else if (visibleEdges.length === 0 && visibleDependencyEdges.length === 0) {
    emptyState = {
      title: "No connections match the current filters.",
      description: "Adjust your graph filters in the sidebar.",
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <IconButton aria-label="Back to workspace" tooltip="Back to workspace" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <div className="hidden items-center gap-1.5 rounded-lg border border-subtle bg-popover/90 px-2.5 py-1 text-label text-tertiary shadow-sm backdrop-blur-sm sm:flex">
          <Waypoints className="size-3.5" />
          Graph
          <span aria-hidden>·</span>
          <span className="text-meta">
            {visibleNodes.length}/{totalTabCount}
          </span>
        </div>
      </div>

      {emptyState ? (
        <div className="flex h-full items-center justify-center">
          <EmptyState icon={Waypoints} title={emptyState.title} description={emptyState.description} />
        </div>
      ) : (
        <GraphCanvas
          ref={canvasHandleRef}
          nodes={visibleNodes}
          edges={visibleEdges}
          dependencyEdges={visibleDependencyEdges}
          positions={graphState.positions}
          boundaryOffsets={graphState.boundaryOffsets}
          layoutSettled={layoutSettled}
          initialCamera={graphState.settings.camera}
          display={graphState.settings.display}
          selectedTabId={selectedTabId}
          centerTabId={centerTabId}
          centerDistances={centerDistances}
          searchMatches={searchMatches}
          collections={allCollections}
          selectedCollectionId={selectedCollectionId}
          clusterTree={clusterTree}
          clusterAnchors={clusterAnchors}
          selectedClusterId={selectedClusterId}
          onSelectCluster={handleSelectCluster}
          showClusterBoundaries={graphState.settings.showClusterBoundaries}
          onCameraChange={handleCameraChange}
          onSelectNode={(id) => updateSettings({ selectedTabId: id })}
          onSelectCollection={handleSelectCollection}
          onOpenNode={(node) => handleOpenTab(node.id)}
          onContextMenu={(node, x, y) => {
            closeMenus()
            setContextMenu({ node, x, y })
          }}
          onEdgeClick={(edge, x, y) => {
            const source = nodeById.get(edge.source)
            const target = nodeById.get(edge.target)
            if (!source || !target) return
            closeMenus()
            setEdgePopover({ kind: "relation", edge, source, target, x, y })
          }}
          onDependencyEdgeClick={(edge, x, y) => {
            const source = everyNodeById.get(edge.parentTabId)
            const target = everyNodeById.get(edge.childTabId)
            if (!source || !target) return
            const pairKey = edgeKey(edge.parentTabId, edge.childTabId)
            const otherReasons = allEdges.find((e) => e.id === pairKey)?.reasons ?? []
            closeMenus()
            setEdgePopover({ kind: "dependency", edge, source, target, otherReasons, x, y })
          }}
          onNodeMoved={handleNodeMoved}
          onBoundaryMembersMoved={handleBoundaryMembersMoved}
          onBoundaryOffsetsNormalized={handleBoundaryOffsetsNormalized}
          onHoverChange={setHover}
          onSelectedNodeScreenChange={setSelectedNodeScreen}
          agentLayer={agentLayer}
          onSelectAgentNode={agentSpatial.select}
          onAgentNodeMoved={(id, x, y) => agentSpatial.moveNode(id, { x, y })}
        />
      )}

      {!emptyState && (
        <GraphNodeTooltip
          hover={hover}
          selected={selectedNodeScreen}
          onOpenNotes={handleOpenNotes}
          onToggleFavorite={handleToggleFavorite}
          onOpenTab={handleOpenTab}
        />
      )}
      {!emptyState && <GraphControls onZoomIn={() => canvasHandleRef.current?.zoomBy(1.3)} onZoomOut={() => canvasHandleRef.current?.zoomBy(1 / 1.3)} onFit={handleFit} />}

      {/*
        The world, as a panel over the canvas rather than a route of its own.
        Deliberately not a full-screen view: the point of watching agents work
        is to watch them work *on the workspace you are looking at*, and
        sending someone to a separate screen to do it would break the
        connection the feature exists to draw.

        Mounted only while open, so a closed world costs nothing — no elements,
        no animations, no observer. That is also what §34's "must not keep
        processing when hidden" amounts to here: there is nothing to keep
        processing, because there is nothing mounted.
      */}
      {worldOpen && agentWorld.effective.enabled && (
        // Full width and above the sidebar on a narrow screen, a panel beside
        // it on a wide one. The z-index is deliberate rather than incidental:
        // the sidebar also sits at z-10, and someone who has just pressed
        // "Agent World" on a phone should get the world, not a panel hidden
        // behind the controls they opened it from.
        <div className="absolute inset-x-2 bottom-2 z-20 rounded-xl border border-subtle bg-popover/95 p-3 shadow-lg backdrop-blur-sm duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0 slide-in-from-bottom-2 sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-[32rem]">
          <AgentWorld
            scene={agentWorld.scene}
            settings={agentWorld.effective}
            worldName={agentWorld.worldName ?? currentWorkspaceName}
            now={agentWorld.now}
            selectedId={agentWorld.selectedId}
            onSelect={agentWorld.select}
            details={worldDetail}
            // Wider than it is tall, unlike the dedicated view's. This panel
            // sits over a canvas someone is reading, so it takes a strip
            // rather than the screen; the camera is what gets them a closer
            // look without the panel growing to provide one.
            stageClassName="aspect-[4/3] sm:aspect-[10/7]"
            actions={
              <button
                type="button"
                onClick={() => setWorldOpen(false)}
                className="shrink-0 rounded-md border border-subtle px-2 py-0.5 text-meta text-muted-foreground transition-colors duration-(--duration-fast) hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Close
              </button>
            }
          />
        </div>
      )}

      <GraphSidebar
        open={graphState.settings.sidebarOpen}
        onToggle={() => updateSettings({ sidebarOpen: !graphState.settings.sidebarOpen })}
        query={query}
        onQueryChange={setQuery}
        searchResults={searchResults}
        onSelectResult={handleSelectResult}
        view={view}
        onViewChange={handleViewChange}
        depth={graphState.settings.depth}
        onDepthChange={handleDepthChange}
        filters={graphState.settings.filters}
        onFiltersChange={handleFiltersChange}
        display={graphState.settings.display}
        onDisplayChange={handleDisplayChange}
        showClusterBoundaries={graphState.settings.showClusterBoundaries}
        onShowClusterBoundariesChange={handleShowClusterBoundariesChange}
        workspaces={store.workspaces.map((w) => ({ id: w.id, name: w.name }))}
        workspaceFilter={graphState.settings.workspaceFilter}
        onWorkspaceFilterChange={handleWorkspaceFilterChange}
        onFit={handleFit}
        agentPanel={
          <GraphAgentPanel
            available={agentSessionsAvailable}
            filter={agentSpatial.filter}
            onFilterChange={agentSpatial.setFilter}
            connectors={agentPanelConnectors}
            providers={agentSpatial.providers}
            providerFilter={agentSpatial.providerFilter}
            onProviderFilterChange={agentSpatial.setProviderFilter}
            providerLabels={providerLabels}
            selection={agentInspection}
            hiddenRunCount={agentSpatial.hiddenRunCount}
            hasAnyAgentData={workspaceAgentRunCount > 0}
            hasVisibleRuns={agentSpatial.scene.nodes.some((node) => node.kind === "run")}
            searchQuery={query}
            searchResults={agentSearchResults}
            onSelectResult={handleSelectAgentResult}
            onSelectRun={(runId) => agentSpatial.select(`run:${runId}`)}
            activity={agentActivity}
            selectedActivityId={agentSpatial.selectedId}
            // The entry point exists only when the user has the world turned
            // on. A button that opened a feature someone had disabled would be
            // a setting the product did not honour.
            onOpenWorld={agentWorld.effective.enabled ? () => setWorldOpen(true) : undefined}
          />
        }
        selectedNode={selectedNode}
        dependenciesOfSelected={dependenciesOfSelected}
        usedByOfSelected={usedByOfSelected}
        dependencyTree={dependencyTree}
        allNodeById={everyNodeById}
        onSelectTab={handleSelectTab}
        onOpenTab={handleOpenTab}
        onAddDependency={() => selectedTabId && setLinkDialog({ mode: "dependency", tabId: selectedTabId })}
        onRemoveDependency={handleRemoveDependency}
        onChangeDependencyType={handleChangeDependencyType}
        onOpenNotes={handleOpenNotes}
        selectedCollection={selectedCollection}
        onFocusCollection={handleFocusCollection}
        onRenameCollection={() => selectedCollectionId && setRenameCollectionId(selectedCollectionId)}
        onOpenAllInCollection={handleOpenAllInSelectedCollection}
        onDeleteCollection={() => selectedCollectionId && setDeleteCollectionId(selectedCollectionId)}
      />

      <GraphContextMenu
        state={contextMenu}
        otherWorkspaces={otherWorkspaces}
        dependencyCount={contextNodeDependencyCount}
        collections={contextNodeCollections}
        hasNotes={Boolean(contextNode?.tab.notes?.trim())}
        isFavorite={contextNode?.tab.isFavorite === true}
        onOpenNotes={() => {
          if (contextNode) handleOpenNotes(contextNode.id)
          setContextMenu(null)
        }}
        onToggleFavorite={() => {
          if (contextNode) handleToggleFavorite(contextNode.id)
          setContextMenu(null)
        }}
        onAddToCollection={(collectionId) => {
          if (contextNode) handleAddNodeToCollection(contextNode.id, collectionId)
          setContextMenu(null)
        }}
        onGatherNewCollection={() => {
          if (contextNode) handleGatherNewCollectionForNode(contextNode.id)
          setContextMenu(null)
        }}
        onOpenTab={() => {
          if (contextNode) handleOpenTab(contextNode.id)
          setContextMenu(null)
        }}
        onOpenNewTab={() => {
          if (contextNode) handleOpenTab(contextNode.id, { newTab: true })
          setContextMenu(null)
        }}
        onCopyUrl={async () => {
          if (contextNode && (await copyText(contextNode.tab.url))) toast.success("URL copied")
          setContextMenu(null)
        }}
        onCopyCleanUrl={async () => {
          if (contextNode && (await copyText(contextNode.tab.normalizedUrl))) toast.success("Clean URL copied")
          setContextMenu(null)
        }}
        onMoveToWorkspace={(workspaceId) => {
          if (contextNode) handleMoveToWorkspace(contextNode.id, workspaceId)
          setContextMenu(null)
        }}
        onLinkTo={() => {
          if (contextNode) setLinkDialog({ mode: "link", tabId: contextNode.id })
          setContextMenu(null)
        }}
        onAddDependency={() => {
          if (contextNode) setLinkDialog({ mode: "dependency", tabId: contextNode.id })
          setContextMenu(null)
        }}
        onViewDependencies={() => {
          if (contextNode) updateSettings({ selectedTabId: contextNode.id, sidebarOpen: true })
          setContextMenu(null)
        }}
        onRemove={() => {
          if (contextNode) handleRemoveTab(contextNode.id)
          setContextMenu(null)
        }}
        onClose={() => setContextMenu(null)}
      />

      <GraphEdgePopover
        state={edgePopover}
        onClose={() => setEdgePopover(null)}
        onRemoveManualLink={() => {
          if (edgePopover?.kind === "relation") handleRemoveManualLink(edgePopover.edge)
        }}
        onRemoveDependency={() => {
          if (edgePopover?.kind === "dependency") handleRemoveDependency(edgePopover.edge.id)
        }}
      />

      {notesOpenTabId && notesNode && (
        <GraphNodeNotesView
          key={notesOpenTabId}
          node={notesNode}
          onNotesChange={handleNotesChange}
          onClose={() => setNotesOpenTabId(null)}
        />
      )}

      <GraphLinkDialog
        open={linkDialog !== null}
        onOpenChange={(open) => {
          if (!open) setLinkDialog(null)
        }}
        mode={linkDialog?.mode ?? "link"}
        sourceNode={linkDialogSourceNode}
        candidates={linkDialogCandidates}
        existingDependencyTargetIds={linkDialogExistingTargetIds}
        onLink={(targetId) => {
          if (linkDialog) handleAddManualLink(linkDialog.tabId, targetId)
        }}
        onAddDependency={(targetId, type) => {
          if (linkDialog) handleAddDependency(linkDialog.tabId, targetId, type)
        }}
      />

      <GatherDialog
        open={gatherDialogState !== null}
        onOpenChange={(open) => {
          if (!open) setGatherDialogState(null)
        }}
        tabCount={gatherDialogState?.tabIds.length ?? 0}
        onConfirm={handleGatherConfirm}
      />

      {renameCollectionTarget && (
        <RenameCollectionDialog
          key={renameCollectionTarget.id}
          open={renameCollectionId !== null}
          onOpenChange={(open) => {
            if (!open) setRenameCollectionId(null)
          }}
          currentName={renameCollectionTarget.name}
          onRename={handleRenameCollectionConfirm}
        />
      )}

      {deleteCollectionTarget && (
        <DeleteCollectionDialog
          open={deleteCollectionId !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteCollectionId(null)
          }}
          collectionName={deleteCollectionTarget.name}
          tabCount={deleteCollectionTarget.tabIds.length}
          onConfirm={handleDeleteCollectionConfirm}
        />
      )}
    </div>
  )
}
