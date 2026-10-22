"use client"

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react"
import { subscribeFavicons } from "@/lib/favicon/client"
import { graphEffects } from "@/lib/knowledge-graph/appearance"
import type { GraphAppearance, GraphEffects } from "@/lib/knowledge-graph/appearance"
import { worldPoint } from "@/lib/knowledge-graph/galaxy"
import { nodeRadius } from "@/lib/knowledge-graph/layout"
import { baseLens, cameraOn, fitLens, panLens, project, zoomAtLens } from "@/lib/knowledge-graph/projection"
import type { Lens } from "@/lib/knowledge-graph/projection"
import { clampZoom, mixCamera, SpatialGrid } from "@/lib/knowledge-graph/view"
import type { Camera, Insets } from "@/lib/knowledge-graph/view"
import type { KnowledgeEdge, KnowledgeNode, Point } from "@/lib/knowledge-graph/types"
import { drawScene, orbitRadii, readPalette, RenderCache } from "./renderer"
import type { Hit, Palette } from "./renderer"

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
  selected?: string
  /** The project hub lit as the galaxy's core (the chosen project, or the selection's). */
  core?: string
  /** The scope at the origin, joined to every hub. Absent when one project is chosen. */
  root?: { label: string; detail: string }
  hovered?: string
  focused?: string
  matches: ReadonlySet<string>
  highlighted: ReadonlySet<string>
  /** Nodes shown at full strength; everything else is quieted. `null`: all full. */
  emphasised: ReadonlySet<string> | null
  initialCamera?: Camera
  insets: Insets
  reducedMotion: boolean
  /** The person's colours and effects. With animation off, nothing ambient runs: the galaxy is drawn only when it changes. */
  appearance: GraphAppearance
  /** Covered (the list view) or leaving: hold the ambient motion. */
  paused?: boolean
  onHover: (id: string | undefined, point?: Point) => void
  onSelect: (id: string | undefined) => void
  onOpen: (id: string) => void
  /** A right-click (or long press) on a node, at that point on the canvas. */
  onContextMenu?: (id: string, point: Point) => void
  onCameraChange?: (camera: Camera) => void
}

const QUIET = 0.14
const CAMERA_MS = 620
const DIVE_MS = 280
const REVEAL_S = 2.1
/** Ambient motion runs at about 30fps (20 for a large library); interaction gets every frame. */
const AMBIENT_FRAME_MS = 32
const AMBIENT_FRAME_MS_LARGE = 50
const LARGE = 1200
/** How far the pointer sways the camera: radians of yaw and tilt at the canvas's edges. */
const SWAY_YAW = 0.05
const SWAY_TILT = 0.035

/**
 * The knowledge galaxy's surface: one canvas, one animation loop.
 *
 * With motion allowed, the loop runs while the galaxy is on screen and the
 * page is visible — particles drift, the core breathes, the camera sways a
 * little toward the pointer — at about 30fps, and at full rate only while
 * something is actually moving (a camera tween, a drag, emphasis easing,
 * nodes arriving or leaving). Hidden, covered, scrolled away or with motion
 * reduced, it draws only when something changes, exactly once.
 *
 * Nothing here re-renders React per frame: the loop reads the latest props
 * from a ref and keeps its own state (camera, lens sway, emphasis, presence,
 * the lit core) in refs. Panning, wheel/pinch zoom and clicks are handled
 * here against the frame just drawn; what a click *means* is the parent's.
 */
export const KnowledgeGraphCanvas = forwardRef<GraphCanvasHandle, Props>(function KnowledgeGraphCanvas(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewport = useRef({ width: 0, height: 0 })
  const dpr = useRef(1)
  const camera = useRef<Camera>(props.initialCamera ?? { x: 0, y: 0, k: 0.7 })
  const tween = useRef<{ from: Camera; to: Camera; start: number; duration: number; then?: () => void } | null>(null)
  const sway = useRef({ yaw: 0, tilt: 0, targetYaw: 0, targetTilt: 0 })
  const lens = useRef<Lens>({ tilt: 0.9, yaw: 0, focal: 1000 })
  const emphasis = useRef(new Map<string, number>())
  const presence = useRef(new Map<string, number>())
  const coreness = useRef(new Map<string, number>())
  // The opening: starts on the first frame drawn, plays once.
  const reveal = useRef<{ start: number } | "done" | null>(null)
  const clock = useRef({ time: 0, last: 0 })
  const palette = useRef<Palette | null>(null)
  const effects = useRef<{ source: GraphAppearance; value: GraphEffects } | null>(null)
  const cache = useRef<RenderCache | null>(null)
  const hits = useRef<{ list: Hit[]; grid: SpatialGrid | null }>({ list: [], grid: null })
  const raf = useRef(0)
  const lastDraw = useRef(0)
  const busyUntil = useRef(0)
  const inView = useRef(true)
  const pageVisible = useRef(true)
  const cameraSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The latest props, read by the frame and the event handlers without re-binding them.
  const latest = useRef(props)
  useEffect(() => {
    latest.current = props
  })

  // What is drawn: the current nodes plus any still fading out, at their last known places.
  const world = useRef({ nodes: [] as readonly KnowledgeNode[], edges: [] as readonly KnowledgeEdge[], positions: new Map<string, Point>(), orbits: [] as number[], source: null as null | { nodes: readonly KnowledgeNode[]; edges: readonly KnowledgeEdge[]; positions: Readonly<Record<string, Point>> } })
  const syncWorld = useCallback(() => {
    const p = latest.current
    const w = world.current
    if (w.source && w.source.nodes === p.nodes && w.source.edges === p.edges && w.source.positions === p.positions) return
    const first = w.source === null
    const ids = new Set(p.nodes.map((node) => node.id))
    const leaving = first ? [] : w.nodes.filter((node) => !ids.has(node.id) && (presence.current.get(node.id) ?? 0) > 0.02)
    const positions = new Map<string, Point>()
    for (const node of leaving) {
      const at = w.positions.get(node.id)
      if (at) positions.set(node.id, at)
    }
    for (const [id, at] of Object.entries(p.positions)) positions.set(id, at)
    const nodes = leaving.length > 0 ? [...p.nodes, ...leaving] : p.nodes
    const all = new Set(nodes.map((node) => node.id))
    const edgeIds = new Set(p.edges.map((edge) => edge.id))
    const leavingEdges = first ? [] : w.edges.filter((edge) => !edgeIds.has(edge.id) && all.has(edge.source) && all.has(edge.target) && (!ids.has(edge.source) || !ids.has(edge.target)))
    for (const node of p.nodes) if (!presence.current.has(node.id)) presence.current.set(node.id, first || p.reducedMotion ? 1 : 0)
    world.current = { nodes, edges: leavingEdges.length > 0 ? [...p.edges, ...leavingEdges] : p.edges, positions, orbits: orbitRadii(p.nodes, positions), source: { nodes: p.nodes, edges: p.edges, positions: p.positions } }
  }, [])

  const notifyCamera = useCallback(() => {
    if (cameraSaveTimer.current) clearTimeout(cameraSaveTimer.current)
    cameraSaveTimer.current = setTimeout(() => {
      cameraSaveTimer.current = null
      latest.current.onCameraChange?.(camera.current)
    }, 400)
  }, [])

  const restingLens = useCallback((): Lens => baseLens(viewport.current), [])

  const frame = useCallback(
    (now: number) => {
      raf.current = 0
      const canvas = canvasRef.current
      const ctx = canvas?.getContext("2d")
      if (!canvas || !ctx || viewport.current.width === 0) return
      const p = latest.current
      const still = p.reducedMotion || !p.appearance.animation
      const ambient = !still && !p.paused && inView.current && pageVisible.current
      const interacting = now < busyUntil.current || tween.current !== null
      // Ambient-only frames are throttled; skip this one and wait for the next.
      if (ambient && !interacting && lastDraw.current && now - lastDraw.current < (p.nodes.length > LARGE ? AMBIENT_FRAME_MS_LARGE : AMBIENT_FRAME_MS) && reveal.current === "done") {
        raf.current = requestAnimationFrame(frame)
        return
      }
      const dt = lastDraw.current ? Math.min(64, now - lastDraw.current) : 16
      lastDraw.current = now
      syncWorld()
      const w = world.current
      let animating = false

      if (tween.current) {
        const t = (now - tween.current.start) / tween.current.duration
        camera.current = mixCamera(tween.current.from, tween.current.to, t)
        if (t >= 1) {
          const done = tween.current.then
          tween.current = null
          notifyCamera()
          done?.()
        } else animating = true
      }

      // Emphasis, presence and the lit core all ease toward their targets.
      const rate = p.reducedMotion ? 1 : 1 - Math.exp(-dt / 110)
      const live = new Set(p.nodes.map((node) => node.id))
      for (const node of w.nodes) {
        const eTarget = p.emphasised === null || p.emphasised.has(node.id) ? 1 : QUIET
        const e = emphasis.current.get(node.id) ?? eTarget
        const eNext = Math.abs(eTarget - e) <= 0.004 ? eTarget : e + (eTarget - e) * rate
        if (eNext !== eTarget) animating = true
        emphasis.current.set(node.id, eNext)

        const pTarget = live.has(node.id) ? 1 : 0
        const pr = presence.current.get(node.id) ?? pTarget
        const prNext = Math.abs(pTarget - pr) <= 0.01 ? pTarget : pr + (pTarget - pr) * rate * 0.7
        if (prNext !== pTarget) animating = true
        presence.current.set(node.id, prNext)

        if (node.kind === "project") {
          const cTarget = p.core === node.id ? 1 : 0
          const c = coreness.current.get(node.id) ?? cTarget
          const cNext = Math.abs(cTarget - c) <= 0.004 ? cTarget : c + (cTarget - c) * rate * 0.6
          if (cNext !== cTarget) animating = true
          coreness.current.set(node.id, cNext)
        }
      }
      // Gone and faded: drop them.
      if (w.nodes.length !== p.nodes.length && w.nodes.some((node) => !live.has(node.id) && (presence.current.get(node.id) ?? 0) === 0)) {
        for (const node of w.nodes) if (!live.has(node.id) && (presence.current.get(node.id) ?? 0) === 0) presence.current.delete(node.id)
        world.current = { ...w, nodes: p.nodes, edges: p.edges, source: null }
        syncWorld()
      }

      // The lens: resting tilt for this viewport, plus the pointer's sway, plus the opening swing.
      const s = sway.current
      const swayRate = 1 - Math.exp(-dt / 500)
      if (ambient) {
        s.yaw += (s.targetYaw - s.yaw) * swayRate
        s.tilt += (s.targetTilt - s.tilt) * swayRate
        if (Math.abs(s.targetYaw - s.yaw) > 0.0004 || Math.abs(s.targetTilt - s.tilt) > 0.0004) animating = true
      } else {
        s.yaw = 0
        s.tilt = 0
      }
      const rest = restingLens()
      let revealT: number | undefined
      if (reveal.current === null) reveal.current = still ? "done" : { start: now }
      let swing = 0
      if (reveal.current !== "done") {
        const t = (now - reveal.current.start) / 1000
        if (t >= REVEAL_S || still) reveal.current = "done"
        else {
          revealT = (t / REVEAL_S) * 1.6
          swing = Math.pow(1 - t / REVEAL_S, 3)
          animating = true
        }
      }
      lens.current = { tilt: rest.tilt + s.tilt - swing * 0.32, yaw: s.yaw - swing * 0.35, focal: rest.focal }

      if (ambient) clock.current.time += dt / 1000

      if (!palette.current) palette.current = readPalette(undefined, p.appearance.colors)
      if (effects.current?.source !== p.appearance) effects.current = { source: p.appearance, value: graphEffects(p.appearance) }
      if (!cache.current) {
        cache.current = new RenderCache()
        cache.current.onAsset = () => invalidateRef.current()
      }
      const view = swing > 0 ? { ...camera.current, k: camera.current.k * (1 - swing * 0.14) } : camera.current
      const drawnHits = drawScene(
        ctx,
        {
          nodes: w.nodes,
          edges: w.edges,
          positions: w.positions,
          camera: view,
          lens: lens.current,
          viewport: viewport.current,
          dpr: dpr.current,
          palette: palette.current,
          emphasis: emphasis.current,
          presence: presence.current,
          coreness: coreness.current,
          ...(p.selected ? { selected: p.selected } : {}),
          ...(p.hovered ? { hovered: p.hovered } : {}),
          ...(p.focused ? { focused: p.focused } : {}),
          ...(p.root ? { root: p.root } : {}),
          matches: p.matches,
          highlighted: p.highlighted,
          time: clock.current.time,
          ambient,
          ...(revealT !== undefined ? { reveal: revealT } : {}),
          orbits: w.orbits,
          now: Date.now(),
          effects: effects.current.value,
        },
        cache.current
      )
      hits.current = { list: drawnHits, grid: null }
      if (animating || ambient) raf.current = requestAnimationFrame(frame)
      else lastDraw.current = 0
    },
    [notifyCamera, restingLens, syncWorld]
  )

  const invalidate = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(frame)
  }, [frame])
  const invalidateRef = useRef(invalidate)
  useEffect(() => {
    invalidateRef.current = invalidate
  }, [invalidate])

  /** Marks the next stretch as interactive: full frame rate until it ends. */
  const busy = useCallback(
    (ms = 300) => {
      busyUntil.current = performance.now() + ms
      invalidate()
    },
    [invalidate]
  )

  // A site's icon arriving is a change to what is drawn.
  useEffect(() => subscribeFavicons(invalidate), [invalidate])

  // Any change to what is drawn asks for a frame (and restarts the loop if motion was held).
  useEffect(invalidate, [invalidate, props.nodes, props.edges, props.positions, props.selected, props.core, props.root, props.hovered, props.focused, props.matches, props.highlighted, props.emphasised, props.paused, props.reducedMotion, props.appearance])

  // New colours: the palette is derived again on the next frame. Nothing is laid out again; the camera stays.
  useEffect(() => {
    palette.current = null
    invalidate()
  }, [invalidate, props.appearance.colors])

  // Camera bounds: the galaxy plus a margin, so the view can never drift off into empty space.
  const bounds = useMemo(() => {
    let minX = 0
    let minY = 0
    let maxX = 0
    let maxY = 0
    for (const at of Object.values(props.positions)) {
      minX = Math.min(minX, at.x)
      minY = Math.min(minY, at.y)
      maxX = Math.max(maxX, at.x)
      maxY = Math.max(maxY, at.y)
    }
    return { minX: minX - 320, minY: minY - 320, maxX: maxX + 320, maxY: maxY + 320 }
  }, [props.positions])
  const boundsRef = useRef(bounds)
  useEffect(() => {
    boundsRef.current = bounds
  }, [bounds])
  const bounded = useCallback((c: Camera): Camera => {
    const b = boundsRef.current
    return { k: clampZoom(c.k), x: Math.min(b.maxX, Math.max(b.minX, c.x)), y: Math.min(b.maxY, Math.max(b.minY, c.y)) }
  }, [])

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

  const pointOf = useCallback((node: KnowledgeNode) => {
    syncWorld()
    return worldPoint(node, world.current.positions)
  }, [syncWorld])

  useImperativeHandle(
    ref,
    () => ({
      fit(ids, options = {}) {
        const p = latest.current
        const chosen = ids ? p.nodes.filter((node) => ids.includes(node.id)) : p.nodes
        const points = chosen.flatMap((node) => {
          const at = pointOf(node)
          return at ? [{ ...at, r: nodeRadius(node) + (node.kind === "project" ? 40 : 16) }] : []
        })
        // The whole galaxy includes its core.
        if (!ids && p.root) points.push({ x: 0, y: 0, z: 0, r: 70 })
        if (points.length === 0) return
        const target = fitLens(points, viewport.current, restingLens(), { insets: p.insets, padding: 48, maxZoom: options.maxZoom ?? (ids ? 2.4 : 1.6) })
        if (options.animate === false) {
          camera.current = target
          notifyCamera()
          invalidate()
        } else animateTo(target)
      },
      zoomBy(factor) {
        const c = camera.current
        animateTo({ ...c, k: clampZoom(c.k * factor) }, { duration: 240 })
      },
      getCamera: () => camera.current,
      screenOf(id) {
        const node = latest.current.nodes.find((entry) => entry.id === id)
        const at = node ? pointOf(node) : undefined
        const on = at ? project(at, camera.current, viewport.current, lens.current) : undefined
        return on ? { x: on.x, y: on.y } : undefined
      },
      diveInto(id, then) {
        const node = latest.current.nodes.find((entry) => entry.id === id)
        const at = node ? pointOf(node) : undefined
        if (!at || latest.current.reducedMotion) {
          then()
          return
        }
        animateTo(cameraOn(at, Math.max(camera.current.k * 1.8, 2.4), lens.current), { duration: DIVE_MS, then })
      },
    }),
    [animateTo, invalidate, notifyCamera, pointOf, restingLens]
  )

  // ---- size, theme, visibility ----
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const resize = () => {
      const rect = container.getBoundingClientRect()
      // Capped: past 2× the extra pixels cost fill rate and buy nothing at these stroke widths.
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
      cache.current = null
      invalidate()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "class"] })
    // Off screen or in a background tab, the ambient loop stops.
    const intersection =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            inView.current = entry?.isIntersecting ?? true
            invalidate()
          })
    intersection?.observe(container)
    const onVisibility = () => {
      pageVisible.current = document.visibilityState !== "hidden"
      lastDraw.current = 0
      invalidate()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      observer.disconnect()
      themeObserver.disconnect()
      intersection?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [invalidate])

  // ---- pointer: pan, pinch, wheel, hover, click, sway ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const pointers = new Map<number, Point>()
    let drag: { start: Point; camera: Camera; lens: Lens; moved: boolean; hit?: string } | null = null
    let pinch: { distance: number; camera: Camera; mid: Point } | null = null
    let hoverId: string | undefined

    const local = (event: { clientX: number; clientY: number }): Point => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    // Hit-testing is against where things were last drawn: what you see is what you click.
    const hitAt = (point: Point) => {
      const h = hits.current
      if (!h.grid) h.grid = SpatialGrid.from(h.list, 48)
      return h.grid.hit(point.x, point.y, 7)
    }
    const endReveal = () => {
      if (reveal.current !== null && reveal.current !== "done") reveal.current = "done"
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return
      canvas.setPointerCapture(event.pointerId)
      const point = local(event)
      pointers.set(event.pointerId, point)
      tween.current = null
      endReveal()
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [Point, Point]
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), camera: camera.current, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
        drag = null
        return
      }
      const hit = hitAt(point)
      drag = { start: point, camera: camera.current, lens: lens.current, moved: false, ...(hit ? { hit } : {}) }
    }

    const onPointerMove = (event: PointerEvent) => {
      const point = local(event)
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point)
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [Point, Point]
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        camera.current = bounded(zoomAtLens(pinch.camera, pinch.mid, pinch.camera.k * (distance / Math.max(1, pinch.distance)), viewport.current, lens.current))
        busy()
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
          camera.current = bounded(panLens(drag.camera, drag.start, point, viewport.current, drag.lens))
          busy()
        }
        return
      }
      // The camera leans a little toward the pointer: depth you can feel, never enough to chase.
      if (event.pointerType === "mouse" && viewport.current.width > 0) {
        sway.current.targetYaw = (point.x / viewport.current.width - 0.5) * SWAY_YAW
        sway.current.targetTilt = (point.y / viewport.current.height - 0.5) * SWAY_TILT
        invalidate()
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
      sway.current.targetYaw = 0
      sway.current.targetTilt = 0
      invalidate()
      if (hoverId) {
        hoverId = undefined
        latest.current.onHover(undefined)
      }
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      tween.current = null
      endReveal()
      const point = local(event)
      // A trackpad's sideways scroll pans; a wheel (or a pinch, which arrives as ctrl+wheel) zooms.
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        camera.current = bounded(panLens(camera.current, point, { x: point.x - event.deltaX, y: point.y - event.deltaY }, viewport.current, lens.current))
      } else {
        const scale = event.deltaMode === 1 ? 0.05 : 0.0018
        const factor = Math.exp(-event.deltaY * (event.ctrlKey ? scale * 4 : scale))
        camera.current = bounded(zoomAtLens(camera.current, point, camera.current.k * factor, viewport.current, lens.current))
      }
      busy()
      notifyCamera()
    }

    const onDoubleClick = (event: MouseEvent) => {
      const hit = hitAt(local(event))
      if (hit) latest.current.onOpen(hit)
    }

    const onContextMenu = (event: MouseEvent) => {
      const point = local(event)
      const hit = hitAt(point)
      // Off a node, the browser's own menu: there is nothing of Hubble's there to act on.
      if (!hit || !latest.current.onContextMenu) return
      event.preventDefault()
      drag = null
      latest.current.onContextMenu(hit, point)
    }

    canvas.addEventListener("pointerdown", onPointerDown)
    canvas.addEventListener("pointermove", onPointerMove)
    canvas.addEventListener("pointerup", onPointerUp)
    canvas.addEventListener("pointercancel", onPointerUp)
    canvas.addEventListener("pointerleave", onLeave)
    canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.addEventListener("dblclick", onDoubleClick)
    canvas.addEventListener("contextmenu", onContextMenu)
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown)
      canvas.removeEventListener("pointermove", onPointerMove)
      canvas.removeEventListener("pointerup", onPointerUp)
      canvas.removeEventListener("pointercancel", onPointerUp)
      canvas.removeEventListener("pointerleave", onLeave)
      canvas.removeEventListener("wheel", onWheel)
      canvas.removeEventListener("dblclick", onDoubleClick)
      canvas.removeEventListener("contextmenu", onContextMenu)
    }
  }, [bounded, busy, invalidate, notifyCamera])

  // Nothing keeps running once the graph is gone. A camera change still waiting to be saved is saved now.
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
      if (cameraSaveTimer.current) {
        clearTimeout(cameraSaveTimer.current)
        cameraSaveTimer.current = null
        latest.current.onCameraChange?.(camera.current)
      }
    },
    []
  )

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden" data-knowledge-graph-canvas>
      <canvas ref={canvasRef} aria-hidden className="block cursor-grab touch-none select-none" />
    </div>
  )
})
