"use client"

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react"
import { nodeRadius } from "@/lib/knowledge-graph/layout"
import { clampZoom, fitCamera, mixCamera, screenToWorld, SpatialGrid, worldToScreen, zoomAt } from "@/lib/knowledge-graph/view"
import type { Camera, Insets } from "@/lib/knowledge-graph/view"
import type { KnowledgeEdge, KnowledgeNode, Point } from "@/lib/knowledge-graph/types"
import { drawScene, readPalette } from "./renderer"
import type { Palette } from "./renderer"

export type GraphCanvasHandle = {
  /** Frames the given nodes (all of them when omitted) in the free part of the view. */
  fit: (ids?: readonly string[], options?: { animate?: boolean; maxZoom?: number }) => void
  zoomBy: (factor: number) => void
  getCamera: () => Camera
  /** Where a node is on screen right now, relative to the canvas. */
  screenOf: (id: string) => Point | undefined
  /** Moves toward a node and calls `then` as it arrives — the way into a resource. */
  diveInto: (id: string, then: () => void) => void
}

type Props = {
  nodes: readonly KnowledgeNode[]
  edges: readonly KnowledgeEdge[]
  positions: Readonly<Record<string, Point>>
  projectItems: ReadonlyMap<string, number>
  selected?: string
  selectedProject?: string
  hovered?: string
  focused?: string
  matches: ReadonlySet<string>
  highlighted: ReadonlySet<string>
  /** Nodes shown at full strength; everything else is quieted. `null`: all full. */
  emphasised: ReadonlySet<string> | null
  initialCamera?: Camera
  insets: Insets
  reducedMotion: boolean
  onHover: (id: string | undefined, point?: Point) => void
  onSelect: (id: string | undefined) => void
  onOpen: (id: string) => void
  onCameraChange?: (camera: Camera) => void
}

const QUIET = 0.16
const CAMERA_MS = 560
const PULSE_MS = 900
const DIVE_MS = 260
const REVEAL_MS = 900

/**
 * The knowledge graph's surface: a canvas, drawn only when something
 * changed. There is no animation loop at rest — a frame is requested by a
 * prop change, a pointer move that changes what is under it, or an
 * animation in flight (the camera travelling, emphasis fading, the
 * selection's one signal), and the loop stops itself the frame those end.
 *
 * Panning, wheel/pinch zoom and clicks are handled here; what a click
 * *means* (select, open) is the parent's. Keyboard traversal lives in the
 * parent too, which owns the focusable element around this canvas.
 */
export const KnowledgeGraphCanvas = forwardRef<GraphCanvasHandle, Props>(function KnowledgeGraphCanvas(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewport = useRef({ width: 0, height: 0 })
  const dpr = useRef(1)
  const camera = useRef<Camera>(props.initialCamera ?? { x: 0, y: 0, k: 0.8 })
  const tween = useRef<{ from: Camera; to: Camera; start: number; duration: number; then?: () => void } | null>(null)
  const emphasis = useRef(new Map<string, number>())
  const pulse = useRef<{ start: number } | null>(null)
  // The opening reveal: starts on the first frame drawn, plays once.
  const reveal = useRef<{ start: number } | "done" | null>(null)
  const palette = useRef<Palette | null>(null)
  const raf = useRef(0)
  const lastFrame = useRef(0)
  const cameraSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The latest props, read by the frame and the event handlers without re-binding them.
  const latest = useRef(props)
  useEffect(() => {
    latest.current = props
  })

  const grid = useMemo(() => {
    const entries: { id: string; x: number; y: number; r: number }[] = []
    for (const node of props.nodes) {
      const p = props.positions[node.id]
      if (p) entries.push({ id: node.id, x: p.x, y: p.y, r: nodeRadius(node) })
    }
    return SpatialGrid.from(entries)
  }, [props.nodes, props.positions])
  const gridRef = useRef(grid)
  useEffect(() => {
    gridRef.current = grid
  }, [grid])

  const notifyCamera = useCallback(() => {
    if (cameraSaveTimer.current) clearTimeout(cameraSaveTimer.current)
    cameraSaveTimer.current = setTimeout(() => latest.current.onCameraChange?.(camera.current), 400)
  }, [])

  const frame = useCallback((time: number) => {
    raf.current = 0
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx || viewport.current.width === 0) return
    const p = latest.current
    const dt = lastFrame.current ? Math.min(64, time - lastFrame.current) : 16
    lastFrame.current = time
    let animating = false

    if (tween.current) {
      const t = (time - tween.current.start) / tween.current.duration
      camera.current = mixCamera(tween.current.from, tween.current.to, t)
      if (t >= 1) {
        const done = tween.current.then
        tween.current = null
        notifyCamera()
        done?.()
      } else animating = true
    }

    // Emphasis eases toward its target — quieting the unrelated, never hiding it.
    const rate = p.reducedMotion ? 1 : 1 - Math.exp(-dt / 90)
    for (const node of p.nodes) {
      const target = p.emphasised === null || p.emphasised.has(node.id) ? 1 : QUIET
      const current = emphasis.current.get(node.id) ?? target
      const next = current + (target - current) * rate
      if (Math.abs(target - next) > 0.005) animating = true
      emphasis.current.set(node.id, Math.abs(target - next) <= 0.005 ? target : next)
    }

    let revealT: number | undefined
    if (reveal.current === null) reveal.current = p.reducedMotion ? "done" : { start: time }
    if (reveal.current !== "done") {
      const t = (time - reveal.current.start) / REVEAL_MS
      if (t >= 1.45) reveal.current = "done"
      else {
        revealT = t
        animating = true
      }
    }

    let pulseT: number | undefined
    if (pulse.current) {
      const t = (time - pulse.current.start) / PULSE_MS
      if (t >= 1) pulse.current = null
      else {
        pulseT = t
        animating = true
      }
    }

    if (!palette.current) palette.current = readPalette()
    drawScene(ctx, {
      nodes: p.nodes,
      edges: p.edges,
      positions: p.positions,
      camera: camera.current,
      viewport: viewport.current,
      dpr: dpr.current,
      palette: palette.current,
      emphasis: emphasis.current,
      ...(p.selected ? { selected: p.selected } : {}),
      ...(p.selectedProject ? { selectedProject: p.selectedProject } : {}),
      ...(p.hovered ? { hovered: p.hovered } : {}),
      ...(p.focused ? { focused: p.focused } : {}),
      matches: p.matches,
      highlighted: p.highlighted,
      ...(pulseT !== undefined ? { pulse: pulseT } : {}),
      ...(revealT !== undefined ? { reveal: revealT } : {}),
      projectItems: p.projectItems,
      now: Date.now(),
    })
    if (animating) raf.current = requestAnimationFrame(frame)
    else lastFrame.current = 0
  }, [notifyCamera])

  const invalidate = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(frame)
  }, [frame])

  // Any change to what is drawn asks for one frame.
  useEffect(invalidate, [invalidate, props.nodes, props.edges, props.positions, props.selected, props.hovered, props.focused, props.matches, props.highlighted, props.emphasised])

  // A new selection sends its one signal out along its relationships.
  useEffect(() => {
    if (!props.selected || props.reducedMotion) return
    pulse.current = { start: performance.now() }
    invalidate()
  }, [props.selected, props.reducedMotion, invalidate])

  const animateTo = useCallback(
    (to: Camera, options: { duration?: number; then?: () => void } = {}) => {
      if (latest.current.reducedMotion) {
        camera.current = to
        tween.current = null
        notifyCamera()
        invalidate()
        options.then?.()
        return
      }
      tween.current = { from: camera.current, to, start: performance.now(), duration: options.duration ?? CAMERA_MS, ...(options.then ? { then: options.then } : {}) }
      invalidate()
    },
    [invalidate, notifyCamera]
  )

  useImperativeHandle(
    ref,
    () => ({
      fit(ids, options = {}) {
        const p = latest.current
        const chosen = ids ? p.nodes.filter((node) => ids.includes(node.id)) : p.nodes
        const points = chosen.flatMap((node) => {
          const at = p.positions[node.id]
          return at ? [{ ...at, r: nodeRadius(node) + (node.kind === "project" ? 40 : 18) }] : []
        })
        if (points.length === 0) return
        const target = fitCamera(points, viewport.current, { insets: p.insets, padding: 56, maxZoom: options.maxZoom ?? (ids && ids.length <= 2 ? 2.2 : 1.6) })
        if (options.animate === false) {
          camera.current = target
          notifyCamera()
          invalidate()
        } else animateTo(target)
      },
      zoomBy(factor) {
        const c = camera.current
        animateTo({ ...c, k: clampZoom(c.k * factor) }, { duration: 220 })
      },
      getCamera: () => camera.current,
      screenOf(id) {
        const at = latest.current.positions[id]
        return at ? worldToScreen(at, camera.current, viewport.current) : undefined
      },
      diveInto(id, then) {
        const at = latest.current.positions[id]
        if (!at || latest.current.reducedMotion) {
          then()
          return
        }
        animateTo({ x: at.x, y: at.y, k: clampZoom(Math.max(camera.current.k * 1.8, 2.4)) }, { duration: DIVE_MS, then })
      },
    }),
    [animateTo, invalidate, notifyCamera]
  )

  // ---- size, theme ----
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const resize = () => {
      const rect = container.getBoundingClientRect()
      dpr.current = Math.min(2, window.devicePixelRatio || 1)
      viewport.current = { width: rect.width, height: rect.height }
      canvas.width = Math.max(1, Math.round(rect.width * dpr.current))
      canvas.height = Math.max(1, Math.round(rect.height * dpr.current))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      invalidate()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    // A theme change rewrites :root's inline style: read the palette again.
    const themeObserver = new MutationObserver(() => {
      palette.current = null
      invalidate()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "class"] })
    return () => {
      observer.disconnect()
      themeObserver.disconnect()
    }
  }, [invalidate])

  // ---- pointer: pan, pinch, wheel, hover, click ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const pointers = new Map<number, Point>()
    let drag: { start: Point; camera: Camera; moved: boolean; hit?: string } | null = null
    let pinch: { distance: number; camera: Camera; mid: Point } | null = null
    let hoverId: string | undefined

    const local = (event: { clientX: number; clientY: number }): Point => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const hitAt = (point: Point) => {
      const world = screenToWorld(point, camera.current, viewport.current)
      return gridRef.current.hit(world.x, world.y, 6 / camera.current.k)
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return
      canvas.setPointerCapture(event.pointerId)
      const point = local(event)
      pointers.set(event.pointerId, point)
      tween.current = null
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [Point, Point]
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), camera: camera.current, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
        drag = null
        return
      }
      const hit = hitAt(point)
      drag = { start: point, camera: camera.current, moved: false, ...(hit ? { hit } : {}) }
    }

    const onPointerMove = (event: PointerEvent) => {
      const point = local(event)
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point)
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [Point, Point]
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        camera.current = zoomAt(pinch.camera, pinch.mid, pinch.camera.k * (distance / Math.max(1, pinch.distance)), viewport.current)
        invalidate()
        return
      }
      if (drag) {
        const dx = point.x - drag.start.x
        const dy = point.y - drag.start.y
        if (!drag.moved && Math.hypot(dx, dy) > 3) {
          drag.moved = true
          canvas.style.cursor = "grabbing"
          if (hoverId) {
            hoverId = undefined
            latest.current.onHover(undefined)
          }
        }
        if (drag.moved) {
          camera.current = { ...drag.camera, x: drag.camera.x - dx / drag.camera.k, y: drag.camera.y - dy / drag.camera.k }
          invalidate()
        }
        return
      }
      const hit = hitAt(point)
      canvas.style.cursor = hit ? "pointer" : "grab"
      if (hit !== hoverId) {
        hoverId = hit
        latest.current.onHover(hit, hit ? point : undefined)
      } else if (hit) latest.current.onHover(hit, point)
    }

    const onPointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId)
      if (pinch) {
        if (pointers.size < 2) {
          pinch = null
          notifyCamera()
        }
        return
      }
      const current = drag
      drag = null
      canvas.style.cursor = "grab"
      if (!current) return
      if (current.moved) {
        notifyCamera()
        return
      }
      latest.current.onSelect(current.hit)
    }

    const onLeave = () => {
      if (hoverId) {
        hoverId = undefined
        latest.current.onHover(undefined)
      }
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      tween.current = null
      const point = local(event)
      // A trackpad's sideways scroll pans; a wheel (or a pinch, which arrives as ctrl+wheel) zooms.
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        camera.current = { ...camera.current, x: camera.current.x + event.deltaX / camera.current.k, y: camera.current.y + event.deltaY / camera.current.k }
      } else {
        const scale = event.deltaMode === 1 ? 0.05 : 0.0018
        const factor = Math.exp(-event.deltaY * (event.ctrlKey ? scale * 4 : scale))
        camera.current = zoomAt(camera.current, point, camera.current.k * factor, viewport.current)
      }
      invalidate()
      notifyCamera()
    }

    const onDoubleClick = (event: MouseEvent) => {
      const hit = hitAt(local(event))
      if (hit) latest.current.onOpen(hit)
    }

    canvas.addEventListener("pointerdown", onPointerDown)
    canvas.addEventListener("pointermove", onPointerMove)
    canvas.addEventListener("pointerup", onPointerUp)
    canvas.addEventListener("pointercancel", onPointerUp)
    canvas.addEventListener("pointerleave", onLeave)
    canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.addEventListener("dblclick", onDoubleClick)
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown)
      canvas.removeEventListener("pointermove", onPointerMove)
      canvas.removeEventListener("pointerup", onPointerUp)
      canvas.removeEventListener("pointercancel", onPointerUp)
      canvas.removeEventListener("pointerleave", onLeave)
      canvas.removeEventListener("wheel", onWheel)
      canvas.removeEventListener("dblclick", onDoubleClick)
    }
  }, [invalidate, notifyCamera])

  // Nothing keeps running once the graph is gone.
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
      if (cameraSaveTimer.current) clearTimeout(cameraSaveTimer.current)
    },
    []
  )

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden" data-knowledge-graph-canvas>
      <canvas ref={canvasRef} aria-hidden className="block cursor-grab touch-none select-none" />
    </div>
  )
})
