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
import { createGraphSimulation, type GraphSimulation } from "@/lib/graph/engine"
import { computeNodeRadius } from "@/lib/graph/node-size"
import { resolveGraphPalette, type GraphPalette } from "@/lib/graph/palette"
import {
  clampZoom,
  computeFitCamera,
  screenToWorld,
  worldToScreen,
  zoomAroundPoint,
} from "@/lib/graph/layout"
import { computeCollectionBoundary, pointInRect, type CollectionBoundaryRect } from "@/lib/graph/collection-layout"
import { buildDegreeMap } from "@/lib/graph/relations"
import type { CameraState, GraphDependencyEdge, GraphDisplaySettings, GraphEdge, GraphNode } from "@/lib/graph/types"
import type { CategoryId } from "@/lib/categories"
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
}

export type HoverInfo = {
  node: GraphNode
  screenX: number
  screenY: number
}

const CLICK_DRAG_THRESHOLD = 4
const EDGE_HIT_PADDING = 6
const LABEL_MIN_ZOOM = 0.55

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

/** Deterministic per-id jitter (0..range) so simultaneous arrivals don't move in lockstep. */
function jitterFor(id: string, range: number): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return Math.abs(hash) % range
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, {
  nodes: GraphNode[]
  edges: GraphEdge[]
  dependencyEdges: GraphDependencyEdge[]
  positions: Record<string, { x: number; y: number }>
  initialCamera: CameraState
  display: GraphDisplaySettings
  selectedTabId: string | null
  centerTabId: string | null
  centerDistances?: Map<string, number>
  searchMatches: Set<string> | null
  /** Collections visible in the current scope — drawn as soft boundary regions behind their member nodes (never as edges; see collection-renderer.ts). */
  collections: GraphCollection[]
  selectedCollectionId: string | null
  onCameraChange: (camera: CameraState) => void
  onSelectNode: (id: string | null) => void
  onSelectCollection: (id: string | null) => void
  onOpenNode: (node: GraphNode) => void
  onContextMenu: (node: GraphNode, screenX: number, screenY: number) => void
  onEdgeClick: (edge: GraphEdge, screenX: number, screenY: number) => void
  onDependencyEdgeClick: (edge: GraphDependencyEdge, screenX: number, screenY: number) => void
  onNodeMoved: (id: string, x: number, y: number) => void
  onHoverChange: (hover: HoverInfo | null) => void
}>(function GraphCanvas(
  {
    nodes,
    edges,
    dependencyEdges,
    positions,
    initialCamera,
    display,
    selectedTabId,
    centerTabId,
    centerDistances,
    searchMatches,
    collections,
    selectedCollectionId,
    onCameraChange,
    onSelectNode,
    onSelectCollection,
    onOpenNode,
    onContextMenu,
    onEdgeClick,
    onDependencyEdgeClick,
    onNodeMoved,
    onHoverChange,
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

  const hoveredIdRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; pointerId: number } | null>(null)
  const panRef = useRef<{ startX: number; startY: number; lastX: number; lastY: number; pointerId: number } | null>(
    null
  )
  const spaceHeldRef = useRef(false)

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
  // Populated during draw() with each currently-drawn collection's screen-space
  // rect, reused for hit-testing on click instead of recomputing it there —
  // draw() already walked every collection's visible members this frame.
  const collectionRectsRef = useRef<Map<string, CollectionBoundaryRect>>(new Map())

  nodesRef.current = nodes
  edgesRef.current = edges
  dependencyEdgesRef.current = dependencyEdges
  selectedTabIdRef.current = selectedTabId
  centerTabIdRef.current = centerTabId
  searchMatchesRef.current = searchMatches
  displayRef.current = display
  collectionsRef.current = collections
  selectedCollectionIdRef.current = selectedCollectionId

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const selectedCollectionMemberIds = useMemo(() => {
    if (!selectedCollectionId) return null
    const collection = collections.find((c) => c.id === selectedCollectionId)
    return collection ? new Set(collection.tabIds) : null
  }, [collections, selectedCollectionId])
  const selectedCollectionMemberIdsRef = useRef(selectedCollectionMemberIds)
  selectedCollectionMemberIdsRef.current = selectedCollectionMemberIds

  const degreeById = useMemo(() => buildDegreeMap(edges, dependencyEdges), [edges, dependencyEdges])

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

      let targetAlpha = 1
      if (selectedTabId && !isSelected && !isSelectionNeighbor) targetAlpha = 0.22
      if (selectedCollectionMemberIds && !isCollectionMember) targetAlpha = Math.min(targetAlpha, 0.22)
      if (hasSearch && !isMatch) targetAlpha = Math.min(targetAlpha, 0.16)
      if (!selectedTabId && !hasSearch && hoveredId && !isHovered && !isHoverNeighbor) {
        targetAlpha = Math.min(targetAlpha, 0.35)
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
    const isInteracting = Boolean(dragRef.current || panRef.current)

    if (!wasSettled || isInteracting) {
      simulation.tick()
      needsDrawRef.current = true
    }

    const stillAnimating = tickVisualStates()
    if (stillAnimating) needsDrawRef.current = true

    if (needsDrawRef.current) {
      draw()
      needsDrawRef.current = false
    }

    const stillSettling = !simulation.isSettled()
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

    // Collection boundaries first, so every edge/node paints on top of them —
    // a soft region behind the members, never an edge fanned out to each one
    // (see collection-renderer.ts's doc comment).
    collectionRectsRef.current.clear()
    for (const collection of collectionsRef.current) {
      const isSelected = collection.id === selectedCollectionId
      const points: { x: number; y: number; radius: number }[] = []
      for (const tabId of collection.tabIds) {
        const physicsNode = simulation.findNode(tabId)
        if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue
        const screen = worldToScreen(camera, { x: physicsNode.x, y: physicsNode.y }, width, height)
        points.push({ x: screen.x, y: screen.y, radius: physicsNode.radius * camera.zoom })
      }
      // A lone visible member only gets drawn while explicitly selected —
      // otherwise every single-tab collection would paint a box around it at
      // all times, which is exactly the ambient clutter the spec warns against.
      if (points.length === 0 || (points.length === 1 && !isSelected)) continue
      const rect = computeCollectionBoundary(points)
      if (!rect) continue
      collectionRectsRef.current.set(collection.id, rect)
      drawCollectionBoundary(ctx, palette, rect, {
        name: collection.name,
        isSelected,
        showLabel: showLabels,
        textSize: display.textSize,
      })
    }

    for (const edge of edgesRef.current) {
      const source = simulation.findNode(edge.source)
      const target = simulation.findNode(edge.target)
      if (!source || source.x === undefined || source.y === undefined) continue
      if (!target || target.x === undefined || target.y === undefined) continue
      const p1 = worldToScreen(camera, { x: source.x, y: source.y }, width, height)
      const p2 = worldToScreen(camera, { x: target.x, y: target.y }, width, height)
      const isHighlighted = Boolean(neighborInfo?.edgeIds.has(edge.id))
      const isDimmed = Boolean(selectedTabId) && !isHighlighted
      drawEdge(ctx, palette, {
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        reasons: edge.reasons,
        isHighlighted,
        isDimmed,
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
        showLabel: showLabels || isHovered,
        textSize: display.textSize,
        visualAlpha,
        visualScale,
      })
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

    simulation.setNodes(nodes, radiusOf, positions)
    const physicsEdges: GraphEdge[] = [
      ...edges,
      ...dependencyEdges.map((e) => ({ id: e.id, source: e.parentTabId, target: e.childTabId, reasons: [] })),
    ]
    simulation.setEdges(physicsEdges, display.edgeStrength)
    simulation.setCollections(collections)
    simulation.reheat(0.5)
    requestDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, dependencyEdges, collections, display.nodeSize, display.edgeStrength, centerDistances])

  // Selection/search/center-node/collection highlighting only affects what
  // draw() paints, not the physics simulation — once the layout has settled
  // and the render loop has stopped, changing these alone would otherwise
  // leave the canvas showing a stale frame until something else (a drag, a
  // pan) happens to wake the loop back up.
  useEffect(() => {
    requestDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTabId, centerTabId, searchMatches, selectedCollectionId])

  // Resize handling.
  useEffect(() => {
    const wrapper = wrapperRef.current
    const canvas = canvasRef.current
    if (!wrapper || !canvas) return

    function applySize() {
      const rect = wrapper!.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { width: rect.width, height: rect.height }
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
  }))

  /** Hit-tests the collection boundary rects computed by the most recent draw() call — cheap reuse instead of recomputing every member's screen position on click. */
  function hitTestCollection(screenX: number, screenY: number): string | null {
    for (const [id, rect] of collectionRectsRef.current) {
      if (pointInRect(screenX, screenY, rect)) return id
    }
    return null
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
      simulation.reheat(0.6)
      dragRef.current = { id: hit.id, startX: point.x, startY: point.y, pointerId: e.pointerId }
      requestDraw()
    } else {
      panRef.current = { startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, pointerId: e.pointerId }
    }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const point = screenPointFromEvent(e)
    const { width, height } = sizeRef.current

    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      const world = screenToWorld(cameraRef.current, point, width, height)
      simulationRef.current!.pin(dragRef.current.id, world.x, world.y)
      simulationRef.current!.reheat(0.35)
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
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const point = screenPointFromEvent(e)

    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      const { id, startX, startY } = dragRef.current
      const moved = Math.hypot(point.x - startX, point.y - startY) > CLICK_DRAG_THRESHOLD
      const physicsNode = simulationRef.current!.findNode(id)
      simulationRef.current!.unpin(id)
      dragRef.current = null
      canvasRef.current?.releasePointerCapture(e.pointerId)
      requestDraw()

      if (moved && physicsNode?.x !== undefined && physicsNode?.y !== undefined) {
        onNodeMoved(id, physicsNode.x, physicsNode.y)
      } else {
        const node = nodeById.get(id)
        if (node) {
          // Clicking a node always wins over any collection selection —
          // node and collection selection are mutually exclusive states.
          onSelectCollection(null)
          onSelectNode(node.id === selectedTabId ? null : node.id)
        }
      }
      return
    }

    if (panRef.current && panRef.current.pointerId === e.pointerId) {
      const { startX, startY } = panRef.current
      const moved = Math.hypot(point.x - startX, point.y - startY) > CLICK_DRAG_THRESHOLD
      panRef.current = null
      canvasRef.current?.releasePointerCapture(e.pointerId)
      onCameraChange(cameraRef.current)
      if (!moved) {
        const dependencyHit = hitTestDependencyEdge(point.x, point.y)
        if (dependencyHit) {
          onDependencyEdgeClick(dependencyHit, e.clientX, e.clientY)
          return
        }
        const edgeHit = hitTestEdge(point.x, point.y)
        if (edgeHit) {
          onEdgeClick(edgeHit, e.clientX, e.clientY)
          return
        }
        const collectionHit = hitTestCollection(point.x, point.y)
        if (collectionHit) {
          onSelectNode(null)
          onSelectCollection(collectionHit === selectedCollectionIdRef.current ? null : collectionHit)
        } else {
          onSelectNode(null)
          onSelectCollection(null)
        }
      }
      return
    }
  }

  function handlePointerLeave() {
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
