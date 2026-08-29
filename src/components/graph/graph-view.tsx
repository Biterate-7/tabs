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
import { GraphLinkDialog } from "./graph-link-dialog"
import { buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "@/lib/graph/relations"
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

const CAMERA_FLUSH_DELAY_MS = 200
const SAVE_DEBOUNCE_MS = 400

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
  const [linkDialogFor, setLinkDialogFor] = useState<string | null>(null)

  const pendingCameraRef = useRef<CameraState | null>(null)
  const cameraFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const workspaceLookup = useMemo(() => buildWorkspaceLookup(store.workspaces), [store.workspaces])

  const scopedTabs = useMemo(() => {
    const all = store.workspaces.flatMap((w) => w.tabs)
    if (graphState.settings.workspaceFilter === "all") return all
    return all.filter((t) => workspaceLookup.get(t.id)?.id === graphState.settings.workspaceFilter)
  }, [store.workspaces, graphState.settings.workspaceFilter, workspaceLookup])

  const allNodes = useMemo(() => buildGraphNodes(scopedTabs, workspaceLookup), [scopedTabs, workspaceLookup])
  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes])

  const allEdges = useMemo(
    () => buildGraphEdges(scopedTabs, workspaceLookup, graphState.settings.filters, graphState.manualConnections),
    [scopedTabs, workspaceLookup, graphState.settings.filters, graphState.manualConnections]
  )

  const view = graphState.settings.view
  const selectedTabId = graphState.settings.selectedTabId
  const centerTabId = view === "local" ? selectedTabId : null
  const hasCenter = Boolean(centerTabId && nodeById.has(centerTabId))

  const { visibleNodes, visibleEdges, centerDistances } = useMemo(() => {
    if (hasCenter && centerTabId) {
      const distances = computeLocalDistances(centerTabId, allEdges, graphState.settings.depth)
      const ids = new Set(distances.keys())
      return {
        visibleNodes: allNodes.filter((n) => ids.has(n.id)),
        visibleEdges: allEdges.filter((e) => ids.has(e.source) && ids.has(e.target)),
        centerDistances: distances,
      }
    }
    return { visibleNodes: allNodes, visibleEdges: allEdges, centerDistances: undefined }
  }, [hasCenter, centerTabId, allNodes, allEdges, graphState.settings.depth])

  const searchResults = useMemo(() => searchGraphNodes(allNodes, query), [allNodes, query])
  const searchMatches = useMemo(
    () => (query.trim() ? new Set(searchResults.map((n) => n.id)) : null),
    [query, searchResults]
  )

  // Debounced localStorage write — state itself always updates immediately
  // so the UI (checkboxes, pills, selection) never feels laggy; only the
  // persistence side-effect is throttled, since a fling-scroll can call
  // this several times per second via camera updates.
  useEffect(() => {
    const validIds = new Set(store.workspaces.flatMap((w) => w.tabs.map((t) => t.id)))
    const timer = setTimeout(() => {
      saveGraphState(pruneGraphState(graphState, validIds))
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [graphState, store.workspaces])

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

  const contextNode = contextMenu?.node
  const otherWorkspaces = contextNode
    ? store.workspaces
        .filter((w) => w.id !== workspaceLookup.get(contextNode.id)?.id)
        .map((w) => ({ id: w.id, name: w.name }))
    : []

  const linkSourceNode = linkDialogFor ? (nodeById.get(linkDialogFor) ?? null) : null
  const linkCandidates = useMemo(
    () => (linkDialogFor ? allNodes.filter((n) => n.id !== linkDialogFor) : []),
    [allNodes, linkDialogFor]
  )

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
  } else if (visibleEdges.length === 0) {
    emptyState = {
      title: "No connections match the current filters.",
      description: "Adjust your graph filters in the sidebar.",
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-background">
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
            setEdgePopover({ edge, source, target, x, y })
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
      />

      <GraphContextMenu
        state={contextMenu}
        otherWorkspaces={otherWorkspaces}
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
          if (contextNode) setLinkDialogFor(contextNode.id)
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
          if (edgePopover) handleRemoveManualLink(edgePopover.edge)
        }}
      />

      <GraphLinkDialog
        open={linkDialogFor !== null}
        onOpenChange={(open) => {
          if (!open) setLinkDialogFor(null)
        }}
        sourceNode={linkSourceNode}
        candidates={linkCandidates}
        onLink={(targetId) => {
          if (linkDialogFor) handleAddManualLink(linkDialogFor, targetId)
        }}
      />
    </div>
  )
}
