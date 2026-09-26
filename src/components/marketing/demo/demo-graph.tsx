"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, MousePointerClick, Waypoints } from "lucide-react"
import { GraphCanvas, type GraphCanvasHandle, type HoverInfo } from "@/components/graph/graph-canvas"
import { GraphControls } from "@/components/graph/graph-controls"
import { GraphLinkDialog } from "@/components/graph/graph-link-dialog"
import { GraphNodeNotesView } from "@/components/graph/graph-node-notes-view"
import { GraphNodeTooltip } from "@/components/graph/graph-node-tooltip"
import { GraphSidebar } from "@/components/graph/graph-sidebar"
import { IconButton } from "@/components/ui/icon-button"
import { usePortalContainer } from "@/components/ui/portal-container"
import { RenameCollectionDialog } from "@/components/workspace/rename-collection-dialog"
import type { Tab } from "@/lib/tabs/types"
import { buildClusterTree, computeClusterAnchors } from "@/lib/graph/clusters"
import { computeLocalDistances } from "@/lib/graph/local-graph"
import { buildDependencyEdges, buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "@/lib/graph/relations"
import { searchGraphNodes } from "@/lib/graph/search"
import { DEFAULT_GRAPH_SETTINGS, type GraphEdge, type GraphSettings } from "@/lib/graph/types"
import { buildDependencyTree } from "@/lib/dependencies/tree"
import { dependenciesOf, usedBy } from "@/lib/dependencies/relations"
import { applyCategoryChange } from "@/lib/sections/migrate"
import { cn } from "@/lib/utils"
import { useHubbleDemo } from "./demo-provider"

/**
 * The Graph, as GraphView lays it out: the canvas, the back button and count
 * chip at its top left, zoom controls at its bottom right, and the graph
 * panel — search, view, depth, connection filters, display and the selected
 * tab's relationships — over its right edge.
 *
 * The canvas is the product's real GraphCanvas and its physics; nodes, edges,
 * clusters and search come from the same lib/graph builders GraphView calls.
 * What GraphView adds that the demo leaves out is persistence: GraphView
 * saves positions and the camera to the visitor's localStorage, and this
 * keeps them in component state for the length of the visit.
 *
 * Loaded on demand (see demo-app.tsx), so the canvas and its physics engine
 * are not part of the landing page's first load.
 */
export default function DemoGraph({ onClose }: { onClose?: () => void }) {
  const { state, dispatch, openUrl } = useHubbleDemo()
  const canvasRef = useRef<GraphCanvasHandle>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  // Scoped to the workspace on screen, which frames it close enough for the
  // labels to read; the panel's workspace filter widens it to all of them.
  const [settings, setSettings] = useState<GraphSettings>(() => ({
    ...DEFAULT_GRAPH_SETTINGS,
    sidebarOpen: false,
    workspaceFilter: state.store.currentId,
  }))
  // The panel opens only where it leaves the canvas most of the window.
  useLayoutEffect(() => {
    if ((frameRef.current?.offsetWidth ?? 0) >= 880) setSettings((prev) => ({ ...prev, sidebarOpen: true }))
  }, [])
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [boundaryOffsets, setBoundaryOffsets] = useState<Record<string, { x: number; y: number }>>({})
  const [query, setQuery] = useState("")
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [selectedScreen, setSelectedScreen] = useState<HoverInfo | null>(null)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null)
  const [notesTabId, setNotesTabId] = useState<string | null>(null)
  const [renamingCollection, setRenamingCollection] = useState(false)
  const [dependencyFor, setDependencyFor] = useState<string | null>(null)
  const portal = usePortalContainer()

  /*
    Wheel and touch go to the page until the visitor chooses the graph.

    The canvas zooms on the wheel and pans on touch, which is right in the app
    and wrong on a page someone is scrolling past: the page would stop under
    their cursor or thumb. So the canvas sits under a cover until it is
    clicked, and the cover returns when the pointer leaves or focus goes
    elsewhere — the embedded-map convention. The zoom buttons and the panel
    work either way.
  */
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (!active) return
    function onPointerDown(event: PointerEvent) {
      if (frameRef.current && !frameRef.current.contains(event.target as Node)) setActive(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setActive(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [active])

  const workspaces = state.store.workspaces
  const lookup = useMemo(() => buildWorkspaceLookup(workspaces), [workspaces])
  const scopedTabs = useMemo(() => {
    const all = workspaces.flatMap((w) => w.tabs)
    return settings.workspaceFilter === "all" ? all : all.filter((t) => lookup.get(t.id)?.id === settings.workspaceFilter)
  }, [workspaces, settings.workspaceFilter, lookup])
  const allNodes = useMemo(() => buildGraphNodes(scopedTabs, lookup), [scopedTabs, lookup])
  const everyNode = useMemo(() => buildGraphNodes(workspaces.flatMap((w) => w.tabs), lookup), [workspaces, lookup])
  const everyNodeById = useMemo(() => new Map(everyNode.map((n) => [n.id, n])), [everyNode])
  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes])
  const validTabIds = useMemo(() => new Set(everyNode.map((n) => n.id)), [everyNode])
  const sections = useMemo(() => workspaces.flatMap((w) => w.sections ?? []), [workspaces])

  const clusterTree = useMemo(() => buildClusterTree(scopedTabs, sections, state.collections), [scopedTabs, sections, state.collections])
  const clusterAnchors = useMemo(() => computeClusterAnchors(clusterTree), [clusterTree])
  const allEdges = useMemo(
    () =>
      buildGraphEdges(scopedTabs, lookup, settings.filters, [], sections, (tabId) => clusterAnchors.get(tabId)?.categoryAnchor ?? undefined),
    [scopedTabs, lookup, settings.filters, sections, clusterAnchors]
  )
  const allDependencyEdges = useMemo(
    () => (settings.filters.dependencies ? buildDependencyEdges(scopedTabs, state.dependencies) : []),
    [scopedTabs, state.dependencies, settings.filters.dependencies]
  )

  const selectedTabId = settings.selectedTabId
  const centerTabId = settings.view === "local" && selectedTabId && nodeById.has(selectedTabId) ? selectedTabId : null
  const { visibleNodes, visibleEdges, visibleDependencyEdges, centerDistances } = useMemo(() => {
    if (!centerTabId) {
      return { visibleNodes: allNodes, visibleEdges: allEdges, visibleDependencyEdges: allDependencyEdges, centerDistances: undefined }
    }
    const bfs: GraphEdge[] = [
      ...allEdges,
      ...allDependencyEdges.map((e) => ({ id: e.id, source: e.parentTabId, target: e.childTabId, reasons: [] })),
    ]
    const distances = computeLocalDistances(centerTabId, bfs, settings.depth)
    const ids = new Set(distances.keys())
    return {
      visibleNodes: allNodes.filter((n) => ids.has(n.id)),
      visibleEdges: allEdges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      visibleDependencyEdges: allDependencyEdges.filter((e) => ids.has(e.parentTabId) && ids.has(e.childTabId)),
      centerDistances: distances,
    }
  }, [centerTabId, allNodes, allEdges, allDependencyEdges, settings.depth])

  const searchResults = useMemo(() => searchGraphNodes(allNodes, query), [allNodes, query])
  const searchMatches = useMemo(() => (query.trim() ? new Set(searchResults.map((n) => n.id)) : null), [query, searchResults])

  const selectedNode = selectedTabId ? (everyNodeById.get(selectedTabId) ?? null) : null
  const selectedCollection = selectedCollectionId ? (state.collections.find((c) => c.id === selectedCollectionId) ?? null) : null

  const update = (patch: Partial<GraphSettings>) => setSettings((prev) => ({ ...prev, ...patch }))
  const selectTab = (id: string) => {
    update({ selectedTabId: id })
    canvasRef.current?.centerOnNode(id)
  }
  const openTab = (id: string) => {
    const node = everyNodeById.get(id)
    if (node) openUrl(node.tab.url)
  }
  const updateTab = (id: string, change: (tab: Tab) => Tab) => {
    const workspace = workspaces.find((w) => w.tabs.some((t) => t.id === id))
    if (!workspace) return
    dispatch({ type: "set-tabs", workspaceId: workspace.id, tabs: workspace.tabs.map((t) => (t.id === id ? change(t) : t)) })
  }

  return (
    <div ref={frameRef} className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        {onClose && (
          <IconButton aria-label="Back to workspace" tooltip="Back to workspace" onClick={onClose}>
            <ChevronLeft />
          </IconButton>
        )}
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1 text-label text-tertiary shadow-sm">
          <Waypoints className="size-3.5" />
          Graph
          <span aria-hidden>·</span>
          <span className="text-meta">
            {visibleNodes.length}/{everyNode.length}
          </span>
        </div>
      </div>

      <GraphCanvas
        ref={canvasRef}
        viewportInsetRight={settings.sidebarOpen ? 288 : 0}
        autoFitOnFirstSettle
        nodes={visibleNodes}
        edges={visibleEdges}
        dependencyEdges={visibleDependencyEdges}
        positions={positions}
        boundaryOffsets={boundaryOffsets}
        layoutSettled={false}
        initialCamera={settings.camera}
        display={settings.display}
        selectedTabId={selectedTabId}
        centerTabId={centerTabId}
        centerDistances={centerDistances}
        searchMatches={searchMatches}
        collections={state.collections}
        selectedCollectionId={selectedCollectionId}
        clusterTree={clusterTree}
        clusterAnchors={clusterAnchors}
        selectedClusterId={selectedClusterId}
        onSelectCluster={(id) => {
          setSelectedClusterId(id)
          if (id) update({ selectedTabId: null })
        }}
        showClusterBoundaries={settings.showClusterBoundaries}
        onCameraChange={() => undefined}
        onSelectNode={(id) => update({ selectedTabId: id })}
        onSelectCollection={(id) => {
          setSelectedCollectionId(id)
          if (id) update({ selectedTabId: null })
        }}
        onOpenNode={(node) => openTab(node.id)}
        onContextMenu={() => undefined}
        onEdgeClick={() => undefined}
        onDependencyEdgeClick={() => undefined}
        onNodeMoved={(id, x, y) => setPositions((prev) => ({ ...prev, [id]: { x, y } }))}
        onBoundaryMembersMoved={(moves) => {
          if (moves.length === 0) return
          setPositions((prev) => ({ ...prev, ...Object.fromEntries(moves.map((m) => [m.id, { x: m.x, y: m.y }])) }))
          setBoundaryOffsets((prev) => ({ ...prev, ...Object.fromEntries(moves.map((m) => [m.id, m.offset])) }))
        }}
        onBoundaryOffsetsNormalized={(offsets) => setBoundaryOffsets((prev) => ({ ...prev, ...offsets }))}
        onHoverChange={setHover}
        onSelectedNodeScreenChange={setSelectedScreen}
      />

      {!active && (
        <button
          type="button"
          onClick={() => setActive(true)}
          aria-label="Explore the graph: drag to pan, scroll to zoom"
          className="group absolute inset-0 z-[5] flex cursor-pointer items-end justify-center pb-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
        >
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1 text-body-sm text-muted-foreground shadow-sm",
              "transition-colors duration-(--duration-fast) group-hover:text-foreground",
              settings.sidebarOpen && "mr-72"
            )}
          >
            <MousePointerClick className="size-3.5" aria-hidden />
            <span className="sm:hidden">Tap to explore</span>
            <span className="max-sm:hidden">Click to explore — drag to pan, scroll to zoom</span>
          </span>
        </button>
      )}

      <GraphNodeTooltip
        hover={active ? hover : null}
        selected={selectedScreen}
        onOpenNotes={setNotesTabId}
        onToggleFavorite={(id) => updateTab(id, (t) => ({ ...t, isFavorite: !t.isFavorite }))}
        onCategoryChange={(id, category) => updateTab(id, (t) => applyCategoryChange(t, category))}
        onOpenTab={openTab}
      />
      <GraphControls
        onZoomIn={() => canvasRef.current?.zoomBy(1.3)}
        onZoomOut={() => canvasRef.current?.zoomBy(1 / 1.3)}
        onFit={() => canvasRef.current?.fitToView()}
      />

      <GraphSidebar
        open={settings.sidebarOpen}
        onToggle={() => update({ sidebarOpen: !settings.sidebarOpen })}
        query={query}
        onQueryChange={setQuery}
        searchResults={searchResults}
        onSelectResult={(id) => {
          setQuery("")
          selectTab(id)
        }}
        view={settings.view}
        onViewChange={(view) => update({ view })}
        depth={settings.depth}
        onDepthChange={(depth) => update({ depth })}
        filters={settings.filters}
        onFiltersChange={(filters) => update({ filters })}
        display={settings.display}
        onDisplayChange={(display) => update({ display })}
        showClusterBoundaries={settings.showClusterBoundaries}
        onShowClusterBoundariesChange={(showClusterBoundaries) => update({ showClusterBoundaries })}
        workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
        workspaceFilter={settings.workspaceFilter}
        onWorkspaceFilterChange={(workspaceFilter) => update({ workspaceFilter })}
        onFit={() => canvasRef.current?.fitToView()}
        selectedNode={selectedNode}
        dependenciesOfSelected={selectedTabId ? dependenciesOf(selectedTabId, state.dependencies) : []}
        usedByOfSelected={selectedTabId ? usedBy(selectedTabId, state.dependencies) : []}
        dependencyTree={selectedTabId ? buildDependencyTree(selectedTabId, state.dependencies, validTabIds) : []}
        allNodeById={everyNodeById}
        onSelectTab={selectTab}
        onOpenTab={openTab}
        onAddDependency={() => selectedTabId && setDependencyFor(selectedTabId)}
        onRemoveDependency={(id) => dispatch({ type: "remove-dependency", id })}
        onChangeDependencyType={(id, dependencyType) => dispatch({ type: "set-dependency-type", id, dependencyType })}
        onOpenNotes={setNotesTabId}
        selectedCollection={selectedCollection}
        onFocusCollection={() => selectedCollectionId && canvasRef.current?.focusCollection(selectedCollectionId)}
        onRenameCollection={() => setRenamingCollection(true)}
        onOpenAllInCollection={() => {
          for (const tabId of selectedCollection?.tabIds ?? []) openTab(tabId)
        }}
        onDeleteCollection={() => {
          if (selectedCollectionId) dispatch({ type: "delete-collection", id: selectedCollectionId })
          setSelectedCollectionId(null)
        }}
      />

      {renamingCollection && selectedCollection && (
        <RenameCollectionDialog
          key={selectedCollection.id}
          open
          onOpenChange={(open) => !open && setRenamingCollection(false)}
          currentName={selectedCollection.name}
          onRename={(name) => {
            dispatch({ type: "rename-collection", id: selectedCollection.id, name })
            setRenamingCollection(false)
          }}
        />
      )}
      <GraphLinkDialog
        open={dependencyFor !== null}
        onOpenChange={(open) => !open && setDependencyFor(null)}
        mode="dependency"
        sourceNode={dependencyFor ? (everyNodeById.get(dependencyFor) ?? null) : null}
        candidates={everyNode.filter((n) => n.id !== dependencyFor)}
        existingDependencyTargetIds={new Set(dependencyFor ? dependenciesOf(dependencyFor, state.dependencies).map((d) => d.childTabId) : [])}
        onAddDependency={(childTabId, dependencyType) =>
          dependencyFor &&
          dispatch({ type: "add-dependency", parentTabId: dependencyFor, childTabId, ...(dependencyType ? { dependencyType } : {}) })
        }
      />
      {/* A full-window page in the app; portalled beside the demo so it sits
          above the page's header rather than inside the window's layer. */}
      {notesTabId &&
        everyNodeById.get(notesTabId) &&
        portal &&
        createPortal(
          <GraphNodeNotesView
            key={notesTabId}
            node={everyNodeById.get(notesTabId)!}
            onNotesChange={(id, notes) => updateTab(id, (t) => ({ ...t, notes: notes.trim() || undefined }))}
            onClose={() => setNotesTabId(null)}
          />,
          portal
        )}
    </div>
  )
}
