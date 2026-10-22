"use client"

import { useEffect, useMemo, useRef } from "react"
import { mix, parseColor, readPalette, RenderCache, sprite } from "@/components/knowledge-graph/renderer"
import type { RGB } from "@/components/knowledge-graph/renderer"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { hashUnit } from "@/lib/knowledge-graph/galaxy"
import { project } from "@/lib/knowledge-graph/projection"
import type { Lens } from "@/lib/knowledge-graph/projection"
import { itemKind } from "@/lib/memory/kinds"
import type { KnowledgeItem } from "@/lib/memory/items"
import type { ItemKind } from "@/lib/memory/kinds"
import { cn } from "@/lib/utils"

/**
 * A project drawn as a small galaxy: a luminous core, two spiral arms of
 * dust and nebula, and the project's own items as stars on its orbits —
 * conversations and notes close in, sources and files further out — joined
 * where they sit side by side, the newest the brightest. The same kinds and
 * colours the Graph uses, painted with the Graph's own glows and camera, so
 * Home holds a living miniature of it. Real data only: the arms are the
 * project's (seeded by its id), and an empty project is an empty orbit.
 *
 * Motion is slow and stops when the card is off screen, the tab is hidden,
 * or motion is reduced — then it is drawn once, still.
 */

/** The galaxy's radius, in world units; everything sits inside it. */
const R = 100
const INNER = 40
const OUTER = 68
const EDGE = 92
const ORBIT: Record<ItemKind, number> = { conversation: INNER, note: INNER, source: OUTER, file: OUTER }
/** Each orbit's lean out of the galactic plane, so the rings read as paths through space rather than a target. */
const INCLINE: Record<number, number> = { [INNER]: 0.16, [OUTER]: -0.1 }
/** Radians a second: the inner orbit turns faster, as it would. */
const ORBIT_SPEED: Record<number, number> = { [INNER]: 0.05, [OUTER]: 0.031 }
/** The whole galaxy's slow turn, radians a second. */
const SPIN = 0.014
const MAX_BODIES = 36
const DUST = 620
const FIELD = 18
const REVEAL_S = 1.4

export type Body = { id: string; kind: ItemKind; orbit: number; angle: number; r: number; fresh: number }
type Dust = { r: number; angle: number; z: number; size: number; alpha: number; arm: number; phase: number }
type Nebula = { r: number; angle: number; size: number; alpha: number; tint: "indigo" | "teal" | "violet" }
type Field = { u: number; v: number; size: number; alpha: number; phase: number }

export type GalaxyScene = {
  bodies: Body[]
  /** Pairs of bodies (indices) on the same orbit and near each other: the project's constellations. */
  links: [number, number][]
  dust: Dust[]
  nebulae: Nebula[]
  field: Field[]
}

/** Where everything sits, derived from ids alone: the same project always draws the same galaxy. */
export function galaxyScene(items: readonly KnowledgeItem[], seed: string): GalaxyScene {
  const h = (key: string) => hashUnit(`${seed}:${key}`)
  const phase = h("phase") * Math.PI * 2
  const winding = 1.35 + h("winding") * 0.6

  const shown = items.slice(0, MAX_BODIES)
  const bodies = shown.map((item, index): Body => {
    const kind = itemKind(item)
    return {
      id: item.id,
      kind,
      orbit: ORBIT[kind],
      angle: hashUnit(item.id) * Math.PI * 2,
      r: ORBIT[kind] + (hashUnit(`${item.id}:r`) - 0.5) * 6,
      fresh: 1 - index / Math.max(1, shown.length),
    }
  })

  // Neighbours on one orbit are joined, unless the gap between them is most of the way round.
  const links: [number, number][] = []
  for (const orbit of [INNER, OUTER]) {
    const ring = bodies.map((body, index) => ({ body, index })).filter(({ body }) => body.orbit === orbit)
    ring.sort((a, b) => a.body.angle - b.body.angle)
    if (ring.length < 2) continue
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!
      const b = ring[(i + 1) % ring.length]!
      if (ring.length === 2 && i === 1) break
      const gap = (b.body.angle - a.body.angle + Math.PI * 2) % (Math.PI * 2)
      if (gap < 1.2) links.push([a.index, b.index])
    }
  }

  const dust = Array.from({ length: DUST }, (_, i): Dust => {
    const u = h(`d${i}`)
    // Most dust lies along the two arms; the rest is the faint disc between them.
    const inArm = h(`m${i}`) < 0.78
    const arm = i % 2
    const r = 4 + Math.pow(u, 1.15) * (R - 6)
    const along = Math.log(r / 4) * winding
    // Off the arm's spine by a few units, more often near it than far: a lane, not a smear.
    const off = (h(`s${i}`) + h(`t${i}`) - 1) * (4 + r * 0.09)
    const angle = inArm ? phase + arm * Math.PI + along + off / r : h(`a${i}`) * Math.PI * 2
    return {
      r,
      angle,
      z: (h(`z${i}`) - 0.5) * 7 * (1 - u * 0.7),
      size: 0.32 + Math.pow(h(`w${i}`), 3) * 0.8,
      alpha: inArm ? 0.5 + h(`b${i}`) * 0.5 : 0.14 + h(`b${i}`) * 0.24,
      arm,
      phase: h(`p${i}`) * Math.PI * 2,
    }
  })

  const tints = ["indigo", "violet", "teal", "indigo", "teal"] as const
  const nebulae = tints.map((tint, i): Nebula => {
    const r = 22 + i * 13 + h(`nr${i}`) * 8
    return {
      r,
      angle: phase + (i % 2) * Math.PI + Math.log(r / 4) * winding + (h(`na${i}`) - 0.5) * 0.3,
      size: 24 + h(`ns${i}`) * 12,
      alpha: 0.16 + h(`nb${i}`) * 0.08,
      tint,
    }
  })

  const field = Array.from({ length: FIELD }, (_, i): Field => ({ u: h(`fu${i}`), v: h(`fv${i}`), size: 0.4 + h(`fs${i}`) * 0.6, alpha: 0.12 + h(`fa${i}`) * 0.28, phase: h(`fp${i}`) * Math.PI * 2 }))

  return { bodies, links, dust, nebulae, field }
}

type Colors = {
  dark: boolean
  star: RGB
  indigo: RGB
  violet: RGB
  teal: RGB
  kinds: Record<ItemKind, RGB>
  /** Each body's point of light: its kind, mostly starlight on ink, deeper on paper. */
  points: Record<ItemKind, string>
  /** Dust colour by arm and distance from the core, quantised so a frame sets few distinct styles. */
  dust: string[][]
}

const DUST_STEPS = 12

function readColors(): Colors {
  const palette = readPalette()
  const style = getComputedStyle(document.documentElement)
  const css = (name: string, fallback: RGB) => parseColor(style.getPropertyValue(name).trim()) ?? fallback
  const ink: RGB = [28, 30, 44]
  const tone = (color: RGB) => (palette.dark ? color : mix(color, ink, 0.35))
  const indigo = tone(css("--link", [138, 180, 255]))
  const violet = tone(css("--kind-note", [196, 169, 255]))
  const teal = tone(css("--kind-source", [111, 211, 193]))
  const kinds: Record<ItemKind, RGB> = {
    conversation: tone(css("--kind-conversation", [138, 180, 255])),
    source: tone(css("--kind-source", [111, 211, 193])),
    file: tone(css("--kind-file", [226, 183, 122])),
    note: tone(css("--kind-note", [196, 169, 255])),
  }
  const star = palette.dark ? palette.starlight : ink
  const points = Object.fromEntries((Object.keys(kinds) as ItemKind[]).map((kind) => [kind, rgb(palette.dark ? mix(kinds[kind], star, 0.5) : kinds[kind])])) as Record<ItemKind, string>
  // Warm white at the core, opening into each arm's hue toward the rim.
  const dust = [mix(indigo, violet, 0.35), mix(indigo, teal, 0.55)].map((rim) => Array.from({ length: DUST_STEPS }, (_, step) => rgb(mix(star, rim, Math.min(1, (step / (DUST_STEPS - 1)) * 1.5)))))
  return { dark: palette.dark, star, indigo, violet, teal, kinds, points, dust }
}

function rgb([r, g, b]: RGB): string {
  return `rgb(${r}, ${g}, ${b})`
}

type Frame = { width: number; height: number; dpr: number; time: number; reveal: number; sway: { x: number; y: number } }

/** Tipped further when the space is wide, so the disc fills a band as well as a square. */
function tiltFor(width: number, height: number): number {
  return width / Math.max(1, height) > 1.6 ? 1.1 : 0.9
}

function paint(ctx: CanvasRenderingContext2D, scene: GalaxyScene, frame: Frame, colors: Colors, cache: RenderCache) {
  const { width, height, dpr, time, sway } = frame
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalCompositeOperation = "source-over"
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, width, height)
  if (width < 8 || height < 8) return

  const tilt = tiltFor(width, height) + sway.y * 0.08
  const lens: Lens = { tilt, yaw: time * SPIN + sway.x * 0.16, focal: Math.max(width, height) * 2.4 }
  // The rim's faint dust may run under the card's fade; the orbits stay inside.
  const k = Math.min(width / (2 * R * 0.98), height / (2 * R * Math.cos(tilt) + 30))
  const camera = { x: 0, y: 0, k }
  const viewport = { width, height }
  const at = (x: number, y: number, z: number) => project({ x, y, z }, camera, viewport, lens)
  /** Screen size of a pixel-sized mark: a touch larger in a larger galaxy. */
  const px = Math.min(1.3, Math.max(0.75, Math.min(width, height) / 220))
  const grow = 1 - Math.pow(1 - frame.reveal, 3)
  const squash = Math.cos(tilt)
  const light = colors.dark ? 1 : 0.7
  ctx.globalCompositeOperation = colors.dark ? "lighter" : "source-over"

  // Field stars: the space the galaxy sits in.
  ctx.fillStyle = rgb(colors.star)
  for (const star of scene.field) {
    ctx.globalAlpha = star.alpha * grow * light * (0.7 + 0.3 * Math.sin(time * 0.9 + star.phase))
    ctx.beginPath()
    ctx.arc(star.u * width, star.v * height, star.size * px, 0, Math.PI * 2)
    ctx.fill()
  }

  // Nebulae along the arms, and the halo of the core.
  const haze = (x: number, y: number, z: number, size: number, color: RGB, alpha: number) => {
    const p = at(x, y, z)
    if (!p) return
    const s = size * p.scale
    ctx.globalAlpha = alpha
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.scale(1, squash)
    ctx.drawImage(sprite(cache, color, "haze"), -s, -s, s * 2, s * 2)
    ctx.restore()
  }
  for (const nebula of scene.nebulae) {
    const color = nebula.tint === "teal" ? colors.teal : nebula.tint === "violet" ? colors.violet : colors.indigo
    haze(Math.cos(nebula.angle) * nebula.r * grow, Math.sin(nebula.angle) * nebula.r * grow, 0, nebula.size, color, nebula.alpha * grow * light)
  }
  const breathe = 1 + 0.05 * Math.sin(time * 0.8)
  haze(0, 0, 0, 46 * breathe, colors.indigo, 0.42 * grow * light)

  // Orbital paths: fine, brighter on the near side.
  const ring = (radius: number, incline: number, alpha: number, dash: boolean) => {
    const steps = 120
    ctx.lineWidth = 0.75
    ctx.strokeStyle = rgb(colors.star)
    ctx.setLineDash(dash ? [1.2, 3.6] : [])
    for (const near of [false, true]) {
      ctx.globalAlpha = alpha * grow * light * (near ? 1 : 0.45)
      ctx.beginPath()
      let drawing = false
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2
        const p = at(Math.cos(a) * radius, Math.sin(a) * radius * Math.cos(incline), Math.sin(a) * radius * Math.sin(incline))
        if (!p || p.s >= 1 !== near) {
          drawing = false
          continue
        }
        if (drawing) ctx.lineTo(p.x, p.y)
        else ctx.moveTo(p.x, p.y)
        drawing = true
      }
      ctx.stroke()
    }
    ctx.setLineDash([])
  }
  ring(INNER * grow, INCLINE[INNER]!, 0.2, false)
  ring(OUTER * grow, INCLINE[OUTER]!, 0.15, false)
  ring(EDGE * grow, 0, 0.12, true)

  // Dust: the arms themselves.
  for (const mote of scene.dust) {
    const r = mote.r * grow
    const p = at(Math.cos(mote.angle) * r, Math.sin(mote.angle) * r, mote.z)
    if (!p) continue
    const t = mote.r / R
    const twinkle = 0.78 + 0.22 * Math.sin(time * 1.3 + mote.phase)
    ctx.globalAlpha = Math.min(1, mote.alpha * (1 - t * 0.5) * twinkle * grow * light * p.s)
    ctx.fillStyle = colors.dust[mote.arm]![Math.min(DUST_STEPS - 1, Math.floor(t * DUST_STEPS))]!
    const size = mote.size * px * p.s
    if (size < 0.8) ctx.fillRect(p.x - size, p.y - size, size * 2, size * 2)
    else {
      ctx.beginPath()
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // The project's items: where they are now on their orbits.
  const placed = scene.bodies.map((body) => {
    const angle = body.angle + time * ORBIT_SPEED[body.orbit]!
    const incline = INCLINE[body.orbit]!
    const r = body.r * grow
    return at(Math.cos(angle) * r, Math.sin(angle) * r * Math.cos(incline), Math.sin(angle) * r * Math.sin(incline))
  })
  const core = at(0, 0, 0)!

  // Filaments: a faint thread from the core to each, and the constellations along each orbit.
  ctx.lineWidth = 0.6
  scene.bodies.forEach((body, i) => {
    const p = placed[i]
    if (!p) return
    ctx.globalAlpha = (0.05 + 0.08 * body.fresh) * grow * light
    ctx.strokeStyle = rgb(colors.kinds[body.kind])
    ctx.beginPath()
    ctx.moveTo(core.x, core.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
  })
  // Neighbours share their stretch of orbit: it lights between them, following the path.
  ctx.lineWidth = 0.9
  for (const [a, b] of scene.links) {
    const from = scene.bodies[a]!
    const to = scene.bodies[b]!
    const start = from.angle + time * ORBIT_SPEED[from.orbit]!
    const gap = (to.angle - from.angle + Math.PI * 2) % (Math.PI * 2)
    const incline = INCLINE[from.orbit]!
    const steps = Math.max(4, Math.ceil(gap * 24))
    ctx.globalAlpha = 0.36 * grow * light
    ctx.strokeStyle = rgb(mix(colors.kinds[from.kind], colors.star, 0.35))
    ctx.beginPath()
    let drawing = false
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const angle = start + gap * t
      const r = (from.r + (to.r - from.r) * t) * grow
      const p = at(Math.cos(angle) * r, Math.sin(angle) * r * Math.cos(incline), Math.sin(angle) * r * Math.sin(incline))
      if (!p) {
        drawing = false
        continue
      }
      if (drawing) ctx.lineTo(p.x, p.y)
      else ctx.moveTo(p.x, p.y)
      drawing = true
    }
    ctx.stroke()
  }

  // Light travelling outward from the core to the newest few.
  scene.bodies.slice(0, 10).forEach((body, i) => {
    const p = placed[i]
    if (!p) return
    const u = (time * 0.14 + hashUnit(`${body.id}:flow`)) % 1
    const x = core.x + (p.x - core.x) * u
    const y = core.y + (p.y - core.y) * u
    const s = 3.2 * px
    ctx.globalAlpha = Math.sin(Math.PI * u) * 0.7 * grow * light
    ctx.drawImage(sprite(cache, colors.kinds[body.kind], "spark"), x - s, y - s, s * 2, s * 2)
  })

  // The stars themselves, far to near.
  const order = scene.bodies.map((_, i) => i).filter((i) => placed[i]).sort((a, b) => placed[a]!.s - placed[b]!.s)
  for (const i of order) {
    const body = scene.bodies[i]!
    const p = placed[i]!
    const depth = Math.min(1.15, Math.max(0.75, p.s))
    const glow = (7 + 5 * body.fresh) * px * depth
    ctx.globalAlpha = (0.35 + 0.45 * body.fresh) * grow * light
    ctx.drawImage(sprite(cache, colors.kinds[body.kind], "soft"), p.x - glow, p.y - glow, glow * 2, glow * 2)
    ctx.globalAlpha = (0.55 + 0.45 * body.fresh) * grow
    ctx.fillStyle = colors.points[body.kind]
    ctx.beginPath()
    ctx.arc(p.x, p.y, (body.kind === "conversation" ? 1.9 : 1.5) * px * depth, 0, Math.PI * 2)
    ctx.fill()
    // The newest — the one "Last touched" names — sends out a slow ripple.
    if (i === 0) {
      const t = (time / 2.8) % 1
      ctx.globalAlpha = (1 - t) * 0.5 * grow * light
      ctx.strokeStyle = colors.points[body.kind]
      ctx.lineWidth = 0.8
      ctx.beginPath()
      ctx.arc(p.x, p.y, (3 + t * 9) * px, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // The nucleus.
  const bloom = 16 * k * breathe
  ctx.globalAlpha = 0.9 * grow * light
  ctx.drawImage(sprite(cache, colors.dark ? colors.star : colors.indigo, "soft"), core.x - bloom, core.y - bloom * squash * 1.4, bloom * 2, bloom * 2 * squash * 1.4)
  ctx.globalAlpha = grow
  ctx.fillStyle = colors.dark ? "rgb(255, 255, 255)" : rgb(colors.indigo)
  ctx.beginPath()
  ctx.arc(core.x, core.y, 1.8 * px, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
}

export function ProjectGalaxy({ items, seed, className }: { items: readonly KnowledgeItem[]; seed: string; className?: string }) {
  const reducedMotion = useReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scene = useMemo(() => galaxyScene(items, seed), [items, seed])
  const sceneRef = useRef(scene)
  const invalidateRef = useRef<() => void>(() => {})

  useEffect(() => {
    sceneRef.current = scene
    invalidateRef.current()
  }, [scene])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!container || !canvas || !ctx) return
    const cache = new RenderCache()
    let colors = readColors()
    let width = 0
    let height = 0
    let dpr = 1
    let raf = 0
    let last = 0
    let clock = 0
    let inView = true
    let pageVisible = document.visibilityState !== "hidden"
    const sway = { x: 0, y: 0 }
    const target = { x: 0, y: 0 }

    const frame = (now: number) => {
      raf = 0
      const running = !reducedMotion && inView && pageVisible
      // About 30 frames a second: the motion is slow, and Home should cost little.
      if (running && last && now - last < 32) {
        raf = requestAnimationFrame(frame)
        return
      }
      if (running) clock += last ? Math.min(0.1, (now - last) / 1000) : 0
      last = running ? now : 0
      sway.x += (target.x - sway.x) * 0.08
      sway.y += (target.y - sway.y) * 0.08
      paint(ctx, sceneRef.current, { width, height, dpr, time: clock, reveal: reducedMotion ? 1 : Math.min(1, clock / REVEAL_S), sway: reducedMotion ? { x: 0, y: 0 } : sway }, colors, cache)
      if (running) raf = requestAnimationFrame(frame)
    }
    const invalidate = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }
    invalidateRef.current = invalidate

    const resize = () => {
      const rect = container.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      invalidate()
    }
    resize()
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    // A theme change rewrites :root's inline style: read the colours again.
    const themeObserver = new MutationObserver(() => {
      colors = readColors()
      cache.sprites.clear()
      invalidate()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "class"] })
    const intersection =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            inView = entry?.isIntersecting ?? true
            invalidate()
          })
    intersection?.observe(container)
    const onVisibility = () => {
      pageVisible = document.visibilityState !== "hidden"
      invalidate()
    }
    document.addEventListener("visibilitychange", onVisibility)
    // The galaxy leans a little toward the pointer.
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      const rect = container.getBoundingClientRect()
      target.x = ((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2
      target.y = ((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2
    }
    const onPointerLeave = () => {
      target.x = 0
      target.y = 0
    }
    container.addEventListener("pointermove", onPointerMove)
    container.addEventListener("pointerleave", onPointerLeave)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      invalidateRef.current = () => {}
      resizeObserver.disconnect()
      themeObserver.disconnect()
      intersection?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      container.removeEventListener("pointermove", onPointerMove)
      container.removeEventListener("pointerleave", onPointerLeave)
    }
  }, [reducedMotion])

  return (
    <div ref={containerRef} aria-hidden className={cn("overflow-hidden", className)} data-galaxy={scene.bodies.length}>
      <canvas ref={canvasRef} className="block" />
    </div>
  )
}
