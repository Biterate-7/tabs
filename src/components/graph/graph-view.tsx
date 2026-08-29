"use client"

import { useEffect, useMemo, useRef, useState } from "react"
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
import { GraphLinkDialog, type GraphLinkDialogMode } from "./graph-link-dialog"
import { buildDependencyEdges, buildGraphEdges, buildGraphNodes, buildWorkspaceLookup, edgeKey } from "@/lib/graph/relations"
import { computeLocalDistances } from "@/lib/graph/local-graph"
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

const CAMERA_FLUSH_DELAY_MS = 200
const SAVE_DEBOUNCE_MS = 400

type LinkDialogState = { mode: GraphLinkDialogMode; tabId: string } | null

export function GraphView({
  store,
  onStoreUpdate,
  onClose,
}: {
  store: WorkspaceStore
  onStoreUpdate: (store: WorkspaceStore) => void
  onClose: () => void
}) {
  const canvasHandleRef = useRef<GraphCanvasHandle>(null)
  const [graphState, setGraphState] = useState<GraphPersistedState>(() => {
    if (typeof window === "undefined") return defaultGraphState()
    const validIds = new Set(store.workspaces.flatMap((w) => w.tabs.map((t) => t.id)))
    return pruneGraphState(loadGraphState(), validIds)
  })
  const [query, setQuery] = useState("")
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState | null>(null)
  const [edgePopover, setEdgePopover] = useState<GraphEdgePopoverState | null>(null)
  const [linkDialog, setLinkDialog] = useState<LinkDialogState>(null)

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

  const allEdges = useMemo(
    () => buildGraphEdges(scopedTabs, workspaceLookup, graphState.settings.filters, graphState.manualConnections),
    [scopedTabs, workspaceLookup, graphState.settings.filters, graphState.manualConnections]
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
    setGraphState((prev) => ({
      ...prev,
      manualConnections: [...prev.manualConnections, { a, b, createdAt: Date.now() }],
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

  function handleOpenTabById(id: string) {
    const node = everyNodeById.get(id)
    if (node) openTab(node.tab.url)
  }

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
          initialCamera={graphState.settings.camera}
          display={graphState.settings.display}
          selectedTabId={selectedTabId}
          centerTabId={centerTabId}
          centerDistances={centerDistances}
          searchMatches={searchMatches}
          onCameraChange={handleCameraChange}
          onSelectNode={(id) => updateSettings({ selectedTabId: id })}
          onOpenNode={(node) => openTab(node.tab.url)}
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
          onHoverChange={setHover}
        />
      )}

      {!emptyState && <GraphNodeTooltip hover={hover} />}
      {!emptyState && <GraphControls onZoomIn={() => canvasHandleRef.current?.zoomBy(1.3)} onZoomOut={() => canvasHandleRef.current?.zoomBy(1 / 1.3)} onFit={handleFit} />}

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
        workspaces={store.workspaces.map((w) => ({ id: w.id, name: w.name }))}
        workspaceFilter={graphState.settings.workspaceFilter}
        onWorkspaceFilterChange={handleWorkspaceFilterChange}
        onFit={handleFit}
        selectedNode={selectedNode}
        dependenciesOfSelected={dependenciesOfSelected}
        usedByOfSelected={usedByOfSelected}
        dependencyTree={dependencyTree}
        allNodeById={everyNodeById}
        onSelectTab={handleSelectTab}
        onOpenTab={handleOpenTabById}
        onAddDependency={() => selectedTabId && setLinkDialog({ mode: "dependency", tabId: selectedTabId })}
        onRemoveDependency={handleRemoveDependency}
        onChangeDependencyType={handleChangeDependencyType}
      />

      <GraphContextMenu
        state={contextMenu}
        otherWorkspaces={otherWorkspaces}
        dependencyCount={contextNodeDependencyCount}
        onOpenTab={() => {
          if (contextNode) openTab(contextNode.tab.url)
          setContextMenu(null)
        }}
        onOpenNewTab={() => {
          if (contextNode) openTab(contextNode.tab.url, { newTab: true })
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
    </div>
  )
}
