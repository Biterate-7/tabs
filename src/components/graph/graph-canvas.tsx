"use client"

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { BULK_ARRIVAL_THRESHOLD, createGraphSimulation, type GraphSimulation } from "@/lib/graph/engine"
import { computeNodeRadius } from "@/lib/graph/node-size"
import { resolveGraphPalette, type GraphPalette } from "@/lib/graph/palette"
import {
  clampZoom,
  computeFitCamera,
  screenToWorld,
  worldToScreen,
  zoomAroundPoint,
} from "@/lib/graph/layout"
import {
  BOUNDARY_HIT_TOLERANCE_PX,
  CATEGORY_BOUNDARY_PADDING,
  COLLECTION_BOUNDARY_PADDING,
  computeCollectionBoundary,
  hitTestBoundaryRects,
  resolveLiveBoundaries,
  SUBCATEGORY_BOUNDARY_PADDING,
  type BoundaryCandidate,
  type BoundaryOccupant,
  type CollectionBoundaryRect,
} from "@/lib/graph/collection-layout"
import { buildDegreeMap } from "@/lib/graph/relations"
import type { CameraState, GraphDependencyEdge, GraphDisplaySettings, GraphEdge, GraphNode } from "@/lib/graph/types"
import type { CategoryId } from "@/lib/categories"
import type { ClusterAnchorAssignment, ClusterNode, ClusterTree } from "@/lib/graph/clusters"
import { resolveLabelOverlaps, type LabelBox } from "@/lib/graph/label-layout"
import { faviconUrl } from "@/lib/workspace/favicon"
import { drawNode } from "./node-renderer"
import { drawEdge, drawDependencyEdge } from "./edge-renderer"
import { drawCollectionBoundary } from "./collection-renderer"

export type GraphCollection = { id: string; name: string; tabIds: string[] }

export type GraphCanvasHandle = {
  zoomBy: (factor: number) => void
  fitToView: () => void
  centerOnNode: (id: string) => void
  focusCollection: (id: string) => void
  focusCluster: (id: string) => void
}

export type HoverInfo = {
  node: GraphNode
  screenX: number
  screenY: number
}

const CLICK_DRAG_THRESHOLD = 4
const EDGE_HIT_PADDING = 6
const LABEL_MIN_ZOOM = 0.55
// Zoom-dependent detail tiers for cluster labels: category labels read even
// far zoomed out, subcategory/collection labels need a bit more zoom, and
// individual tab labels keep their existing (unchanged) threshold above —
// same single boolean-gate mechanism as LABEL_MIN_ZOOM, just three
// thresholds instead of one.
const CATEGORY_LABEL_MIN_ZOOM = 0.05
const SUBCATEGORY_LABEL_MIN_ZOOM = 0.28
// Below this zoom, low-degree ("minor") nodes fade toward partial opacity so
// a zoomed-out view of a large graph reads as "major hubs + cluster shape"
// rather than a wall of equally-loud dots — nodes are never removed, so
// hit-testing/click/hover/drag stay unaffected at any zoom.
const CLUSTER_OVERVIEW_ZOOM = 0.22
const MINOR_NODE_ZOOMED_OUT_ALPHA = 0.25
const MAJOR_DEGREE_THRESHOLD = 3
// Motion tuning. Ephemeral effects (node arrival/exit, dependency edge
// create/remove) are duration-based so they have a definite end; continuous
// state (selection/search/hover dimming, arrival scale/opacity) instead
// eases exponentially toward a target each frame — see tickVisualStates.
const VISUAL_EASE = 0.22
const NODE_EXIT_MS = 260
const EDGE_CREATE_PULSE_MS = 550
const EDGE_REMOVE_MS = 280
const CAMERA_FOCUS_MS = 380
const ARRIVAL_JITTER_MS = 180

type NodeVisualState = { alpha: number; scale: number; delayUntil: number }
type LeavingNode = { x: number; y: number; radius: number; start: number }
type DepEdgeEffect =
  | { kind: "create"; start: number }
  | { kind: "remove"; start: number; x1: number; y1: number; x2: number; y2: number; targetRadius: number }

// Bounds on the synchronous burst of physics run when a bulk dump arrives —
// see the physics-setup effect. Both are ceilings, not targets: the burst
// stops the moment the layout settles, and whatever is unfinished continues
// in the normal animated render loop, so neither number can turn into a hang.
// 200 ticks is roughly what the real 283-tab export needs to reach rest from
// its seeded layout; the 120ms budget is what keeps a much larger dump from
// spending longer than a couple of dropped frames before the first paint.
const BULK_PRESETTLE_TICKS = 200
const BULK_PRESETTLE_BUDGET_MS = 120

/** Deterministic per-id jitter (0..range) so simultaneous arrivals don't move in lockstep. */
function jitterFor(id: string, range: number): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return Math.abs(hash) % range
}

/**
 * A cheap fingerprint of the graph's STRUCTURE — which nodes exist, which
 * edges exist, which collections hold which tabs — and deliberately nothing
 * about their content. Two renders with the same structure produce the same
 * string even when every Tab object has been replaced (which is what a
 * resolved title does). See structureSignatureRef for why that distinction
 * decides whether the simulation is reheated.
 *
 * An order-insensitive additive hash rather than a concatenation: it is O(n)
 * with no allocation per element, and the inputs are already stably sorted by
 * their builders, so ordering carries no information to lose.
 */
function structureSignature(
  nodes: GraphNode[],
  edges: GraphEdge[],
  collections: GraphCollection[],
  /** The display settings that are physics inputs — node radius feeds collide, edge strength feeds the link force — so changing either genuinely does need the layout to re-settle. */
  physicsSettings: { nodeSize: string; edgeStrength: number }
): string {
  let nodeHash = 0
  for (const node of nodes) {
    for (let i = 0; i < node.id.length; i++) nodeHash = (nodeHash + node.id.charCodeAt(i) * (i + 1)) | 0
  }
  let edgeHash = 0
  for (const edge of edges) {
    for (let i = 0; i < edge.id.length; i++) edgeHash = (edgeHash + edge.id.charCodeAt(i) * (i + 1)) | 0
  }
  let collectionHash = 0
  for (const collection of collections) {
    collectionHash = (collectionHash + collection.tabIds.length) | 0
    for (let i = 0; i < collection.id.length; i++) {
      collectionHash = (collectionHash + collection.id.charCodeAt(i) * (i + 1)) | 0
    }
  }
  return [
    `${nodes.length}:${nodeHash}`,
    `${edges.length}:${edgeHash}`,
    `${collections.length}:${collectionHash}`,
    `${physicsSettings.nodeSize}:${physicsSettings.edgeStrength}`,
  ].join("|")
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, {
  nodes: GraphNode[]
  edges: GraphEdge[]
  dependencyEdges: GraphDependencyEdge[]
  positions: Record<string, { x: number; y: number }>
  /** Persisted per-tab cluster-territory displacement from past boundary drags — see GraphPersistedState.boundaryOffsets. */
  boundaryOffsets: Record<string, { x: number; y: number }>
  /**
   * True when `positions` is the FINISHED layout for exactly this graph —
   * settled headlessly before the view was unlocked (lib/graph/precompute.ts)
   * and still matching it (GraphPersistedState.layoutKey). The first physics
   * pass then cools instead of reheating, so the graph opens at its final
   * layout rather than re-running ~200 ticks of physics in front of the user.
   */
  layoutSettled: boolean
  initialCamera: CameraState
  display: GraphDisplaySettings
  selectedTabId: string | null
  centerTabId: string | null
  centerDistances?: Map<string, number>
  searchMatches: Set<string> | null
  /** Collections visible in the current scope — drawn as soft boundary regions behind their member nodes (never as edges; see collection-renderer.ts). */
  collections: GraphCollection[]
  selectedCollectionId: string | null
  /** Hierarchical Category → Subcategory (→ Collection) structure derived from the current node set — see lib/graph/clusters.ts. Drives both the anchor forces (via the physics-setup effect) and the nested boundary/label rendering below. */
  clusterTree: ClusterTree
  clusterAnchors: Map<string, ClusterAnchorAssignment>
  selectedClusterId: string | null
  onSelectCluster: (id: string | null) => void
  showClusterBoundaries: boolean
  onCameraChange: (camera: CameraState) => void
  onSelectNode: (id: string | null) => void
  onSelectCollection: (id: string | null) => void
  onOpenNode: (node: GraphNode) => void
  onContextMenu: (node: GraphNode, screenX: number, screenY: number) => void
  onEdgeClick: (edge: GraphEdge, screenX: number, screenY: number) => void
  onDependencyEdgeClick: (edge: GraphDependencyEdge, screenX: number, screenY: number) => void
  onNodeMoved: (id: string, x: number, y: number) => void
  /** Every tab carried by a boundary-square drag, reported in one batch — position plus the cluster-territory offset that has to travel with it. */
  onBoundaryMembersMoved: (
    moves: { id: string; x: number; y: number; offset: { x: number; y: number } }[]
  ) => void
  onHoverChange: (hover: HoverInfo | null) => void
  /** Fired whenever the selected node's live on-screen anchor changes (selection, pan, zoom, drag, camera animation) — lets the host pin a persistent Tab Peek popup to the node itself rather than to the cursor, so it survives hover moving anywhere else on the canvas. Null whenever nothing is selected or the selected node isn't currently visible. */
  onSelectedNodeScreenChange: (info: HoverInfo | null) => void
}>(function GraphCanvas(
  {
    nodes,
    edges,
    dependencyEdges,
    positions,
    boundaryOffsets,
    layoutSettled,
    initialCamera,
    display,
    selectedTabId,
    centerTabId,
    centerDistances,
    searchMatches,
    collections,
    selectedCollectionId,
    clusterTree,
    clusterAnchors,
    selectedClusterId,
    onSelectCluster,
    showClusterBoundaries,
    onCameraChange,
    onSelectNode,
    onSelectCollection,
    onOpenNode,
    onContextMenu,
    onEdgeClick,
    onDependencyEdgeClick,
    onNodeMoved,
    onBoundaryMembersMoved,
    onHoverChange,
    onSelectedNodeScreenChange,
  },
  ref
) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simulationRef = useRef<GraphSimulation | null>(null)
  if (!simulationRef.current) simulationRef.current = createGraphSimulation()

  const cameraRef = useRef<CameraState>(initialCamera)
  const sizeRef = useRef({ width: 0, height: 0 })
  const paletteRef = useRef<GraphPalette | null>(null)
  const faviconCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const nodesRef = useRef<GraphNode[]>(nodes)
  const edgesRef = useRef<GraphEdge[]>(edges)
  const dependencyEdgesRef = useRef<GraphDependencyEdge[]>(dependencyEdges)
  // Mirrors of props read inside tickVisualStates()/draw() — both are called
  // from a requestAnimationFrame chain that can outlive the render that
  // scheduled it (the loop keeps re-invoking the exact same closure via
  // `requestAnimationFrame(loop)` for as long as physics is still settling,
  // e.g. on a large graph). Without a ref, a selection/search made while
  // that chain is still running would be invisible until the loop happens
  // to stop and get restarted from a fresh render — reading `.current`
  // instead keeps every frame, however old its closure, looking at this
  // render's actual values. Same pattern as nodesRef/edgesRef above.
  const selectedTabIdRef = useRef(selectedTabId)
  const centerTabIdRef = useRef(centerTabId)
  const searchMatchesRef = useRef(searchMatches)
  const displayRef = useRef(display)

  // Canvas's viewport offset, refreshed on resize — lets draw() convert its
  // canvas-local worldToScreen output into the client/page coordinates a
  // `position: fixed` popup needs, without a getBoundingClientRect() read
  // every frame.
  const canvasRectRef = useRef({ left: 0, top: 0 })
  // Last position reported via onSelectedNodeScreenChange, so draw() only
  // calls back when the anchor actually moved (or the selection/visibility
  // changed) instead of every frame regardless.
  const lastReportedSelectedRef = useRef<{ id: string; x: number; y: number } | null>(null)

  const hoveredIdRef = useRef<string | null>(null)
  /**
   * The boundary square the pointer is currently over — purely a rendering
   * cue, drawn one step louder so the user can see WHICH group a press would
   * act on before committing to it. Resolved through the exact same
   * `hitTestBoundary` the press itself uses, so what lights up is always what
   * would be grabbed.
   */
  const hoveredBoundaryIdRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; pointerId: number } | null>(null)
  // The boundary square currently held by the pointer. Its physics body lives
  // in the same simulation as the nodes (see engine.ts's boundary layer); this
  // only remembers which one, and where the gesture started, so a click
  // without meaningful movement still resolves as a click.
  const boundaryDragRef = useRef<{ id: string; startX: number; startY: number; pointerId: number } | null>(null)
  // Tracks the boundary layer's settled edge so member positions are flushed
  // once, when everything has come to rest, rather than every frame.
  const boundarySettledRef = useRef(true)
  const panRef = useRef<{ startX: number; startY: number; lastX: number; lastY: number; pointerId: number } | null>(
    null
  )
  const spaceHeldRef = useRef(false)

  // Whether the physics effect below has run yet — see its `cool()` branch.
  const isFirstPhysicsPassRef = useRef(true)
  const rafRef = useRef<number | null>(null)
  const runningRef = useRef(false)
  const needsDrawRef = useRef(true)
  const unmountedRef = useRef(false)

  // Motion state — all imperative (refs, not React state) so per-frame
  // easing never triggers a re-render; see the module-level motion comment.
  const visualRef = useRef<Map<string, NodeVisualState>>(new Map())
  const prevNodeIdsRef = useRef<Set<string> | null>(null)
  const leavingNodesRef = useRef<Map<string, LeavingNode>>(new Map())
  const prevDependencyEdgesRef = useRef<GraphDependencyEdge[]>([])
  const depEdgeEffectsRef = useRef<Map<string, DepEdgeEffect>>(new Map())
  const cameraAnimRef = useRef<{ from: CameraState; to: CameraState; start: number; duration: number } | null>(null)
  const reducedMotionRef = useRef(false)
  const hoverNeighborsRef = useRef<Set<string> | null>(null)
  const collectionsRef = useRef<GraphCollection[]>(collections)
  const selectedCollectionIdRef = useRef(selectedCollectionId)
  // Populated during draw() with each live collection's WORLD-space rect,
  // reused for hit-testing on click instead of recomputing it there —
  // draw() already walked every collection's visible members this frame.
  const collectionRectsRef = useRef<Map<string, CollectionBoundaryRect>>(new Map())
  const clusterTreeRef = useRef<ClusterTree>(clusterTree)
  const selectedClusterIdRef = useRef(selectedClusterId)
  const showClusterBoundariesRef = useRef(showClusterBoundaries)
  // Same "recompute during draw(), reuse for hit-testing" convention as
  // collectionRectsRef above, one map per structural tier.
  const categoryRectsRef = useRef<Map<string, CollectionBoundaryRect>>(new Map())
  const subcategoryRectsRef = useRef<Map<string, CollectionBoundaryRect>>(new Map())
  /**
   * The ids of the boundary squares that currently EXIST — drawn,
   * hit-testable and backed by a physics body, all three or none.
   *
   * It lives across frames on purpose. A square's existence is a persistent
   * fact about the graph, not a per-frame re-derivation from the geometry it
   * happens to have this instant; see collection-layout.ts's
   * resolveLiveBoundaries, which owns the admission/retention rule and the
   * reason a per-frame re-election is what used to delete squares mid-drag.
   */
  const liveBoundaryIdsRef = useRef<Set<string>>(new Set())
  /**
   * Signature of the last STRUCTURE the physics effect saw — which nodes,
   * which edges, which collections.
   *
   * The effect's dependency list is full of things that change without the
   * layout changing at all: a title resolving rewrites every Tab object, so
   * `nodes`, `edges` and `clusterTree` all get new identities while the graph
   * remains, structurally, the same graph. Reheating on those was reheating
   * the simulation dozens of times during a normal post-dump title-resolution
   * pass, and each reheat restarts a full settle — the layout never got to
   * finish converging before being kicked again, which is a large part of why
   * the graph read as permanently in motion. Comparing the structure instead
   * means a cosmetic update costs nothing.
   */
  const structureSignatureRef = useRef<string | null>(null)

  nodesRef.current = nodes
  edgesRef.current = edges
  dependencyEdgesRef.current = dependencyEdges
  selectedTabIdRef.current = selectedTabId
  centerTabIdRef.current = centerTabId
  searchMatchesRef.current = searchMatches
  displayRef.current = display
  collectionsRef.current = collections
  selectedCollectionIdRef.current = selectedCollectionId
  clusterTreeRef.current = clusterTree
  selectedClusterIdRef.current = selectedClusterId
  showClusterBoundariesRef.current = showClusterBoundaries

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const selectedCollectionMemberIds = useMemo(() => {
    if (!selectedCollectionId) return null
    const collection = collections.find((c) => c.id === selectedCollectionId)
    return collection ? new Set(collection.tabIds) : null
  }, [collections, selectedCollectionId])
  const selectedCollectionMemberIdsRef = useRef(selectedCollectionMemberIds)
  selectedCollectionMemberIdsRef.current = selectedCollectionMemberIds

  const selectedClusterMemberIds = useMemo(() => {
    if (!selectedClusterId) return null
    const cluster = clusterTree.byId.get(selectedClusterId)
    return cluster ? new Set(cluster.totalTabIds) : null
  }, [clusterTree, selectedClusterId])
  const selectedClusterMemberIdsRef = useRef(selectedClusterMemberIds)
  selectedClusterMemberIdsRef.current = selectedClusterMemberIds

  const degreeById = useMemo(() => buildDegreeMap(edges, dependencyEdges), [edges, dependencyEdges])
  const degreeByIdRef = useRef(degreeById)
  degreeByIdRef.current = degreeById

  // Selecting either end of a dependency counts as "connected" here — a
  // parent highlights its dependencies, and a child highlights what depends
  // on it ("used by"), matching how every other edge reason already
  // highlights symmetrically regardless of which side was clicked.
  const neighborInfo = useMemo(() => {
    if (!selectedTabId) return null
    const neighborIds = new Set<string>()
    const edgeIds = new Set<string>()
    const dependencyEdgeIds = new Set<string>()
    for (const edge of edges) {
      if (edge.source === selectedTabId || edge.target === selectedTabId) {
        edgeIds.add(edge.id)
        neighborIds.add(edge.source === selectedTabId ? edge.target : edge.source)
      }
    }
    for (const edge of dependencyEdges) {
      if (edge.parentTabId === selectedTabId || edge.childTabId === selectedTabId) {
        dependencyEdgeIds.add(edge.id)
        neighborIds.add(edge.parentTabId === selectedTabId ? edge.childTabId : edge.parentTabId)
      }
    }
    return { neighborIds, edgeIds, dependencyEdgeIds }
  }, [edges, dependencyEdges, selectedTabId])
  const neighborInfoRef = useRef(neighborInfo)
  neighborInfoRef.current = neighborInfo

  function radiusOf(node: GraphNode): number {
    return computeNodeRadius(display.nodeSize, degreeById.get(node.id) ?? 0, centerDistances?.get(node.id))
  }

  /** Every node directly connected to `id` by either a relation or dependency edge — used to keep a hovered node's neighborhood legible instead of dimming the whole graph indiscriminately. */
  function computeNeighborIds(id: string): Set<string> {
    const ids = new Set<string>()
    for (const edge of edgesRef.current) {
      if (edge.source === id) ids.add(edge.target)
      else if (edge.target === id) ids.add(edge.source)
    }
    for (const edge of dependencyEdgesRef.current) {
      if (edge.parentTabId === id) ids.add(edge.childTabId)
      else if (edge.childTabId === id) ids.add(edge.parentTabId)
    }
    return ids
  }

  /** Smoothly retargets the camera instead of snapping — used for the "focus a node" / "fit to view" moments where a jump would be disorienting. Direct manipulation (drag-pan, wheel-zoom) stays instant. */
  function animateCameraTo(target: CameraState) {
    if (reducedMotionRef.current) {
      cameraAnimRef.current = null
      cameraRef.current = target
      onCameraChange(target)
      requestDraw()
      return
    }
    cameraAnimRef.current = { from: cameraRef.current, to: target, start: performance.now(), duration: CAMERA_FOCUS_MS }
    requestDraw()
  }

  /**
   * Advances every ephemeral/eased visual (camera focus, node arrival/exit
   * scale+opacity, dependency edge create/remove effects) by one frame.
   * Returns whether anything is still mid-animation, so the render loop
   * knows to keep scheduling frames even after the physics simulation has
   * settled and no pointer interaction is in progress.
   */
  function tickVisualStates(): boolean {
    let animating = false
    const now = performance.now()
    const reduced = reducedMotionRef.current

    if (cameraAnimRef.current) {
      const { from, to, start, duration } = cameraAnimRef.current
      const t = Math.min(1, (now - start) / duration)
      const eased = easeOutCubic(t)
      cameraRef.current = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        zoom: from.zoom + (to.zoom - from.zoom) * eased,
      }
      onCameraChange(cameraRef.current)
      if (t >= 1) cameraAnimRef.current = null
      else animating = true
    }

    const selectedTabId = selectedTabIdRef.current
    const searchMatches = searchMatchesRef.current
    const neighborInfo = neighborInfoRef.current
    const hasSearch = Boolean(searchMatches && searchMatches.size > 0)
    const hoveredId = hoveredIdRef.current
    const hoverNeighbors = hoverNeighborsRef.current
    for (const node of nodesRef.current) {
      const v = visualRef.current.get(node.id)
      if (!v) continue

      if (now < v.delayUntil) {
        animating = true
        continue
      }

      const isSelected = node.id === selectedTabId
      const isSelectionNeighbor = Boolean(neighborInfo?.neighborIds.has(node.id))
      const isMatch = hasSearch && searchMatches!.has(node.id)
      const isHovered = node.id === hoveredId
      const isHoverNeighbor = Boolean(hoveredId && hoverNeighbors?.has(node.id))

      const selectedCollectionMemberIds = selectedCollectionMemberIdsRef.current
      const isCollectionMember = Boolean(selectedCollectionMemberIds?.has(node.id))
      const selectedClusterMemberIds = selectedClusterMemberIdsRef.current
      const isClusterMember = Boolean(selectedClusterMemberIds?.has(node.id))

      let targetAlpha = 1
      if (selectedTabId && !isSelected && !isSelectionNeighbor) targetAlpha = 0.22
      if (selectedCollectionMemberIds && !isCollectionMember) targetAlpha = Math.min(targetAlpha, 0.22)
      if (selectedClusterMemberIds && !isClusterMember) targetAlpha = Math.min(targetAlpha, 0.22)
      if (hasSearch && !isMatch) targetAlpha = Math.min(targetAlpha, 0.16)
      if (!selectedTabId && !hasSearch && hoveredId && !isHovered && !isHoverNeighbor) {
        targetAlpha = Math.min(targetAlpha, 0.35)
      }
      // Zoomed far out: fade low-degree "minor" nodes so a large graph reads
      // as major hubs + cluster shape rather than a uniform wall of dots.
      // Never applied to a selected/searched/hovered node or its neighbors —
      // this is purely an overview aid, not another dimming priority.
      if (
        cameraRef.current.zoom < CLUSTER_OVERVIEW_ZOOM &&
        !isSelected &&
        !isSelectionNeighbor &&
        !isCollectionMember &&
        !isClusterMember &&
        !isMatch &&
        (degreeByIdRef.current.get(node.id) ?? 0) < MAJOR_DEGREE_THRESHOLD
      ) {
        targetAlpha = Math.min(targetAlpha, MINOR_NODE_ZOOMED_OUT_ALPHA)
      }
      const targetScale = 1

      if (reduced) {
        v.alpha = targetAlpha
        v.scale = targetScale
        continue
      }

      if (Math.abs(v.alpha - targetAlpha) > 0.003) {
        v.alpha += (targetAlpha - v.alpha) * VISUAL_EASE
        animating = true
      } else {
        v.alpha = targetAlpha
      }
      if (Math.abs(v.scale - targetScale) > 0.003) {
        v.scale += (targetScale - v.scale) * VISUAL_EASE
        animating = true
      } else {
        v.scale = targetScale
      }
    }

    for (const [id, ghost] of leavingNodesRef.current) {
      if (now - ghost.start >= NODE_EXIT_MS) leavingNodesRef.current.delete(id)
      else animating = true
    }

    for (const [id, effect] of depEdgeEffectsRef.current) {
      const duration = effect.kind === "create" ? EDGE_CREATE_PULSE_MS : EDGE_REMOVE_MS
      if (now - effect.start >= duration) depEdgeEffectsRef.current.delete(id)
      else animating = true
    }

    return animating
  }

  /**
   * Writes every tab a boundary move displaced into the graph's own per-node
   * position state — the same store `onNodeMoved` writes to, just batched,
   * since one box carries a whole cluster. A repositioned square therefore
   * survives a rerender and a reload exactly the way a repositioned node does.
   *
   * Called on release AND again once the layer comes to rest, rather than
   * only on rest: the render loop is a requestAnimationFrame chain, which the
   * browser pauses outright while the tab isn't visible. Waiting for the
   * settle alone would silently lose the move whenever someone drags a box
   * and immediately switches tabs.
   */
  function flushBoundaryPositions() {
    const moved = simulationRef.current!.takeDisplacedBoundaryMembers()
    if (moved.length > 0) onBoundaryMembersMoved(moved)
  }

  function requestDraw() {
    // A favicon Image can finish loading (or the resize/palette effects can
    // fire their cleanup) after the component has already unmounted — its
    // onload handler still runs. Without this guard that would resurrect a
    // requestAnimationFrame loop on a component nothing is using anymore.
    if (unmountedRef.current) return
    needsDrawRef.current = true
    startLoopIfNeeded()
  }

  function startLoopIfNeeded() {
    if (runningRef.current) return
    runningRef.current = true
    rafRef.current = requestAnimationFrame(loop)
  }

  function getFavicon(domain: string): HTMLImageElement | null {
    const cache = faviconCacheRef.current
    let img = cache.get(domain)
    if (!img) {
      img = new Image()
      // Event-driven rather than polled: a redraw is requested exactly once,
      // when the image actually finishes (or fails). Polling `.complete`
      // every frame would keep the render loop alive indefinitely wherever
      // an image never resolves (e.g. jsdom in tests never loads images at
      // all), instead of letting it settle once the physics has stabilized.
      img.onload = () => requestDraw()
      img.onerror = () => {}
      img.src = faviconUrl(domain)
      cache.set(domain, img)
    }
    return img
  }

  function loop() {
    const simulation = simulationRef.current!
    const wasSettled = simulation.isSettled()
    const isInteracting = Boolean(dragRef.current || panRef.current || boundaryDragRef.current)
    // A boundary square can still be coasting to a stop after a release long
    // after the node layout has cooled, so it gets its own settled check.
    const boundaryMoving = !simulation.isBoundaryLayerSettled()

    if (!wasSettled || isInteracting || boundaryMoving) {
      simulation.tick()
      needsDrawRef.current = true
    }

    const stillAnimating = tickVisualStates()
    if (stillAnimating) needsDrawRef.current = true

    if (needsDrawRef.current) {
      draw()
      needsDrawRef.current = false
    }

    // Top-up flush: a box keeps coasting (and keeps shoving its neighbours)
    // for a few frames after the pointer lets go, so whatever moved after the
    // release-time flush is written when the layer finally comes to rest.
    const boundarySettledNow = simulation.isBoundaryLayerSettled()
    if (boundarySettledNow && !boundarySettledRef.current) flushBoundaryPositions()
    boundarySettledRef.current = boundarySettledNow

    const stillSettling = !simulation.isSettled() || !simulation.isBoundaryLayerSettled()
    if (stillSettling || isInteracting || stillAnimating) {
      rafRef.current = requestAnimationFrame(loop)
    } else {
      runningRef.current = false
      rafRef.current = null
    }
  }

  function draw() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    if (!paletteRef.current) paletteRef.current = resolveGraphPalette()
    const palette = paletteRef.current
    const { width, height } = sizeRef.current
    const camera = cameraRef.current
    const simulation = simulationRef.current!

    // Clear the full physical backing store under the identity transform —
    // clearing with the CSS-pixel width/height while a devicePixelRatio
    // scale is still active only wipes the top-left fraction of the canvas
    // (1/dpr of each axis), leaving a stale, uncleared strip along the
    // right/bottom edges that stacks up frame over frame into visible
    // trails as nodes move through it.
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()

    const selectedTabId = selectedTabIdRef.current
    const centerTabId = centerTabIdRef.current
    const searchMatches = searchMatchesRef.current
    const neighborInfo = neighborInfoRef.current
    const display = displayRef.current
    const hasSearch = Boolean(searchMatches && searchMatches.size > 0)
    const showLabels = camera.zoom >= LABEL_MIN_ZOOM
    const selectedCollectionId = selectedCollectionIdRef.current
    const selectedClusterId = selectedClusterIdRef.current
    const draggedBoundaryId = boundaryDragRef.current?.id ?? null
    const hoveredBoundaryId = hoveredBoundaryIdRef.current
    // The node under the pointer is left out of every box's geometry while it
    // is being dragged — see engine.ts's setBoundaryExcluded. Read here so
    // the DRAWN rect and the box's COLLIDER are derived from the same member
    // set; if only the collider excluded it, the visible box would still
    // stretch and the two would disagree about where the square is.
    const boundaryExcludedId = simulation.getBoundaryExcluded()

    // Every positioned node's WORLD position, gathered once per frame:
    // resolveLiveBoundaries below has to ask "how much of what this box
    // encloses is foreign to it", which is a question about *all* nodes,
    // not just one cluster's own members. World, not screen, so the answer
    // is the same however far out the camera is — measured in screen space
    // (as this was), zooming out packed every node inside every box and
    // collapsed the measurement to "everything contains everything".
    const boundaryOccupants: BoundaryOccupant[] = []
    for (const node of nodesRef.current) {
      const physicsNode = simulation.findNode(node.id)
      if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue
      boundaryOccupants.push({ id: node.id, x: physicsNode.x, y: physicsNode.y })
    }

    // Category, then Subcategory, then Collection boundaries — outermost
    // drawn first so nesting is purely render order, all reusing the same
    // drawCollectionBoundary renderer at a quieter `emphasis` than a
    // Collection's own (see collection-renderer.ts). Every edge/node still
    // paints on top of all of them.
    //
    // Every rect below is WORLD space, projected through the camera only at
    // the moment it is painted (worldRectToScreen). A boundary square's
    // geometry, its collider and its hit box are therefore identical at
    // every zoom level — the camera decides how big a square looks, never
    // whether it exists. Computed in screen space (as this was), the fixed
    // pixel padding dominated the box once zoomed out, so cleanly separated
    // squares collapsed into each other.
    categoryRectsRef.current.clear()
    subcategoryRectsRef.current.clear()
    const categoryLabelCandidates: (LabelBox & { node: ClusterNode })[] = []
    const subcategoryLabelCandidates: (LabelBox & { node: ClusterNode })[] = []
    const worldRectToScreen = (rect: CollectionBoundaryRect): CollectionBoundaryRect => {
      const topLeft = worldToScreen(camera, { x: rect.x, y: rect.y }, width, height)
      return { x: topLeft.x, y: topLeft.y, width: rect.width * camera.zoom, height: rect.height * camera.zoom }
    }

    if (showClusterBoundariesRef.current) {
      const clusterPoints = (tabIds: string[]): { x: number; y: number; radius: number }[] => {
        const points: { x: number; y: number; radius: number }[] = []
        for (const tabId of tabIds) {
          if (tabId === boundaryExcludedId) continue
          const physicsNode = simulation.findNode(tabId)
          if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue
          points.push({ x: physicsNode.x, y: physicsNode.y, radius: physicsNode.radius })
        }
        return points
      }

      const showCategoryLabels = camera.zoom >= CATEGORY_LABEL_MIN_ZOOM
      for (const category of clusterTreeRef.current.roots) {
        const points = clusterPoints(category.totalTabIds)
        if (points.length === 0 || (points.length === 1 && category.id !== selectedClusterId)) continue
        const rect = computeCollectionBoundary(points, CATEGORY_BOUNDARY_PADDING)
        if (!rect) continue
        categoryRectsRef.current.set(category.id, rect)
        if (showCategoryLabels) {
          const fontSize = Math.round(11 * display.textSize)
          ctx.font = `${fontSize}px ${palette.fontFamily}`
          const textWidth = ctx.measureText(category.label.toUpperCase()).width
          const screenRect = worldRectToScreen(rect)
          categoryLabelCandidates.push({
            id: category.id,
            x: screenRect.x + 4,
            y: screenRect.y - 4 - fontSize,
            width: textWidth,
            height: fontSize,
            priority: 2,
            node: category,
          })
        }
      }

      const showSubcategoryLabels = camera.zoom >= SUBCATEGORY_LABEL_MIN_ZOOM
      for (const category of clusterTreeRef.current.roots) {
        for (const sub of category.children) {
          if (sub.kind !== "subcategory") continue
          const points = clusterPoints(sub.totalTabIds)
          if (points.length === 0 || (points.length === 1 && sub.id !== selectedClusterId)) continue
          const rect = computeCollectionBoundary(points, SUBCATEGORY_BOUNDARY_PADDING)
          if (!rect) continue
          subcategoryRectsRef.current.set(sub.id, rect)
          if (showSubcategoryLabels) {
            const fontSize = Math.round(11 * display.textSize)
            ctx.font = `${fontSize}px ${palette.fontFamily}`
            const textWidth = ctx.measureText(sub.label.toUpperCase()).width
            const screenRect = worldRectToScreen(rect)
            subcategoryLabelCandidates.push({
              id: sub.id,
              x: screenRect.x + 4,
              y: screenRect.y - 4 - fontSize,
              width: textWidth,
              height: fontSize,
              priority: 1,
              node: sub,
            })
          }
        }
      }
    } else {
      categoryRectsRef.current.clear()
      subcategoryRectsRef.current.clear()
    }

    const suppressedLabels = resolveLabelOverlaps([...categoryLabelCandidates, ...subcategoryLabelCandidates])

    // Collection boundaries — a third, cross-cutting cluster kind, computed
    // regardless of showClusterBoundariesRef (Collections aren't gated by
    // the "Show category regions" toggle; see collection-renderer.ts's doc
    // comment for why they're a soft region, never an edge fanned to every
    // member).
    collectionRectsRef.current.clear()
    const collectionNameById = new Map<string, string>()
    // Built once per frame and reused by the candidate and boundary-spec
    // loops below, which each used to run a linear `.find` over every
    // collection for every collection — quadratic in the collection count for
    // no reason.
    const collectionById = new Map(collectionsRef.current.map((c) => [c.id, c]))
    for (const collection of collectionsRef.current) {
      const isSelected = collection.id === selectedCollectionId
      const points: { x: number; y: number; radius: number }[] = []
      for (const tabId of collection.tabIds) {
        if (tabId === boundaryExcludedId) continue
        const physicsNode = simulation.findNode(tabId)
        if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue
        points.push({ x: physicsNode.x, y: physicsNode.y, radius: physicsNode.radius })
      }
      // A lone visible member only gets drawn while explicitly selected —
      // otherwise every single-tab collection would paint a box around it at
      // all times, which is exactly the ambient clutter the spec warns against.
      if (points.length === 0 || (points.length === 1 && !isSelected)) continue
      const rect = computeCollectionBoundary(points)
      if (!rect) continue
      collectionRectsRef.current.set(collection.id, rect)
      collectionNameById.set(collection.id, collection.name)
    }

    // Which of those candidate boxes are LIVE — drawn, hit-testable, and
    // backed by a physics body, as one indivisible set. See
    // collection-layout.ts's resolveLiveBoundaries for the rule and for the
    // measurements behind it; the short version is that a square's existence
    // now depends only on its cluster still existing, never on where it
    // currently sits or on how far out the camera is.
    //
    // What stood here instead was a per-frame re-election: it re-ran the
    // concentration gate AND a greedy non-overlap pass against the current
    // geometry, then deleted the losers out of these three maps. Because
    // those maps also drive hit-testing and (below) setBoundaryBodies, "your
    // box overlaps a higher-priority box this instant" and "you are small on
    // screen right now" both resolved to *destroy this square's physics
    // body*. That is what made squares vanish on collision, on being dragged
    // into a neighbour, and on zooming out. Two rigid bodies overlapping is
    // the normal, expected state during a collision; it cannot also be the
    // trigger for deleting one of them. Keeping boxes from crossing is the
    // physics layer's job now — it pushes them apart, which is visible and
    // reversible, instead of hiding one, which is neither.
    const alwaysAdmitBoundaryIds = new Set<string>(
      [selectedClusterId, selectedCollectionId, draggedBoundaryId].filter((id): id is string => id !== null)
    )
    const boundaryCandidates: BoundaryCandidate[] = []
    for (const [id, rect] of categoryRectsRef.current) {
      boundaryCandidates.push({ id, rect, memberIds: new Set(clusterTreeRef.current.byId.get(id)?.totalTabIds ?? []) })
    }
    for (const [id, rect] of subcategoryRectsRef.current) {
      boundaryCandidates.push({ id, rect, memberIds: new Set(clusterTreeRef.current.byId.get(id)?.totalTabIds ?? []) })
    }
    for (const [id, rect] of collectionRectsRef.current) {
      boundaryCandidates.push({ id, rect, memberIds: new Set(collectionById.get(id)?.tabIds ?? []) })
    }
    const liveBoundaryIds = liveBoundaryIdsRef.current
    resolveLiveBoundaries(boundaryCandidates, liveBoundaryIds, boundaryOccupants, alwaysAdmitBoundaryIds)
    for (const id of [...categoryRectsRef.current.keys()]) {
      if (!liveBoundaryIds.has(id)) categoryRectsRef.current.delete(id)
    }
    for (const id of [...subcategoryRectsRef.current.keys()]) {
      if (!liveBoundaryIds.has(id)) subcategoryRectsRef.current.delete(id)
    }
    for (const id of [...collectionRectsRef.current.keys()]) {
      if (!liveBoundaryIds.has(id)) collectionRectsRef.current.delete(id)
    }

    // The box being dragged is skipped in its own tier's pass and painted
    // after all three, so it sits above every other boundary while it moves.
    const drawCategoryBoundary = (id: string, rect: CollectionBoundaryRect) => {
      const category = clusterTreeRef.current.byId.get(id)
      if (!category) return
      const hasLabelCandidate = categoryLabelCandidates.some((c) => c.id === id)
      drawCollectionBoundary(ctx, palette, worldRectToScreen(rect), {
        name: category.label,
        isSelected: id === selectedClusterId,
        isHovered: id === hoveredBoundaryId,
        showLabel: hasLabelCandidate && !suppressedLabels.has(id),
        textSize: display.textSize,
        emphasis: 0.6,
      })
    }
    const drawSubcategoryBoundary = (id: string, rect: CollectionBoundaryRect) => {
      const sub = clusterTreeRef.current.byId.get(id)
      if (!sub) return
      const hasLabelCandidate = subcategoryLabelCandidates.some((c) => c.id === id)
      drawCollectionBoundary(ctx, palette, worldRectToScreen(rect), {
        name: sub.label,
        isSelected: id === selectedClusterId,
        isHovered: id === hoveredBoundaryId,
        showLabel: hasLabelCandidate && !suppressedLabels.has(id),
        textSize: display.textSize,
        emphasis: 0.8,
      })
    }
    const drawCollectionRegion = (id: string, rect: CollectionBoundaryRect) => {
      const name = collectionNameById.get(id)
      if (name === undefined) return
      drawCollectionBoundary(ctx, palette, worldRectToScreen(rect), {
        name,
        isSelected: id === selectedCollectionId,
        isHovered: id === hoveredBoundaryId,
        showLabel: showLabels,
        textSize: display.textSize,
      })
    }

    for (const [id, rect] of categoryRectsRef.current) {
      if (id !== draggedBoundaryId) drawCategoryBoundary(id, rect)
    }
    for (const [id, rect] of subcategoryRectsRef.current) {
      if (id !== draggedBoundaryId) drawSubcategoryBoundary(id, rect)
    }
    for (const [id, rect] of collectionRectsRef.current) {
      if (id !== draggedBoundaryId) drawCollectionRegion(id, rect)
    }
    if (draggedBoundaryId) {
      const categoryRect = categoryRectsRef.current.get(draggedBoundaryId)
      const subcategoryRect = subcategoryRectsRef.current.get(draggedBoundaryId)
      const collectionRect = collectionRectsRef.current.get(draggedBoundaryId)
      if (categoryRect) drawCategoryBoundary(draggedBoundaryId, categoryRect)
      else if (subcategoryRect) drawSubcategoryBoundary(draggedBoundaryId, subcategoryRect)
      else if (collectionRect) drawCollectionRegion(draggedBoundaryId, collectionRect)
    }

    // Hand the physics layer exactly the live set — the same set that was
    // just drawn and that hit-testing reads below — so what can be grabbed
    // is always what is visible, and no square can lose its body for a
    // reason that is really about the camera or about a momentary overlap.
    // The padding is already world-space, so there is no zoom conversion
    // here any more: the collider matches the drawn rect at every zoom by
    // construction rather than by cancelling one scale against another.
    //
    // The sandbox is deliberately NOT set from here. Walls are a property of
    // the world, not of the viewport (see engine.ts's worldSandbox); derived
    // from the visible rect, as they were, zooming in physically squeezed
    // every square toward the middle of the graph — a camera change silently
    // rewriting the tab positions the graph persists.
    const boundarySpecs: { id: string; memberIds: string[]; padding: number }[] = []
    for (const id of categoryRectsRef.current.keys()) {
      const cluster = clusterTreeRef.current.byId.get(id)
      if (cluster) boundarySpecs.push({ id, memberIds: cluster.totalTabIds, padding: CATEGORY_BOUNDARY_PADDING })
    }
    for (const id of subcategoryRectsRef.current.keys()) {
      const cluster = clusterTreeRef.current.byId.get(id)
      if (cluster) boundarySpecs.push({ id, memberIds: cluster.totalTabIds, padding: SUBCATEGORY_BOUNDARY_PADDING })
    }
    for (const id of collectionRectsRef.current.keys()) {
      const collection = collectionById.get(id)
      if (collection) boundarySpecs.push({ id, memberIds: collection.tabIds, padding: COLLECTION_BOUNDARY_PADDING })
    }
    simulation.setBoundaryBodies(boundarySpecs)

    const clusterPathOfTab = clusterTreeRef.current.clusterPathOfTab
    for (const edge of edgesRef.current) {
      const source = simulation.findNode(edge.source)
      const target = simulation.findNode(edge.target)
      if (!source || source.x === undefined || source.y === undefined) continue
      if (!target || target.x === undefined || target.y === undefined) continue
      const p1 = worldToScreen(camera, { x: source.x, y: source.y }, width, height)
      const p2 = worldToScreen(camera, { x: target.x, y: target.y }, width, height)
      const isHighlighted = Boolean(neighborInfo?.edgeIds.has(edge.id))
      const isDimmed = Boolean(selectedTabId) && !isHighlighted
      const sourceCategory = clusterPathOfTab.get(edge.source)?.[0]
      const targetCategory = clusterPathOfTab.get(edge.target)?.[0]
      const isCrossCluster = Boolean(sourceCategory && targetCategory && sourceCategory !== targetCategory)
      const isWeak = edge.reasons.length === 1 && (edge.reasons[0] === "domain" || edge.reasons[0] === "workspace")
      drawEdge(ctx, palette, {
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        reasons: edge.reasons,
        isHighlighted,
        isDimmed,
        isCrossCluster,
        isWeak,
      })
    }

    const now = performance.now()

    for (const edge of dependencyEdgesRef.current) {
      const source = simulation.findNode(edge.parentTabId)
      const target = simulation.findNode(edge.childTabId)
      if (!source || source.x === undefined || source.y === undefined) continue
      if (!target || target.x === undefined || target.y === undefined) continue
      const p1 = worldToScreen(camera, { x: source.x, y: source.y }, width, height)
      const p2 = worldToScreen(camera, { x: target.x, y: target.y }, width, height)
      const isHighlighted = Boolean(neighborInfo?.dependencyEdgeIds.has(edge.id))
      const isDimmed = Boolean(selectedTabId) && !isHighlighted
      drawDependencyEdge(ctx, palette, {
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        targetRadius: target.radius * camera.zoom,
        isHighlighted,
        isDimmed,
      })

      // A freshly-created dependency animates a small pulse traveling from
      // parent to child, on top of the edge drawn above, instead of just
      // popping the relationship into existence.
      const createEffect = depEdgeEffectsRef.current.get(edge.id)
      if (createEffect?.kind === "create") {
        const progress = Math.min(1, (now - createEffect.start) / EDGE_CREATE_PULSE_MS)
        const t = easeOutCubic(progress)
        const px = p1.x + (p2.x - p1.x) * t
        const py = p1.y + (p2.y - p1.y) * t
        ctx.save()
        ctx.globalAlpha = 0.9 * (1 - progress)
        ctx.beginPath()
        ctx.arc(px, py, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = palette.edgeDependencyHighlighted
        ctx.fill()
        ctx.restore()
      }
    }

    // Edges/nodes that just left the visible set finish their fade/shrink
    // here, using the position snapshotted at removal time (see the
    // physics-setup effect) reprojected through the *current* camera so a
    // pan/zoom mid-fade still tracks correctly.
    for (const effect of depEdgeEffectsRef.current.values()) {
      if (effect.kind !== "remove") continue
      const progress = Math.min(1, (now - effect.start) / EDGE_REMOVE_MS)
      const p1 = worldToScreen(camera, { x: effect.x1, y: effect.y1 }, width, height)
      const p2 = worldToScreen(camera, { x: effect.x2, y: effect.y2 }, width, height)
      drawDependencyEdge(ctx, palette, {
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        targetRadius: effect.targetRadius * camera.zoom,
        isHighlighted: false,
        isDimmed: false,
        opacity: 1 - progress,
      })
    }

    for (const ghost of leavingNodesRef.current.values()) {
      const progress = Math.min(1, (now - ghost.start) / NODE_EXIT_MS)
      const screen = worldToScreen(camera, { x: ghost.x, y: ghost.y }, width, height)
      const radius = ghost.radius * camera.zoom * (1 - progress * 0.5)
      if (radius <= 0.5) continue
      ctx.save()
      ctx.globalAlpha = (1 - progress) * 0.85
      ctx.beginPath()
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = palette.nodeStroke
      ctx.stroke()
      ctx.restore()
    }

    for (const node of nodesRef.current) {
      const physicsNode = simulation.findNode(node.id)
      if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue
      const screen = worldToScreen(camera, { x: physicsNode.x, y: physicsNode.y }, width, height)
      if (
        screen.x < -40 ||
        screen.x > width + 40 ||
        screen.y < -40 ||
        screen.y > height + 40
      ) {
        continue
      }

      const visual = visualRef.current.get(node.id)
      const visualAlpha = visual ? visual.alpha : 1
      const visualScale = visual ? visual.scale : 1
      if (visualAlpha <= 0.01 || visualScale <= 0.01) continue

      const category = (node.tab.category as CategoryId | undefined) ?? "other"
      const color = palette.category[category] ?? palette.category.other

      const isSelected = node.id === selectedTabId
      const isCenter = node.id === centerTabId
      const isMatch = hasSearch && searchMatches!.has(node.id)
      const isHovered = node.id === hoveredIdRef.current

      drawNode(ctx, palette, {
        x: screen.x,
        y: screen.y,
        radius: physicsNode.radius * camera.zoom,
        label: node.tab.title?.trim() || node.tab.domain,
        color,
        favicon: getFavicon(node.tab.domain),
        isSelected,
        isHovered,
        isCenter,
        isDimmed: false,
        isMatch,
        isFavorite: node.tab.isFavorite === true,
        showLabel: showLabels || isHovered,
        textSize: display.textSize,
        visualAlpha,
        visualScale,
      })
    }

    // Report the selected node's live screen anchor for the host's
    // persistent Tab Peek popup — entirely separate from hover, so panning,
    // zooming, or dragging keeps the popup attached to the node itself
    // while hovering elsewhere on the canvas never touches it. Hidden (like
    // the node itself, above) once it's scrolled far enough off-screen that
    // anchoring a popup to it would be misleading rather than useful.
    const selectedNode = selectedTabId ? nodesRef.current.find((n) => n.id === selectedTabId) ?? null : null
    const selectedPhysicsNode = selectedNode ? simulation.findNode(selectedNode.id) : null
    let nextReported: { id: string; x: number; y: number } | null = null
    if (selectedNode && selectedPhysicsNode?.x !== undefined && selectedPhysicsNode?.y !== undefined) {
      const screen = worldToScreen(camera, { x: selectedPhysicsNode.x, y: selectedPhysicsNode.y }, width, height)
      if (screen.x >= -40 && screen.x <= width + 40 && screen.y >= -40 && screen.y <= height + 40) {
        nextReported = {
          id: selectedNode.id,
          x: screen.x + canvasRectRef.current.left,
          y: screen.y + canvasRectRef.current.top,
        }
      }
    }
    const lastReported = lastReportedSelectedRef.current
    const changed =
      (nextReported === null) !== (lastReported === null) ||
      (nextReported !== null &&
        lastReported !== null &&
        (nextReported.id !== lastReported.id ||
          Math.abs(nextReported.x - lastReported.x) > 0.5 ||
          Math.abs(nextReported.y - lastReported.y) > 0.5))
    if (changed) {
      lastReportedSelectedRef.current = nextReported
      onSelectedNodeScreenChange(
        nextReported && selectedNode ? { node: selectedNode, screenX: nextReported.x, screenY: nextReported.y } : null
      )
    }
  }

  // Physics setup: reruns whenever the visible node/edge set or size-affecting
  // settings change (a filter toggle, workspace switch, local-graph depth) —
  // not per frame. Existing physics nodes keep their live position (see
  // engine.ts's setNodes), so this never causes a jarring re-layout flash.
  useEffect(() => {
    const simulation = simulationRef.current!
    const reduced = reducedMotionRef.current
    const now = performance.now()

    // Diff node arrivals/departures against the *previous* pass, using the
    // still-live physics positions before setNodes() below replaces them —
    // this is what lets a removed node leave behind an accurate "ghost" at
    // its last real position (see leavingNodesRef) and a newly-added one pop
    // in from nothing (see visualRef) instead of just appearing.
    const nextNodeIds = new Set(nodes.map((n) => n.id))
    if (prevNodeIdsRef.current) {
      for (const id of prevNodeIdsRef.current) {
        if (nextNodeIds.has(id)) continue
        const physicsNode = simulation.findNode(id)
        if (physicsNode?.x !== undefined && physicsNode?.y !== undefined && !reduced) {
          leavingNodesRef.current.set(id, { x: physicsNode.x, y: physicsNode.y, radius: physicsNode.radius, start: now })
        }
        visualRef.current.delete(id)
      }
    }
    for (const id of nextNodeIds) {
      if (visualRef.current.has(id)) continue
      visualRef.current.set(
        id,
        reduced ? { alpha: 1, scale: 1, delayUntil: 0 } : { alpha: 0, scale: 0, delayUntil: now + jitterFor(id, ARRIVAL_JITTER_MS) }
      )
    }
    prevNodeIdsRef.current = nextNodeIds

    // Same idea for dependency edges: a newly-created one gets a traveling
    // pulse, a removed one gets a fade using its last known endpoints.
    if (!reduced) {
      const prevById = new Map(prevDependencyEdgesRef.current.map((e) => [e.id, e]))
      for (const edge of dependencyEdges) {
        if (!prevById.has(edge.id)) depEdgeEffectsRef.current.set(edge.id, { kind: "create", start: now })
      }
      const nextById = new Map(dependencyEdges.map((e) => [e.id, e]))
      for (const edge of prevDependencyEdgesRef.current) {
        if (nextById.has(edge.id)) continue
        const source = simulation.findNode(edge.parentTabId)
        const target = simulation.findNode(edge.childTabId)
        if (source?.x !== undefined && source.y !== undefined && target?.x !== undefined && target.y !== undefined) {
          depEdgeEffectsRef.current.set(edge.id, {
            kind: "remove",
            start: now,
            x1: source.x,
            y1: source.y,
            x2: target.x,
            y2: target.y,
            targetRadius: target.radius,
          })
        }
      }
    }
    prevDependencyEdgesRef.current = dependencyEdges

    // A brand-new node is seeded into its cluster's CONFINEMENT disc (the
    // area its members are actually held in — see cluster-regions.ts) rather
    // than at a bare anchor point, so the engine can pack a whole arrival
    // across the space it will end up occupying instead of stacking it on one
    // spot. Falls back to the category anchor for tabs with no confinement
    // region (ring layout mode), which is what this always passed.
    simulation.setNodes(nodes, radiusOf, positions, (node) => {
      const anchor = clusterAnchors.get(node.id)
      return anchor?.confineTo ?? anchor?.categoryAnchor ?? undefined
    })
    // After setNodes (which prunes offsets for tabs that are gone) and before
    // setClusterAnchors, so a category dragged in a past session has its
    // territory back where the user left it rather than snapping home.
    simulation.seedBoundaryOffsets(boundaryOffsets)
    const physicsEdges: GraphEdge[] = [
      ...edges,
      ...dependencyEdges.map((e) => ({ id: e.id, source: e.parentTabId, target: e.childTabId, reasons: [] })),
    ]
    simulation.setEdges(physicsEdges, display.edgeStrength)
    simulation.setCollections(collections)
    simulation.setClusterAnchors(clusterAnchors)

    // Only reheat when the STRUCTURE actually changed. See
    // structureSignatureRef: this effect also fires for cosmetic updates
    // (a resolved title rewrites every Tab object), and reheating on those
    // restarted the settle over and over so the layout never finished.
    const signature = structureSignature(nodes, physicsEdges, collections, {
      nodeSize: display.nodeSize,
      edgeStrength: display.edgeStrength,
    })
    const structureChanged = signature !== structureSignatureRef.current
    structureSignatureRef.current = signature

    const everyNodePositioned = nodes.length > 0 && nodes.every((node) => positions[node.id])
    const firstPass = isFirstPhysicsPassRef.current
    isFirstPhysicsPassRef.current = false

    const arrivals = simulation.lastArrivalCount()
    if (firstPass && layoutSettled && everyNodePositioned) {
      // A layout that was already settled for exactly this graph has nothing
      // left to lay out, so the first physics pass after mount cools instead
      // of reheating: the first frame IS the final frame. That is the whole
      // point of settling before the Graph View is unlocked
      // (lib/graph/precompute.ts) — reheating here would re-run ~200 ticks
      // from those settled positions and move nodes hundreds of world units
      // (measured), which is exactly the "graph opens, then everything
      // rearranges" this exists to remove.
      //
      // Checked BEFORE the bulk burst below, and only on the FIRST pass: a
      // matching layoutKey means that burst has already been run, offline,
      // over this very node set, so running it again would undo the point of
      // having waited. Every later run of this effect is a real change (a
      // filter toggled, a workspace switched, tabs added or removed) and
      // reheats normally, as do drags and boundary moves.
      simulation.cool()
    } else if (arrivals >= BULK_ARRIVAL_THRESHOLD) {
      // A bulk dump. The nodes have just been placed deterministically across
      // their clusters (engine.ts's setNodes), so what is left is refinement,
      // not layout — and refinement is exactly the part there is no reason to
      // animate across several hundred frames. One bounded, budgeted burst of
      // ticks here means the first frame the user sees is an organised graph
      // easing into place rather than a cloud reorganising itself.
      //
      // Bounded on both axes so this can never become a hang: at most
      // BULK_PRESETTLE_TICKS ticks, and at most BULK_PRESETTLE_BUDGET_MS of
      // wall clock. Whatever is left settles normally in the render loop.
      //
      // Deliberately no reheat afterwards: if the burst converged, the graph
      // is where it belongs and putting alpha back up would only make it
      // drift for another couple of seconds for show. If the burst ran out of
      // budget instead, alpha is still high and the render loop picks the
      // remaining convergence up on its own, animated.
      simulation.reheat(0.5)
      simulation.settleBulk(BULK_PRESETTLE_TICKS, BULK_PRESETTLE_BUDGET_MS)
    } else if (structureChanged) {
      simulation.reheat(0.4)
    }
    requestDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, dependencyEdges, collections, clusterTree, clusterAnchors, display.nodeSize, display.edgeStrength, centerDistances])

  // Selection/search/center-node/collection highlighting only affects what
  // draw() paints, not the physics simulation — once the layout has settled
  // and the render loop has stopped, changing these alone would otherwise
  // leave the canvas showing a stale frame until something else (a drag, a
  // pan) happens to wake the loop back up.
  useEffect(() => {
    requestDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTabId, centerTabId, searchMatches, selectedCollectionId, selectedClusterId, showClusterBoundaries])

  // Resize handling.
  useEffect(() => {
    const wrapper = wrapperRef.current
    const canvas = canvasRef.current
    if (!wrapper || !canvas) return

    function applySize() {
      const rect = wrapper!.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { width: rect.width, height: rect.height }
      canvasRectRef.current = { left: rect.left, top: rect.top }
      canvas!.width = Math.max(1, Math.round(rect.width * dpr))
      canvas!.height = Math.max(1, Math.round(rect.height * dpr))
      canvas!.style.width = `${rect.width}px`
      canvas!.style.height = `${rect.height}px`
      const ctx = canvas!.getContext("2d")
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
      requestDraw()
    }

    applySize()
    const observer = new ResizeObserver(applySize)
    observer.observe(wrapper)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Palette reads resolved CSS custom properties, which are only reliably
  // available once the stylesheet has applied — re-resolve once after mount.
  useEffect(() => {
    paletteRef.current = resolveGraphPalette()
    requestDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    reducedMotionRef.current = query.matches
    function handleChange(e: MediaQueryListEvent) {
      reducedMotionRef.current = e.matches
    }
    query.addEventListener("change", handleChange)
    return () => query.removeEventListener("change", handleChange)
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space") spaceHeldRef.current = true
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") spaceHeldRef.current = false
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
    }
  }, [])

  useEffect(() => {
    // Setup un-does the cleanup's unmountedRef flag, so React StrictMode's
    // dev-only mount→cleanup→mount simulation ends this effect back in the
    // "mounted" state — only a real, final unmount leaves it set.
    unmountedRef.current = false
    return () => {
      // Resetting runningRef alongside the cancel matters for the same
      // StrictMode simulation: without it, this cleanup cancels the
      // in-flight frame but leaves runningRef stuck at true, so the second
      // mount's startLoopIfNeeded() believes a loop is already active and
      // never schedules a replacement — the canvas would render nothing,
      // forever, in dev. unmountedRef itself guards against a favicon
      // Image's onload firing after a genuine unmount and resurrecting the
      // loop via requestDraw().
      unmountedRef.current = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      runningRef.current = false
    }
  }, [])

  /** Fits the camera to every tab currently belonging to cluster `id` (its own direct members plus every descendant's, via ClusterNode.totalTabIds) — same computeFitCamera/animateCameraTo mechanism as focusCollection above, just sourced from the cluster tree instead of a Collection. */
  function focusClusterById(id: string) {
    const simulation = simulationRef.current!
    const { width, height } = sizeRef.current
    const cluster = clusterTreeRef.current.byId.get(id)
    if (!cluster) return
    const points = cluster.totalTabIds
      .map((tabId) => simulation.findNode(tabId))
      .filter((n): n is NonNullable<typeof n> => Boolean(n && n.x !== undefined && n.y !== undefined))
      .map((n) => ({ x: n.x!, y: n.y!, radius: n.radius }))
    if (points.length === 0) return
    const next = computeFitCamera(points, width, height)
    animateCameraTo(next)
  }

  useImperativeHandle(ref, () => ({
    zoomBy(factor: number) {
      const { width, height } = sizeRef.current
      const next = zoomAroundPoint(
        cameraRef.current,
        { x: width / 2, y: height / 2 },
        cameraRef.current.zoom * factor,
        width,
        height
      )
      cameraRef.current = next
      onCameraChange(next)
      requestDraw()
    },
    fitToView() {
      const simulation = simulationRef.current!
      const { width, height } = sizeRef.current
      const points = nodesRef.current
        .map((n) => simulation.findNode(n.id))
        .filter((n): n is NonNullable<typeof n> => Boolean(n && n.x !== undefined && n.y !== undefined))
        .map((n) => ({ x: n.x!, y: n.y!, radius: n.radius }))
      const next = computeFitCamera(points, width, height)
      animateCameraTo(next)
    },
    centerOnNode(id: string) {
      const simulation = simulationRef.current!
      const node = simulation.findNode(id)
      if (!node || node.x === undefined || node.y === undefined) return
      const next: CameraState = { x: node.x, y: node.y, zoom: Math.max(cameraRef.current.zoom, 1) }
      animateCameraTo(next)
    },
    focusCollection(id: string) {
      const simulation = simulationRef.current!
      const { width, height } = sizeRef.current
      const collection = collectionsRef.current.find((c) => c.id === id)
      if (!collection) return
      const points = collection.tabIds
        .map((tabId) => simulation.findNode(tabId))
        .filter((n): n is NonNullable<typeof n> => Boolean(n && n.x !== undefined && n.y !== undefined))
        .map((n) => ({ x: n.x!, y: n.y!, radius: n.radius }))
      if (points.length === 0) return
      const next = computeFitCamera(points, width, height)
      animateCameraTo(next)
    },
    focusCluster(id: string) {
      focusClusterById(id)
    },
  }))

  /**
   * The world point under a screen point. Every boundary hit-test below
   * works in world space, because that is the space the boundary rects are
   * kept in — so a box is exactly as clickable zoomed out as zoomed in.
   */
  function worldPointFromScreen(screenX: number, screenY: number): { x: number; y: number } {
    const { width, height } = sizeRef.current
    return screenToWorld(cameraRef.current, { x: screenX, y: screenY }, width, height)
  }

  /**
   * The world-space grab margin around a boundary square, converted from the
   * constant screen-pixel tolerance the user actually experiences. Dividing
   * by zoom is what keeps the cushion the same size under the cursor at every
   * zoom level — see BOUNDARY_HIT_TOLERANCE_PX.
   */
  function boundaryHitTolerance(): number {
    return BOUNDARY_HIT_TOLERANCE_PX / Math.max(cameraRef.current.zoom, 0.0001)
  }

  /**
   * THE boundary hit test — the single place a pointer position becomes a
   * boundary id. Grabbing (pointerdown), hover feedback (pointermove) and
   * click-to-select (pointerup) all go through it, so what lights up under
   * the cursor, what a press picks up, and what a click selects can never be
   * three different squares.
   *
   * Reuses the exact rect maps draw() left behind — the live set — so what is
   * grabbable is precisely what is on screen and what has a physics body.
   * The containment-then-tolerance rule itself lives in collection-layout.ts
   * (`hitTestBoundaryRects`) where it can be tested without a canvas.
   */
  function hitTestBoundary(screenX: number, screenY: number): string | null {
    const world = worldPointFromScreen(screenX, screenY)
    return hitTestBoundaryRects(
      [collectionRectsRef.current, subcategoryRectsRef.current, categoryRectsRef.current],
      world.x,
      world.y,
      boundaryHitTolerance()
    )
  }

  function hitTestNode(screenX: number, screenY: number): GraphNode | null {
    const simulation = simulationRef.current!
    const { width, height } = sizeRef.current
    const camera = cameraRef.current
    // Iterate in reverse draw order so a visually-on-top node wins ties.
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i]
      const physicsNode = simulation.findNode(node.id)
      if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue
      const screen = worldToScreen(camera, { x: physicsNode.x, y: physicsNode.y }, width, height)
      const radius = physicsNode.radius * camera.zoom + 3
      const dx = screenX - screen.x
      const dy = screenY - screen.y
      if (dx * dx + dy * dy <= radius * radius) return node
    }
    return null
  }

  function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq
    t = Math.max(0, Math.min(1, t))
    const projX = a.x + t * dx
    const projY = a.y + t * dy
    return Math.hypot(p.x - projX, p.y - projY)
  }

  function hitTestEdge(screenX: number, screenY: number): GraphEdge | null {
    const simulation = simulationRef.current!
    const { width, height } = sizeRef.current
    const camera = cameraRef.current
    for (const edge of edgesRef.current) {
      const source = simulation.findNode(edge.source)
      const target = simulation.findNode(edge.target)
      if (!source?.x || !source?.y || !target?.x || !target?.y) continue
      const p1 = worldToScreen(camera, { x: source.x, y: source.y }, width, height)
      const p2 = worldToScreen(camera, { x: target.x, y: target.y }, width, height)
      if (distanceToSegment({ x: screenX, y: screenY }, p1, p2) <= EDGE_HIT_PADDING) return edge
    }
    return null
  }

  // Checked ahead of hitTestEdge on click — dependency edges are drawn on
  // top of (and are typically fewer than) the relation edges, so a click
  // near an overlapping pair should resolve to the more specific,
  // intentionally-created dependency relationship.
  function hitTestDependencyEdge(screenX: number, screenY: number): GraphDependencyEdge | null {
    const simulation = simulationRef.current!
    const { width, height } = sizeRef.current
    const camera = cameraRef.current
    for (const edge of dependencyEdgesRef.current) {
      const source = simulation.findNode(edge.parentTabId)
      const target = simulation.findNode(edge.childTabId)
      if (!source?.x || !source?.y || !target?.x || !target?.y) continue
      const p1 = worldToScreen(camera, { x: source.x, y: source.y }, width, height)
      const p2 = worldToScreen(camera, { x: target.x, y: target.y }, width, height)
      if (distanceToSegment({ x: screenX, y: screenY }, p1, p2) <= EDGE_HIT_PADDING) return edge
    }
    return null
  }

  function screenPointFromEvent(e: { clientX: number; clientY: number }) {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const point = screenPointFromEvent(e)
    const isMiddle = e.button === 1
    const isSpacePan = e.button === 0 && spaceHeldRef.current

    if (isMiddle || isSpacePan) {
      e.preventDefault()
      canvasRef.current?.setPointerCapture(e.pointerId)
      panRef.current = { startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, pointerId: e.pointerId }
      return
    }

    if (e.button !== 0) return

    const hit = hitTestNode(point.x, point.y)
    canvasRef.current?.setPointerCapture(e.pointerId)

    if (hit) {
      const simulation = simulationRef.current!
      const physicsNode = simulation.findNode(hit.id)
      if (physicsNode?.x !== undefined && physicsNode?.y !== undefined) {
        simulation.pin(hit.id, physicsNode.x, physicsNode.y)
      }
      // The dragged tab stops counting toward its groups' geometry for the
      // duration of the gesture, so dragging one member can't stretch the
      // boxes around it (or their colliders, which would then shove every
      // neighbouring square). See engine.ts's setBoundaryExcluded.
      simulation.setBoundaryExcluded(hit.id)
      simulation.reheat(0.35)
      dragRef.current = { id: hit.id, startX: point.x, startY: point.y, pointerId: e.pointerId }
      requestDraw()
      return
    }

    // No node under the pointer: grab the boundary square there, if any, and
    // drag it as a physics body. Pressing on bare canvas still pans, and
    // space-drag / middle-drag still pan from anywhere.
    const boundaryHit = hitTestBoundary(point.x, point.y)
    if (boundaryHit) {
      const { width, height } = sizeRef.current
      const world = screenToWorld(cameraRef.current, point, width, height)
      if (simulationRef.current!.beginBoundaryDrag(boundaryHit, world.x, world.y)) {
        boundaryDragRef.current = { id: boundaryHit, startX: point.x, startY: point.y, pointerId: e.pointerId }
        requestDraw()
        return
      }
    }

    panRef.current = { startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, pointerId: e.pointerId }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const point = screenPointFromEvent(e)
    const { width, height } = sizeRef.current

    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      const world = screenToWorld(cameraRef.current, point, width, height)
      simulationRef.current!.pin(dragRef.current.id, world.x, world.y)
      // A small top-up rather than a re-kick. The dragged node is pinned, so
      // it follows the pointer exactly whatever alpha is; alpha only governs
      // how hard its NEIGHBOURS react, and re-heating to 0.35 on every
      // pointermove event (dozens per second) held the whole graph at high
      // alpha for as long as the gesture lasted — one tab being moved kept
      // several hundred unrelated tabs churning.
      simulationRef.current!.reheat(0.12)
      requestDraw()
      return
    }

    if (boundaryDragRef.current && boundaryDragRef.current.pointerId === e.pointerId) {
      const world = screenToWorld(cameraRef.current, point, width, height)
      simulationRef.current!.moveBoundaryDrag(world.x, world.y)
      // The box physically carries its tabs with it, so nudge the node layout
      // awake to re-settle around where they now are.
      simulationRef.current!.reheat(0.2)
      requestDraw()
      return
    }

    if (panRef.current && panRef.current.pointerId === e.pointerId) {
      const dxScreen = point.x - panRef.current.lastX
      const dyScreen = point.y - panRef.current.lastY
      const camera = cameraRef.current
      cameraRef.current = {
        ...camera,
        x: camera.x - dxScreen / camera.zoom,
        y: camera.y - dyScreen / camera.zoom,
      }
      panRef.current.lastX = point.x
      panRef.current.lastY = point.y
      requestDraw()
      return
    }

    const hit = hitTestNode(point.x, point.y)
    const hitId = hit?.id ?? null
    // Only cross a React state update (and thus a GraphView re-render) when
    // the hovered node actually changes, not on every pixel of mousemove —
    // otherwise idling the cursor over the canvas would re-render the whole
    // view (sidebar included) dozens of times a second for no visible gain.
    if (hitId !== hoveredIdRef.current) {
      hoveredIdRef.current = hitId
      hoverNeighborsRef.current = hitId ? computeNeighborIds(hitId) : null
      requestDraw()
      onHoverChange(hit ? { node: hit, screenX: e.clientX, screenY: e.clientY } : null)
    }

    // Boundary hover: purely a canvas repaint (no React state), and only when
    // no node is under the cursor — a tab always outranks the group it sits
    // in, so highlighting the group while pointing at one of its tabs would
    // advertise the wrong target.
    const boundaryHoverId = hitId ? null : hitTestBoundary(point.x, point.y)
    if (boundaryHoverId !== hoveredBoundaryIdRef.current) {
      hoveredBoundaryIdRef.current = boundaryHoverId
      requestDraw()
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const point = screenPointFromEvent(e)

    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      const { id, startX, startY } = dragRef.current
      const moved = Math.hypot(point.x - startX, point.y - startY) > CLICK_DRAG_THRESHOLD
      const physicsNode = simulationRef.current!.findNode(id)
      simulationRef.current!.unpin(id)
      // Back into its groups' geometry. d3 keeps a pinned node's velocity at
      // zero for as long as it is pinned, so a released tab rejoins the
      // simulation at rest however fast the pointer was moving — a flick can
      // never hand it an impulse. The boxes it belongs to grow back over it
      // on the next frame, and confineToRegions walks it home if the drag
      // left it outside its own region.
      simulationRef.current!.setBoundaryExcluded(null)
      dragRef.current = null
      canvasRef.current?.releasePointerCapture(e.pointerId)
      requestDraw()

      if (moved && physicsNode?.x !== undefined && physicsNode?.y !== undefined) {
        onNodeMoved(id, physicsNode.x, physicsNode.y)
      } else {
        const node = nodeById.get(id)
        if (node) {
          // Clicking a node always wins over any collection/cluster
          // selection — node, collection, and cluster selection are
          // mutually exclusive states.
          onSelectCollection(null)
          onSelectCluster(null)
          onSelectNode(node.id === selectedTabId ? null : node.id)
        }
      }
      return
    }

    if (boundaryDragRef.current && boundaryDragRef.current.pointerId === e.pointerId) {
      const { startX, startY } = boundaryDragRef.current
      const moved = Math.hypot(point.x - startX, point.y - startY) > CLICK_DRAG_THRESHOLD
      boundaryDragRef.current = null
      // Hands the box back to the physics with a damped, capped share of the
      // pointer's speed — see boundary-physics.ts's releaseVelocity.
      simulationRef.current!.endBoundaryDrag()
      canvasRef.current?.releasePointerCapture(e.pointerId)
      flushBoundaryPositions()
      requestDraw()
      // Below the drag threshold this was a click, not a drag: resolve it the
      // same way pressing bare canvas would, so selecting a Collection or a
      // cluster by clicking its box still works.
      if (!moved) resolveCanvasClick(point, e.clientX, e.clientY)
      return
    }

    if (panRef.current && panRef.current.pointerId === e.pointerId) {
      const { startX, startY } = panRef.current
      const moved = Math.hypot(point.x - startX, point.y - startY) > CLICK_DRAG_THRESHOLD
      panRef.current = null
      canvasRef.current?.releasePointerCapture(e.pointerId)
      onCameraChange(cameraRef.current)
      if (!moved) resolveCanvasClick(point, e.clientX, e.clientY)
      return
    }
  }

  /**
   * What a press that ended without meaningful movement resolves to. The
   * interaction hierarchy, top to bottom:
   *
   *   node  →  dependency edge  →  relation edge  →  boundary  →  background
   *
   * A node is handled before this function is ever reached (handlePointerDown
   * claims it on press, and handlePointerUp turns a press-without-drag into a
   * node selection), which is what gives a tab unconditional priority over
   * the group it sits inside. Edges come next because they are thin targets
   * drawn on top. A boundary claims everything left over inside it — the
   * group's empty space — and bare canvas clears the selection.
   *
   * The boundary step asks `hitTestBoundary`, the SAME function that decides
   * what a press grabs and what the hover highlight lights up, then routes to
   * the right callback by looking up which tier's map the winning id came
   * from. It used to ask a separate collection-then-subcategory-then-category
   * scan instead, which could disagree with the grab test: pressing inside a
   * small Subcategory box that sat within a larger Collection box picked up
   * the Subcategory but selected the Collection.
   *
   * Shared by the pan gesture and the boundary-drag gesture so that grabbing
   * a boundary square and letting go without moving it still behaves exactly
   * like the click it used to be.
   */
  function resolveCanvasClick(point: { x: number; y: number }, clientX: number, clientY: number) {
    const dependencyHit = hitTestDependencyEdge(point.x, point.y)
    if (dependencyHit) {
      onDependencyEdgeClick(dependencyHit, clientX, clientY)
      return
    }
    const edgeHit = hitTestEdge(point.x, point.y)
    if (edgeHit) {
      onEdgeClick(edgeHit, clientX, clientY)
      return
    }

    const boundaryHit = hitTestBoundary(point.x, point.y)
    if (boundaryHit && collectionRectsRef.current.has(boundaryHit)) {
      onSelectNode(null)
      onSelectCluster(null)
      onSelectCollection(boundaryHit === selectedCollectionIdRef.current ? null : boundaryHit)
      return
    }
    if (boundaryHit) {
      onSelectNode(null)
      onSelectCollection(null)
      const next = boundaryHit === selectedClusterIdRef.current ? null : boundaryHit
      onSelectCluster(next)
      // Selecting a cluster also frames it — a cluster carries much less
      // UI chrome than a Collection (no dedicated sidebar action panel),
      // so auto-focusing on select reads as more natural than requiring
      // a separate explicit "Focus" action.
      if (next) focusClusterById(next)
      return
    }

    onSelectNode(null)
    onSelectCollection(null)
    onSelectCluster(null)
  }

  function handlePointerLeave() {
    if (hoveredBoundaryIdRef.current !== null) {
      hoveredBoundaryIdRef.current = null
      requestDraw()
    }
    if (hoveredIdRef.current === null) return
    hoveredIdRef.current = null
    hoverNeighborsRef.current = null
    requestDraw()
    onHoverChange(null)
  }

  function handleDoubleClick(e: ReactMouseEvent<HTMLCanvasElement>) {
    const point = screenPointFromEvent(e)
    const hit = hitTestNode(point.x, point.y)
    if (hit) onOpenNode(hit)
  }

  function handleContextMenu(e: ReactMouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const point = screenPointFromEvent(e)
    const hit = hitTestNode(point.x, point.y)
    if (hit) onContextMenu(hit, e.clientX, e.clientY)
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault()
    const point = screenPointFromEvent(e)
    const { width, height } = sizeRef.current

    const isPinch = e.ctrlKey
    const isHorizontalPan = !isPinch && Math.abs(e.deltaX) > Math.abs(e.deltaY)

    if (isHorizontalPan) {
      const camera = cameraRef.current
      cameraRef.current = {
        ...camera,
        x: camera.x + e.deltaX / camera.zoom,
        y: camera.y + e.deltaY / camera.zoom,
      }
    } else {
      const factor = Math.exp(-e.deltaY * 0.0018)
      cameraRef.current = zoomAroundPoint(cameraRef.current, point, clampZoom(cameraRef.current.zoom * factor), width, height)
    }
    onCameraChange(cameraRef.current)
    requestDraw()
  }

  // React's onWheel prop is registered as a passive listener, so
  // e.preventDefault() inside it silently fails (and logs a console error) —
  // the browser's native page/element scroll still fires alongside our zoom.
  // A manually-attached listener with { passive: false } is the only way to
  // actually suppress that default scroll while zooming the canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.addEventListener("wheel", handleWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", handleWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={wrapperRef} className="relative h-full w-full touch-none overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />
    </div>
  )
})
