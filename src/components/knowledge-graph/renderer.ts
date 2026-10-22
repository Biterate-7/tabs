import { providerLogo } from "@/components/memory/provider-mark"
import { peekFaviconImage, requestFavicon } from "@/lib/favicon/client"
import { HUB_INNER, bridgeControls, cubicAt, hashUnit, outwardAngle, reachOf as fanReach, spokeControls, stemControls, worldPoint } from "@/lib/knowledge-graph/galaxy"
import type { FanKind, Point3 } from "@/lib/knowledge-graph/galaxy"
import { nodeRadius } from "@/lib/knowledge-graph/layout"
import { project } from "@/lib/knowledge-graph/projection"
import type { Lens } from "@/lib/knowledge-graph/projection"
import type { Camera, Viewport } from "@/lib/knowledge-graph/view"
import { PERSONAL_EDGE_KINDS } from "@/lib/knowledge-graph/types"
import type { KnowledgeEdge, KnowledgeNode, Point } from "@/lib/knowledge-graph/types"

/**
 * The knowledge galaxy's painter. Pure in what it decides: given the scene,
 * it draws one frame and reports where every node landed on screen (for
 * hit-testing). All state — camera, lens, emphasis, presence, the clock of
 * the ambient motion — belongs to the canvas component.
 *
 * ## What is drawn, back to front
 *
 *   space      a few distant stars on three parallax layers, faint haze
 *              around each system, the galaxy's orbits through each project
 *   systems    each project's inclined orbital rings; the lit core's dial
 *   filaments  every relationship as fine curved strands: a project's own
 *              items fan out from it in bundled stems (the arms), and links
 *              between items arch out of the plane as bridges
 *   light      particles drifting along filaments and orbits, brighter and
 *              quicker along the selection's own relationships
 *   nodes      far to near — anchors, the core's nucleus, items as small
 *              points of light shaped by kind; up close a conversation
 *              shows its AI app's logo and a source its site's icon
 *   labels     greedy and collision-free, by priority, readable up close
 *
 * Every point is projected through a real perspective camera (projection.ts)
 * from a 3D position (galaxy.ts), so depth — size, brightness, parallax — is
 * the geometry's, not a decoration's. Strokes are batched into one path per
 * colour and brightness, so thousands of filaments cost a handful of
 * stroke() calls; glows are pre-rendered sprites, never shadowBlur.
 */

export type RGB = readonly [number, number, number]

export type Palette = {
  /** The ground everything is drawn on: the theme's own, taken a step deeper on ink themes. */
  background: string
  foreground: string
  muted: string
  tertiary: string
  focus: string
  kinds: Record<FanKind, RGB>
  filament: RGB
  rose: RGB
  blush: RGB
  ember: RGB
  starlight: RGB
  /** The warm gold of a project hub. */
  hub: RGB
  displayFont: string
  uiFont: string
  monoFont: string
  dark: boolean
}

export type Scene = {
  nodes: readonly KnowledgeNode[]
  edges: readonly KnowledgeEdge[]
  positions: ReadonlyMap<string, Point>
  camera: Camera
  lens: Lens
  viewport: Viewport
  dpr: number
  palette: Palette
  /** 0 (quiet) … 1 (full) per node: what the selection, hover or search brings forward. */
  emphasis: ReadonlyMap<string, number>
  /** 0 … 1 per node: arriving and departing nodes fade rather than pop. */
  presence: ReadonlyMap<string, number>
  /** 0 … 1 per project node: how lit it is as the galaxy's core. */
  coreness: ReadonlyMap<string, number>
  selected?: string
  hovered?: string
  focused?: string
  matches: ReadonlySet<string>
  /** Edges touching the selection — drawn brightest, with light travelling along them. */
  highlighted: ReadonlySet<string>
  /** Seconds on the ambient clock; frozen when motion is reduced. */
  time: number
  /** Whether particles drift. Off: the selection's light still shows, held still. */
  ambient: boolean
  /** The opening, 0 → 1.6; undefined once it has played. */
  reveal?: number
  /** Radii of the galaxy's orbits (one through each hub, one beyond them all), around the origin. */
  orbits: readonly number[]
  /**
   * The core at the origin: the scope being looked at — all of the person's
   * projects — joined to each project's hub by a spoke. Absent when one
   * project is chosen; that project's hub is lit as the core instead.
   */
  root?: { label: string; detail: string }
  now: number
}

export type Hit = { id: string; x: number; y: number; r: number }

/** What the painter keeps between frames: sprites, stars, logos, measured text. */
export class RenderCache {
  sprites = new Map<string, HTMLCanvasElement>()
  stars: Star[] = []
  starsKey = ""
  logos = new Map<string, HTMLImageElement | HTMLCanvasElement | "loading" | "failed">()
  widths = new Map<string, number>()
  reach = new WeakMap<readonly KnowledgeNode[], Map<string, number>>()
  /** Called when something loaded late (a logo) and the frame should be drawn again. */
  onAsset?: () => void
}

type Star = { u: number; v: number; size: number; alpha: number; layer: number; warm: boolean }

type PNode = {
  node: KnowledgeNode
  w: Point3
  x: number
  y: number
  scale: number
  /** Drawn radius, screen px. */
  r: number
  /** Emphasis × presence × reveal: how strongly it is drawn. */
  e: number
  /** Presence × reveal alone: whether it is there at all (hit-testing, filaments). */
  there: number
  emphasis: number
  /** Depth cue: nearer is brighter. */
  tone: number
  core: number
}

type Curve = { x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }

const RECENT_MS = 36 * 3600_000
const LABEL_MAX_CHARS = 32
const ALPHA_LEVELS = 40
const LARGE = 1200

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, cache: RenderCache): Hit[] {
  const { viewport, palette, dpr } = scene
  const { width, height } = viewport
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, width, height)

  const reach = reachOf(scene.nodes, cache)
  const projected = projectNodes(scene, reach)

  const light: GlobalCompositeOperation = palette.dark ? "lighter" : "source-over"
  ctx.globalCompositeOperation = light
  drawStars(ctx, scene, cache)
  drawHaze(ctx, scene, projected, reach, cache)
  drawOrbits(ctx, scene)
  drawSystems(ctx, scene, projected, cache)
  const curves = drawFilaments(ctx, scene, projected, reach)
  drawParticles(ctx, scene, curves, cache)
  ctx.globalCompositeOperation = "source-over"
  const hits = drawNodes(ctx, scene, projected, cache)
  drawVignette(ctx, scene)
  drawLabels(ctx, scene, projected, cache)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
  return hits
}

// ---------------------------------------------------------------- projection

function reachOf(nodes: readonly KnowledgeNode[], cache: RenderCache): Map<string, number> {
  let map = cache.reach.get(nodes)
  if (map) return map
  const counts = new Map<string, Map<FanKind, number>>()
  for (const node of nodes) {
    if (node.kind === "project" || !node.projectId) continue
    const id = `p:${node.projectId}`
    const kinds = counts.get(id) ?? new Map<FanKind, number>()
    kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1)
    counts.set(id, kinds)
  }
  map = new Map()
  for (const node of nodes) if (node.kind === "project") map.set(node.id, fanReach(counts.get(node.id) ?? new Map()))
  cache.reach.set(nodes, map)
  return map
}

function projectNodes(scene: Scene, reach: ReadonlyMap<string, number>): Map<string, PNode> {
  const { camera, viewport, lens } = scene
  const out = new Map<string, PNode>()
  const anchors = new Map<string, Point>()
  let furthest = 1
  for (const node of scene.nodes) {
    if (node.kind !== "project") continue
    const at = scene.positions.get(node.id)
    if (at) {
      anchors.set(node.id, at)
      furthest = Math.max(furthest, Math.hypot(at.x, at.y))
    }
  }
  for (const node of scene.nodes) {
    const w = worldPoint(node, scene.positions)
    if (!w) continue
    const at = project(w, camera, viewport, lens)
    if (!at) continue
    const worldR = nodeRadius(node)
    const r = node.kind === "project" ? clamp(worldR * at.scale, 3.2, 17) : clamp(worldR * at.scale, 0.9, 6.5)
    const emphasis = scene.emphasis.get(node.id) ?? 1
    let there = scene.presence.get(node.id) ?? 1
    if (scene.reveal !== undefined) there *= revealOf(node, w, anchors, reach, furthest, scene.reveal)
    out.set(node.id, { node, w, x: at.x, y: at.y, scale: at.scale, r, e: emphasis * there, there, emphasis, tone: clamp(0.38 + ((at.s - 0.62) / 0.6) * 0.62, 0.32, 1.08), core: node.kind === "project" ? (scene.coreness.get(node.id) ?? 0) : 0 })
  }
  return out
}

/**
 * The opening: the core's arms grow first, then each system in turn from
 * the centre outward, every filament drawn from its anchor out to its item
 * and the item lighting as the filament reaches it.
 */
function stageOf(anchor: Point | undefined, furthest: number, reveal: number): number {
  const delay = anchor ? Math.min(0.55, (Math.hypot(anchor.x, anchor.y) / furthest) * 0.55) : 0.6
  return clamp((reveal - delay) / 0.55, 0, 1)
}

function revealOf(node: KnowledgeNode, w: Point3, anchors: ReadonlyMap<string, Point>, reach: ReadonlyMap<string, number>, furthest: number, reveal: number): number {
  if (node.kind === "project") return clamp(stageOf(anchors.get(node.id), furthest, reveal) * 3, 0, 1)
  const anchorId = node.projectId ? `p:${node.projectId}` : undefined
  const anchor = anchorId ? anchors.get(anchorId) : undefined
  if (!anchor) return clamp((reveal - 0.9) / 0.4, 0, 1)
  const grow = growthOf(stageOf(anchor, furthest, reveal), Math.hypot(w.x - anchor.x, w.y - anchor.y) / (reach.get(anchorId!) ?? 100))
  return clamp((grow - 0.82) / 0.18, 0, 1)
}

function growthOf(stage: number, along: number): number {
  return clamp(stage * 1.7 - 0.7 * Math.min(1, along), 0, 1)
}

// ---------------------------------------------------------------- space

function drawStars(ctx: CanvasRenderingContext2D, scene: Scene, cache: RenderCache) {
  const { viewport, camera, lens, palette } = scene
  const { width, height } = viewport
  const key = `${Math.round(width / 80)}x${Math.round(height / 80)}`
  if (cache.starsKey !== key) {
    cache.starsKey = key
    const count = Math.round(clamp((width * height) / 6500, 60, 360))
    cache.stars = Array.from({ length: count }, (_, i) => {
      const layer = i % 3
      return {
        u: hashUnit(`star-u${i}`),
        v: hashUnit(`star-v${i}`),
        size: [0.55, 0.75, 1.05][layer]! * (0.8 + hashUnit(`star-s${i}`) * 0.5),
        alpha: [0.2, 0.3, 0.45][layer]! * (0.45 + hashUnit(`star-a${i}`) * 0.55),
        layer,
        warm: hashUnit(`star-w${i}`) < 0.16,
      }
    })
  }
  const factors = [0.012, 0.03, 0.06]
  const ink = palette.dark ? 1 : 0.55
  for (const star of cache.stars) {
    const f = factors[star.layer]!
    // Far layers barely move: the camera's travel and the lens's sway, scaled by depth.
    const sx = star.u * width - camera.x * camera.k * f + lens.yaw * width * f * 7
    const sy = star.v * height - camera.y * camera.k * f * Math.cos(lens.tilt) + (lens.tilt - 0.9) * height * f * 5
    const x = ((sx % width) + width) % width
    const y = ((sy % height) + height) % height
    ctx.globalAlpha = star.alpha * ink
    ctx.fillStyle = rgb(star.warm ? palette.blush : palette.starlight)
    ctx.fillRect(x, y, star.size, star.size)
  }
  ctx.globalAlpha = 1
}

/** A very faint haze around each system, warmer and brighter around the lit core. */
function drawHaze(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>, reach: ReadonlyMap<string, number>, cache: RenderCache) {
  const { palette, viewport } = scene
  const strength = palette.dark ? 1 : 0.45
  const centre = project({ x: 0, y: 0, z: 0 }, scene.camera, viewport, scene.lens)
  const outer = scene.orbits.length > 0 ? scene.orbits[scene.orbits.length - 1]! : 0
  if (centre && outer > 0) {
    const radius = outer * centre.scale * 0.95
    ctx.globalAlpha = 0.07 * strength
    ctx.drawImage(sprite(cache, palette.ember, "haze"), centre.x - radius, centre.y - radius, radius * 2, radius * 2)
    if (scene.root) {
      const close = Math.max(60, 150 * centre.scale)
      ctx.globalAlpha = 0.12 * strength
      ctx.drawImage(sprite(cache, palette.filament, "haze"), centre.x - close, centre.y - close, close * 2, close * 2)
    }
  }
  for (const entry of projected.values()) {
    if (entry.node.kind !== "project" || entry.e <= 0.01) continue
    const radius = (reach.get(entry.node.id) ?? 80) * entry.scale * 1.2
    if (!onScreen(entry.x, entry.y, radius, viewport)) continue
    const lit = entry.core
    ctx.globalAlpha = (0.025 + 0.1 * lit) * strength * (0.4 + 0.6 * entry.e)
    ctx.drawImage(sprite(cache, lit > 0.5 ? palette.filament : palette.ember, "haze"), entry.x - radius, entry.y - radius, radius * 2, radius * 2)
  }
  ctx.globalAlpha = 1
}

/** The galaxy's orbits: one ellipse on the plane through each project, a bead drifting on each. */
function drawOrbits(ctx: CanvasRenderingContext2D, scene: Scene) {
  const { palette, camera, viewport, lens } = scene
  if (scene.orbits.length === 0) return
  const show = scene.reveal === undefined ? 1 : clamp(scene.reveal / 0.7, 0, 1)
  ctx.lineWidth = 0.7
  ctx.strokeStyle = rgb(palette.starlight)
  for (let i = 0; i < scene.orbits.length; i++) {
    const radius = scene.orbits[i]! * (0.86 + 0.14 * easeOut(show))
    const segments = 160
    ctx.beginPath()
    let started = false
    for (let s = 0; s <= segments; s++) {
      const angle = (s / segments) * Math.PI * 2
      const at = project({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0 }, camera, viewport, lens)
      if (!at) {
        started = false
        continue
      }
      if (started) ctx.lineTo(at.x, at.y)
      else ctx.moveTo(at.x, at.y)
      started = true
    }
    ctx.globalAlpha = (palette.dark ? 0.055 : 0.09) * show * (i === 0 ? 1.3 : 1)
    ctx.stroke()
    if (scene.ambient || scene.reveal !== undefined) {
      const angle = hashUnit(`orbit${i}`) * Math.PI * 2 + scene.time * (0.012 / (1 + i * 0.4))
      const bead = project({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0 }, camera, viewport, lens)
      if (bead) {
        ctx.globalAlpha = (palette.dark ? 0.55 : 0.4) * show
        ctx.fillStyle = rgb(palette.blush)
        ctx.beginPath()
        ctx.arc(bead.x, bead.y, 1.1, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  // One great circle standing on the plane: the dome's meridian, which is what makes the whole read as a sphere.
  const outer = scene.orbits[scene.orbits.length - 1]! * 0.94
  const meridian = 0.55
  ctx.beginPath()
  let started = false
  for (let s = 0; s <= 180; s++) {
    const angle = (s / 180) * Math.PI * 2
    const along = Math.cos(angle) * outer
    const at = project({ x: along * Math.cos(meridian), y: along * Math.sin(meridian), z: Math.sin(angle) * outer * 0.85 }, camera, viewport, lens)
    if (!at) {
      started = false
      continue
    }
    if (started) ctx.lineTo(at.x, at.y)
    else ctx.moveTo(at.x, at.y)
    started = true
  }
  ctx.strokeStyle = rgb(palette.starlight)
  ctx.globalAlpha = (palette.dark ? 0.04 : 0.07) * show
  ctx.stroke()
  ctx.globalAlpha = 1
}

/**
 * The core and the lit hub.
 *
 * The core — the scope being looked at — is a small translucent cube of
 * light turning very slowly at the origin, inside nested orbital rings with
 * beads on them. A hub lit as the core (a chosen project) gets the same
 * instrument at its own scale: nested rings, beads and a dial of ticks.
 */
function drawSystems(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>, cache: RenderCache) {
  const { palette, camera, viewport, lens } = scene
  const base = palette.dark ? 1 : 1.5
  const ringAt = (centre: Point3, radius: number, from: number, to: number, scale: number) => {
    const steps = Math.max(16, Math.min(120, Math.round((radius * scale * Math.abs(to - from)) / 5)))
    let started = false
    for (let s = 0; s <= steps; s++) {
      const angle = from + ((to - from) * s) / steps
      const at = project({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius, z: centre.z }, camera, viewport, lens)
      if (!at) {
        started = false
        continue
      }
      if (started) ctx.lineTo(at.x, at.y)
      else ctx.moveTo(at.x, at.y)
      started = true
    }
  }
  const instrument = (centre: Point3, scale: number, radii: readonly number[], lit: number, alpha: number, key: string) => {
    ctx.lineWidth = 0.7
    ctx.strokeStyle = rgb(palette.rose)
    radii.forEach((radius, i) => {
      ctx.beginPath()
      ringAt(centre, radius, 0, Math.PI * 2, scale)
      ctx.globalAlpha = (0.2 - i * 0.035) * lit * alpha * base
      ctx.stroke()
    })
    // A dial of ticks just outside the outermost ring.
    const dial = radii[radii.length - 1]! * 1.12
    ctx.beginPath()
    for (let t = 0; t < 72; t++) {
      const angle = (t / 72) * Math.PI * 2
      const inner = project({ x: centre.x + Math.cos(angle) * dial, y: centre.y + Math.sin(angle) * dial, z: centre.z }, camera, viewport, lens)
      const reach = dial + (t % 6 === 0 ? dial * 0.09 : dial * 0.04)
      const outer = project({ x: centre.x + Math.cos(angle) * reach, y: centre.y + Math.sin(angle) * reach, z: centre.z }, camera, viewport, lens)
      if (!inner || !outer) continue
      ctx.moveTo(inner.x, inner.y)
      ctx.lineTo(outer.x, outer.y)
    }
    ctx.strokeStyle = rgb(palette.starlight)
    ctx.globalAlpha = 0.13 * lit * alpha * base
    ctx.stroke()
    ctx.fillStyle = rgb(palette.blush)
    radii.forEach((radius, i) => {
      const angle = hashUnit(`${key}/bead${i}`) * Math.PI * 2 + scene.time * (0.14 / (i + 1))
      const at = project({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius, z: centre.z }, camera, viewport, lens)
      if (!at) return
      ctx.globalAlpha = 0.8 * lit * alpha
      ctx.beginPath()
      ctx.arc(at.x, at.y, 1.2, 0, Math.PI * 2)
      ctx.fill()
    })
  }

  if (scene.root) {
    const show = scene.reveal === undefined ? 1 : clamp(scene.reveal / 0.4, 0, 1)
    const origin = { x: 0, y: 0, z: 0 }
    const at = project(origin, camera, viewport, lens)
    if (at && onScreen(at.x, at.y, 200, viewport)) {
      instrument(origin, at.scale, [26, 44, 66], 1, show, "root")
      drawCube(ctx, scene, cache, show)
    }
  }

  for (const entry of projected.values()) {
    const lit = entry.core
    if (entry.node.kind !== "project" || lit <= 0.02 || entry.e <= 0.01) continue
    if (!onScreen(entry.x, entry.y, HUB_INNER * entry.scale * 2, viewport)) continue
    instrument(entry.w, entry.scale, [HUB_INNER * 0.42, HUB_INNER * 0.7, HUB_INNER * 0.98], lit, entry.e * entry.tone, entry.node.id)
  }
  ctx.globalAlpha = 1
}

/**
 * The core's body: a cube of light, edges in blush over faint additive
 * faces, turning once every few minutes, with a soft bloom behind it that
 * breathes very slowly. Its size is in world units, so it grows as you
 * approach it, with a floor so it never vanishes when far.
 */
function drawCube(ctx: CanvasRenderingContext2D, scene: Scene, cache: RenderCache, show: number) {
  const { palette, camera, viewport, lens } = scene
  const centre = project({ x: 0, y: 0, z: 14 }, camera, viewport, lens)
  if (!centre) return
  const breathe = 0.85 + 0.15 * Math.sin(scene.time * ((Math.PI * 2) / 8))
  const half = clamp(15 * centre.scale, 10, 22) / centre.scale
  ctx.globalCompositeOperation = palette.dark ? "lighter" : "source-over"
  const bloom = half * centre.scale * 7
  ctx.globalAlpha = 0.32 * show * breathe * (palette.dark ? 1 : 0.4)
  ctx.drawImage(sprite(cache, palette.filament, "soft"), centre.x - bloom, centre.y - bloom, bloom * 2, bloom * 2)
  const glow = half * centre.scale * 2.6
  ctx.globalAlpha = 0.55 * show * (palette.dark ? 1 : 0.4)
  ctx.drawImage(sprite(cache, palette.blush, "soft"), centre.x - glow, centre.y - glow, glow * 2, glow * 2)

  const turn = 0.6 + scene.time * 0.035
  const tip = 0.5 + Math.sin(scene.time * 0.021) * 0.12
  const corners: { x: number; y: number }[] = []
  for (let i = 0; i < 8; i++) {
    let x = (i & 1 ? 1 : -1) * half
    let y = (i & 2 ? 1 : -1) * half
    let z = (i & 4 ? 1 : -1) * half
    // Turn about the vertical, then tip it a little about x, so it shows three faces.
    ;[x, y] = [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)]
    ;[y, z] = [y * Math.cos(tip) - z * Math.sin(tip), y * Math.sin(tip) + z * Math.cos(tip)]
    const at = project({ x, y, z: z + 14 }, camera, viewport, lens)
    if (!at) return
    corners.push(at)
  }
  const faces = [
    [0, 1, 3, 2],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 3, 7, 5],
  ]
  ctx.fillStyle = rgb(palette.filament)
  for (const face of faces) {
    ctx.beginPath()
    face.forEach((index, i) => (i === 0 ? ctx.moveTo(corners[index]!.x, corners[index]!.y) : ctx.lineTo(corners[index]!.x, corners[index]!.y)))
    ctx.closePath()
    ctx.globalAlpha = 0.07 * show * breathe
    ctx.fill()
  }
  ctx.strokeStyle = rgb(palette.dark ? palette.blush : palette.filament)
  ctx.lineWidth = 0.9
  ctx.globalAlpha = 0.75 * show
  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    for (const bit of [1, 2, 4]) {
      const j = i | bit
      if (j === i) continue
      ctx.moveTo(corners[i]!.x, corners[i]!.y)
      ctx.lineTo(corners[j]!.x, corners[j]!.y)
    }
  }
  ctx.stroke()
  ctx.globalAlpha = 0.95 * show
  ctx.fillStyle = rgb(palette.starlight)
  ctx.beginPath()
  ctx.arc(centre.x, centre.y, 1.6, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = palette.dark ? "lighter" : "source-over"
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- filaments

/** Strokes collected by colour and brightness: one stroke() per bucket, not per line. */
class Batch {
  private paths = new Map<number, Path2D>()
  constructor(
    readonly color: string,
    readonly width: number
  ) {}
  curve(alpha: number, c: Curve) {
    const level = Math.round(clamp(alpha, 0, 1) * ALPHA_LEVELS)
    if (level <= 0) return
    let path = this.paths.get(level)
    if (!path) {
      path = new Path2D()
      this.paths.set(level, path)
    }
    path.moveTo(c.x0, c.y0)
    path.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x3, c.y3)
  }
  flush(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = this.color
    ctx.lineWidth = this.width
    for (const [level, path] of this.paths) {
      ctx.globalAlpha = level / ALPHA_LEVELS
      ctx.stroke(path)
    }
    this.paths.clear()
  }
}

type Flow = { curve: Curve; id: string; target: string; lit: boolean; core: number; kind: "stem" | "bridge" | "tie" | "spoke"; e: number; tone: number }

/**
 * Every relationship as fine curved strands. A project's own items hang off
 * it as stems that leave together along their arm and part toward their
 * items; a relationship between items is a bridge arching out of the plane,
 * drawn in the hubs' gold (a tie) when the person made it themselves.
 * Each is drawn as two or three near-parallel strands that meet at both
 * ends — at a distance one line, up close a fine braid.
 */
function drawFilaments(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>, reach: ReadonlyMap<string, number>): Flow[] {
  const { palette, camera, viewport, lens } = scene
  const dark = palette.dark
  const large = scene.nodes.length > LARGE
  const width = clamp(0.55 + camera.k * 0.22, 0.55, 1.15)
  const stems = new Batch(rgb(palette.filament), width)
  const bridges = new Batch(rgb(dark ? palette.starlight : palette.ember), width * 0.9)
  const litStems = new Batch(rgb(palette.blush), width * 1.35)
  const litBridges = new Batch(rgb(dark ? palette.starlight : palette.ember), width * 1.3)
  const ties = new Batch(rgb(palette.hub), width)
  const litTies = new Batch(rgb(palette.hub), width * 1.4)
  const spokes = new Batch(rgb(dark ? palette.blush : palette.filament), width)
  const flows: Flow[] = []
  const anchors = new Map<string, Point>()
  let furthest = 1
  if (scene.reveal !== undefined) {
    for (const entry of projected.values()) {
      if (entry.node.kind !== "project") continue
      anchors.set(entry.node.id, entry.w)
      furthest = Math.max(furthest, Math.hypot(entry.w.x, entry.w.y))
    }
  }

  for (const edge of scene.edges) {
    const a = projected.get(edge.source)
    const b = projected.get(edge.target)
    if (!a || !b) continue
    // Presence alone (not the reveal, which grows the filament instead), times the quieter end's emphasis.
    const e = Math.min(scene.presence.get(a.node.id) ?? 1, scene.presence.get(b.node.id) ?? 1) * Math.min(a.emphasis, b.emphasis)
    if (e <= 0.004) continue
    const stem = (edge.kind === "contains" || edge.kind === "session-project") && a.node.kind === "project"
    const tie = PERSONAL_EDGE_KINDS.has(edge.kind)
    const lit = scene.highlighted.has(edge.id)
    let controls: [Point3, Point3]
    if (stem) controls = stemControls(a.w, b.w, outwardAngle(a.w, a.node.id))
    else controls = bridgeControls(a.w, b.w, edge.id)
    const c1 = project(controls[0], camera, viewport, lens)
    const c2 = project(controls[1], camera, viewport, lens)
    if (!c1 || !c2) continue
    const minX = Math.min(a.x, b.x, c1.x, c2.x)
    const maxX = Math.max(a.x, b.x, c1.x, c2.x)
    const minY = Math.min(a.y, b.y, c1.y, c2.y)
    const maxY = Math.max(a.y, b.y, c1.y, c2.y)
    if (maxX < -20 || maxY < -20 || minX > viewport.width + 20 || minY > viewport.height + 20) continue

    let grow = 1
    if (scene.reveal !== undefined) {
      if (stem) {
        const anchor = anchors.get(a.node.id)
        grow = growthOf(stageOf(anchor, furthest, scene.reveal), Math.hypot(b.w.x - a.w.x, b.w.y - a.w.y) / (reach.get(a.node.id) ?? 100))
      } else grow = clamp((scene.reveal - 0.95) / 0.5, 0, 1)
      if (grow <= 0) continue
    }
    const main: Curve = { x0: a.x, y0: a.y, x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x3: b.x, y3: b.y }
    const tone = (a.tone + b.tone) / 2
    const core = stem ? a.core : Math.max(a.core * 0.5, b.core * 0.5)
    flows.push({ curve: main, id: edge.id, target: edge.target, lit, core, kind: stem ? "stem" : tie ? "tie" : "bridge", e, tone })

    // Strands: the centre line plus fine companions offset across the curve's middle.
    const strands = lit ? 3 : large ? 2 : camera.k < 0.3 ? 3 : 5
    const dx = b.w.x - a.w.x
    const dy = b.w.y - a.w.y
    const length = Math.hypot(dx, dy) || 1
    const nx = -dy / length
    const ny = dx / length
    for (let i = 0; i < strands; i++) {
      let curve = main
      if (i > 0) {
        const side = i % 2 === 0 ? 1 : -1
        const spread = length * (stem ? 0.045 : 0.026) * Math.ceil(i / 2) * side * (0.7 + hashUnit(`${edge.id}/${i}`) * 0.6)
        const o1 = project({ x: controls[0].x + nx * spread * 0.55, y: controls[0].y + ny * spread * 0.55, z: controls[0].z + spread * 0.2 }, camera, viewport, lens)
        const o2 = project({ x: controls[1].x + nx * spread * 1.2, y: controls[1].y + ny * spread * 1.2, z: controls[1].z - spread * 0.25 }, camera, viewport, lens)
        if (!o1 || !o2) continue
        curve = { x0: a.x, y0: a.y, x1: o1.x, y1: o1.y, x2: o2.x, y2: o2.y, x3: b.x, y3: b.y }
      }
      if (grow < 1) curve = sliceCurve(curve, grow)
      const strandShare = i === 0 ? 1 : i <= 2 ? 0.55 : 0.32
      if (lit) {
        ;(stem ? litStems : tie ? litTies : litBridges).curve((i === 0 ? 0.42 : 0.1) * tone, curve)
        continue
      }
      if (tie) {
        ties.curve((dark ? 0.3 : 0.4) * strandShare * tone * e, curve)
      } else if (stem) {
        const alpha = (dark ? 0.3 : 0.32) * (1 + 0.7 * core) * strandShare * tone * e * (large ? 0.7 : 1)
        stems.curve(alpha, curve)
      } else {
        const alpha = (dark ? 0.17 : 0.24) * strandShare * tone * e
        bridges.curve(alpha, curve)
      }
    }
  }
  if (scene.root) drawSpokes(scene, projected, flows, scene.reveal === undefined ? 1 : clamp(scene.reveal / 0.5, 0, 1), spokes)
  spokes.flush(ctx)
  stems.flush(ctx)
  bridges.flush(ctx)
  ties.flush(ctx)
  litStems.flush(ctx)
  litBridges.flush(ctx)
  litTies.flush(ctx)
  ctx.globalAlpha = 1
  return flows
}

/**
 * The core's spokes: one fine line from the core out to every hub — each
 * project belongs to the scope the core stands for. A spoke to a chosen or
 * hovered project brightens with it.
 */
function drawSpokes(scene: Scene, projected: Map<string, PNode>, flows: Flow[], show: number, batch: Batch) {
  const { camera, viewport, lens, palette } = scene
  const origin = { x: 0, y: 0, z: 14 }
  const from = project(origin, camera, viewport, lens)
  if (!from || show <= 0) return
  for (const entry of projected.values()) {
    if (entry.node.kind !== "project") continue
    const e = (scene.presence.get(entry.node.id) ?? 1) * entry.emphasis
    if (e <= 0.004) continue
    const [k1, k2] = spokeControls(origin, entry.w)
    const c1 = project(k1, camera, viewport, lens)
    const c2 = project(k2, camera, viewport, lens)
    if (!c1 || !c2) continue
    let curve: Curve = { x0: from.x, y0: from.y, x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x3: entry.x, y3: entry.y }
    if (show < 1) curve = sliceCurve(curve, show)
    const lit = scene.selected === entry.node.id || scene.hovered === entry.node.id
    const tone = (1 + entry.tone) / 2
    batch.curve((palette.dark ? 0.2 : 0.26) * (lit ? 2.4 : 1) * tone * e, curve)
    flows.push({ curve, id: `spoke:${entry.node.id}`, target: entry.node.id, lit: false, core: 0, kind: "spoke", e, tone })
  }
}

/** The part of a cubic from 0 to t (de Casteljau). */
function sliceCurve(c: Curve, t: number): Curve {
  const lerp = (a: number, b: number) => a + (b - a) * t
  const ax = lerp(c.x0, c.x1)
  const ay = lerp(c.y0, c.y1)
  const bx = lerp(c.x1, c.x2)
  const by = lerp(c.y1, c.y2)
  const cx = lerp(c.x2, c.x3)
  const cy = lerp(c.y2, c.y3)
  const dx = lerp(ax, bx)
  const dy = lerp(ay, by)
  const ex = lerp(bx, cx)
  const ey = lerp(by, cy)
  return { x0: c.x0, y0: c.y0, x1: ax, y1: ay, x2: dx, y2: dy, x3: lerp(dx, ex), y3: lerp(dy, ey) }
}

// ---------------------------------------------------------------- light

/**
 * Light moving along the filaments. Along the selection's relationships:
 * two sparks each, outward from the selection, unmistakable but slow.
 * Elsewhere: a sparse drift on the core's stems and on some of every
 * system's, and one spark on each bridge — never more than a few hundred.
 * With motion reduced the selection's sparks hold still and nothing else
 * is drawn.
 */
function drawParticles(ctx: CanvasRenderingContext2D, scene: Scene, flows: Flow[], cache: RenderCache) {
  const { palette } = scene
  const t = scene.time
  const glow = sprite(cache, palette.dark ? palette.rose : palette.filament, "spark")
  let ambientBudget = scene.nodes.length > LARGE ? 90 : 220
  for (const flow of flows) {
    let count = 0
    let speed = 0
    let brightness = 0
    if (flow.lit) {
      count = 2
      speed = 0.11
      brightness = 1
    } else if (scene.ambient && ambientBudget > 0 && scene.reveal === undefined) {
      const roll = hashUnit(`${flow.id}/spark`)
      if (flow.kind === "spoke") {
        count = 1
        speed = 0.022 + roll * 0.015
        brightness = 0.7
      } else if (flow.kind === "bridge" || flow.kind === "tie") {
        count = 1
        speed = 0.03
        brightness = 0.55
      } else if (flow.core > 0.05 && roll < 0.75) {
        count = 1
        speed = 0.035 + roll * 0.03
        brightness = 0.7 * flow.core
      } else if (roll < 0.22) {
        count = 1
        speed = 0.03 + roll * 0.04
        brightness = 0.4
      }
      if (count > 0) ambientBudget -= count
    }
    if (count === 0) continue
    const alpha = brightness * flow.e * flow.tone
    if (alpha <= 0.02) continue
    // Outward from the selection, or outward from the anchor.
    const reverse = flow.lit ? flow.target === scene.selected : false
    for (let i = 0; i < count; i++) {
      const phase = hashUnit(`${flow.id}/p${i}`) + i / count
      const u0 = flow.lit && !scene.ambient ? 0.32 + i * 0.36 : (((phase + t * speed) % 1) + 1) % 1
      const fade = Math.sin(Math.PI * u0)
      for (let tail = 3; tail >= 0; tail--) {
        const u = u0 - tail * 0.014
        if (u < 0) continue
        const v = reverse ? 1 - u : u
        const x = cubicAt(flow.curve.x0, flow.curve.x1, flow.curve.x2, flow.curve.x3, v)
        const y = cubicAt(flow.curve.y0, flow.curve.y1, flow.curve.y2, flow.curve.y3, v)
        const a = alpha * fade * (1 - tail * 0.24)
        if (tail === 0) {
          const radius = flow.lit ? 6 : 4.2
          ctx.globalAlpha = a * (palette.dark ? 0.9 : 0.5)
          ctx.drawImage(glow, x - radius, y - radius, radius * 2, radius * 2)
          ctx.globalAlpha = a
          ctx.fillStyle = rgb(palette.dark ? palette.blush : palette.ember)
          ctx.beginPath()
          ctx.arc(x, y, flow.lit ? 1.25 : 0.9, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.globalAlpha = a * 0.45
          ctx.fillStyle = rgb(palette.rose)
          ctx.fillRect(x - 0.5, y - 0.5, 1, 1)
        }
      }
    }
  }
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- nodes

function drawNodes(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>, cache: RenderCache): Hit[] {
  const { viewport } = scene
  const hits: Hit[] = []
  // Far to near, quiet under lit: what is closer and chosen is always on top.
  const ordered = [...projected.values()].sort((a, b) => a.e - b.e || a.scale - b.scale)
  const breathe = 0.88 + 0.12 * Math.sin(scene.time * ((Math.PI * 2) / 7))
  for (const entry of ordered) {
    if (entry.e <= 0.004 || !onScreen(entry.x, entry.y, entry.r * 12, viewport)) continue
    if (entry.there > 0.25) hits.push({ id: entry.node.id, x: entry.x, y: entry.y, r: entry.r })
    if (entry.node.kind === "project") drawAnchor(ctx, scene, entry, cache, breathe)
    else drawItem(ctx, scene, entry, cache)
    drawMarks(ctx, scene, entry)
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
  return hits
}

function drawItem(ctx: CanvasRenderingContext2D, scene: Scene, entry: PNode, cache: RenderCache) {
  const { palette, now } = scene
  const { node, x, y, r } = entry
  const kind = node.kind as FanKind
  const tint = palette.kinds[kind]
  const alpha = clamp(entry.e * entry.tone, 0, 1)
  const lifted = scene.selected === node.id || scene.hovered === node.id || scene.matches.has(node.id)

  if (palette.dark) {
    ctx.globalCompositeOperation = "lighter"
    const halo = r * (lifted ? 6.5 : 4.4)
    ctx.globalAlpha = (lifted ? 0.42 : 0.13) * alpha
    ctx.drawImage(sprite(cache, tint, "soft"), x - halo, y - halo, halo * 2, halo * 2)
    ctx.globalCompositeOperation = "source-over"
  }

  if (now - node.at < RECENT_MS && r > 2) {
    ctx.globalAlpha = 0.32 * alpha
    ctx.strokeStyle = rgb(palette.rose)
    ctx.lineWidth = 0.7
    ctx.beginPath()
    ctx.arc(x, y, r + 2.6, 0, Math.PI * 2)
    ctx.stroke()
  }

  const logo = kind === "conversation" && r >= 5.2 && node.provider ? logoFor(cache, node.provider, palette) : undefined
  if (logo) {
    const size = r * 2.5
    ctx.globalAlpha = Math.min(1, alpha * 1.1)
    ctx.drawImage(logo, x - size / 2, y - size / 2, size, size)
    return
  }
  // Up close, a source is its site: the icon the page itself declares, on a small light tile so a dark icon still reads.
  const icon = kind === "source" && r >= 5.2 && node.item?.domain ? siteIconFor(node.item.domain) : undefined
  if (icon) {
    const size = r * 2.3
    const pad = size * 0.16
    ctx.globalAlpha = Math.min(1, alpha * 1.05)
    ctx.fillStyle = rgb(palette.dark ? palette.starlight : [255, 255, 255])
    ctx.beginPath()
    ctx.roundRect(x - size / 2 - pad, y - size / 2 - pad, size + pad * 2, size + pad * 2, size * 0.26)
    ctx.fill()
    ctx.drawImage(icon, x - size / 2, y - size / 2, size, size)
    return
  }

  ctx.globalAlpha = node.unsettled ? alpha * 0.85 : Math.min(1, alpha * 1.05)
  ctx.fillStyle = rgb(tint)
  ctx.strokeStyle = rgb(tint)
  ctx.lineWidth = 0.9
  ctx.beginPath()
  switch (kind) {
    case "conversation":
      // A compact particle with a bright heart.
      ctx.arc(x, y, r, 0, Math.PI * 2)
      break
    case "source": {
      // A point of light with a fine cross: something found out in the world.
      ctx.arc(x, y, r * 0.78, 0, Math.PI * 2)
      break
    }
    case "file": {
      const s = r * 0.82
      ctx.rect(x - s, y - s, s * 2, s * 2)
      break
    }
    case "note": {
      const s = r * 1.12
      ctx.moveTo(x, y - s)
      ctx.lineTo(x + s, y)
      ctx.lineTo(x, y + s)
      ctx.lineTo(x - s, y)
      ctx.closePath()
      break
    }
    case "session":
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i + Math.PI / 6
        if (i === 0) ctx.moveTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r)
        else ctx.lineTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r)
      }
      ctx.closePath()
      break
  }
  // Hollow: a session (a frame of tabs), something still being read, a saved tab Hubble holds no text for.
  if (node.unsettled || node.savedTab || kind === "session") ctx.stroke()
  else ctx.fill()
  if (kind === "session" && !node.unsettled) {
    ctx.beginPath()
    ctx.arc(x, y, r * 0.32, 0, Math.PI * 2)
    ctx.fill()
  }
  if (kind === "source" && r > 1.8) {
    ctx.globalAlpha = alpha * 0.55
    ctx.lineWidth = 0.6
    ctx.beginPath()
    ctx.moveTo(x - r * 2.3, y)
    ctx.lineTo(x + r * 2.3, y)
    ctx.moveTo(x, y - r * 2.3)
    ctx.lineTo(x, y + r * 2.3)
    ctx.stroke()
  }
  if (kind === "conversation" && r > 1.8 && palette.dark) {
    ctx.globalAlpha = alpha
    ctx.fillStyle = rgb(palette.starlight)
    ctx.beginPath()
    ctx.arc(x, y, r * 0.42, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * A project's anchor: two fine hexagons turning against each other around a
 * bright point. The lit core adds its nucleus — layered light that breathes
 * very slowly — and a faint drop line to the galactic plane, which is what
 * places it in depth.
 */
function drawAnchor(ctx: CanvasRenderingContext2D, scene: Scene, entry: PNode, cache: RenderCache, breathe: number) {
  const { palette, camera, viewport, lens } = scene
  const { x, y, r, w } = entry
  const lit = entry.core
  const alpha = clamp(entry.e * Math.max(0.55, entry.tone), 0, 1)
  const spin = hashUnit(`${entry.node.id}/spin`) * Math.PI

  // Drop line to the plane: a hairline and the footprint it lands on.
  const foot = project({ x: w.x, y: w.y, z: 0 }, camera, viewport, lens)
  if (foot && Math.abs(foot.y - y) > 3) {
    ctx.globalAlpha = (palette.dark ? 0.1 : 0.14) * alpha
    ctx.strokeStyle = rgb(palette.starlight)
    ctx.lineWidth = 0.6
    ctx.setLineDash([1.5, 3])
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(foot.x, foot.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.ellipse(foot.x, foot.y, 4, 4 * Math.cos(lens.tilt), 0, 0, Math.PI * 2)
    ctx.stroke()
  }

  if (palette.dark || lit > 0) {
    ctx.globalCompositeOperation = palette.dark ? "lighter" : "source-over"
    const wide = r * (3.2 + 4 * lit)
    ctx.globalAlpha = (0.16 + 0.2 * lit * breathe) * alpha * (palette.dark ? 1 : 0.35)
    ctx.drawImage(sprite(cache, palette.filament, "soft"), x - wide, y - wide, wide * 2, wide * 2)
    const close = r * (1.5 + 1.4 * lit)
    ctx.globalAlpha = (0.22 + 0.45 * lit) * alpha * (palette.dark ? 1 : 0.3)
    ctx.drawImage(sprite(cache, palette.hub, "soft"), x - close, y - close, close * 2, close * 2)
    ctx.globalCompositeOperation = "source-over"
  }

  const turn = spin + scene.time * 0.05 * (0.3 + lit)
  ctx.lineWidth = 0.9
  ctx.strokeStyle = rgb(palette.starlight)
  ctx.globalAlpha = (0.26 + 0.45 * lit) * alpha
  polygon(ctx, x, y, r, 6, turn)
  ctx.stroke()
  ctx.strokeStyle = rgb(palette.dark ? palette.blush : palette.filament)
  ctx.globalAlpha = (0.22 + 0.45 * lit) * alpha
  polygon(ctx, x, y, r * 0.62, 6, -turn * 1.6 + Math.PI / 6)
  ctx.stroke()
  if (lit > 0.02) {
    // The nucleus's flare: two fine crossing lines, faint.
    ctx.globalAlpha = 0.22 * lit * alpha * breathe
    ctx.strokeStyle = rgb(palette.blush)
    ctx.lineWidth = 0.6
    ctx.beginPath()
    const flare = r * (2.4 + 1.2 * lit)
    ctx.moveTo(x - flare, y)
    ctx.lineTo(x + flare, y)
    ctx.moveTo(x, y - flare * 0.7)
    ctx.lineTo(x, y + flare * 0.7)
    ctx.stroke()
  }
  ctx.globalAlpha = Math.min(1, alpha * 1.1)
  // The hub itself: a small warm-gold point, the brightest thing in its fan.
  ctx.fillStyle = rgb(palette.hub)
  ctx.beginPath()
  ctx.arc(x, y, Math.max(1.8, r * (0.3 + 0.06 * lit)), 0, Math.PI * 2)
  ctx.fill()
}

/** Selection, hover, keyboard focus and search matches: rings, never fills. */
function drawMarks(ctx: CanvasRenderingContext2D, scene: Scene, entry: PNode) {
  const { palette } = scene
  const { node, x, y, r } = entry
  const ring = (radius: number, color: RGB | string, width: number, alpha: number, dash: number[] = []) => {
    ctx.globalAlpha = alpha
    ctx.strokeStyle = typeof color === "string" ? color : rgb(color)
    ctx.lineWidth = width
    ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }
  const gap = node.kind === "project" ? 5 : 3.5
  if (scene.matches.has(node.id) && scene.selected !== node.id) ring(r + gap, palette.rose, 1.1, 0.85)
  if (scene.hovered === node.id && scene.selected !== node.id) ring(r + gap, palette.starlight, 1, 0.5)
  if (scene.selected === node.id) {
    ring(r + gap, palette.dark ? palette.blush : palette.filament, 1.3, 0.95)
    // A slow dial around what you chose: four arcs turning once a minute.
    const turn = scene.time * 0.1
    ctx.globalAlpha = 0.5
    ctx.strokeStyle = rgb(palette.rose)
    ctx.lineWidth = 0.8
    for (let i = 0; i < 4; i++) {
      ctx.beginPath()
      ctx.arc(x, y, r + gap + 6, turn + (i * Math.PI) / 2, turn + (i * Math.PI) / 2 + Math.PI / 4)
      ctx.stroke()
    }
  }
  if (scene.focused === node.id) ring(r + gap + 10, palette.focus, 1.3, 0.95, [3, 3])
}

function polygon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sides: number, rotation: number) {
  ctx.beginPath()
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i / sides) * Math.PI * 2
    if (i === 0) ctx.moveTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r)
    else ctx.lineTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r)
  }
  ctx.closePath()
}

function drawVignette(ctx: CanvasRenderingContext2D, { viewport, palette }: Scene) {
  const { width, height } = viewport
  const gradient = ctx.createRadialGradient(width / 2, height * 0.48, Math.min(width, height) * 0.32, width / 2, height / 2, Math.hypot(width, height) * 0.6)
  gradient.addColorStop(0, "transparent")
  gradient.addColorStop(1, palette.background)
  ctx.globalAlpha = palette.dark ? 0.72 : 0.35
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- labels

/**
 * Names, placed greedily by priority and never overlapping: the selection,
 * the hovered node and search matches first, then every project, then what
 * the selection connects to, then — once close enough to read — the most
 * recent items. A project's name sits beside it on a short leader line, with
 * its count beneath in the mono figure style.
 */
function drawLabels(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>, cache: RenderCache) {
  const { palette, viewport } = scene
  const candidates: { entry: PNode; priority: number }[] = []
  for (const entry of projected.values()) {
    if (entry.e <= 0.05 || !onScreen(entry.x, entry.y, 0, viewport)) continue
    const id = entry.node.id
    let priority = -1
    if (scene.selected === id) priority = 100
    else if (scene.hovered === id) priority = 95
    else if (scene.matches.has(id)) priority = 80
    else if (entry.node.kind === "project") priority = 70 + entry.core * 5
    else if (scene.selected && (scene.emphasis.get(id) ?? 1) > 0.9) priority = 60
    // With a selection, only what it connects to is named: the rest stays quiet.
    else if (scene.selected) priority = -1
    else if (entry.scale >= 1.25) priority = 10 + entry.tone * 20
    if (priority >= 0) candidates.push({ entry, priority })
  }
  candidates.sort((a, b) => b.priority - a.priority || b.entry.node.at - a.entry.node.at)

  const placed: { x: number; y: number; w: number; h: number }[] = []
  const overlaps = (box: { x: number; y: number; w: number; h: number }) => placed.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)
  const measure = (font: string, text: string) => {
    const key = `${font}|${text}`
    let width = cache.widths.get(key)
    if (width === undefined) {
      ctx.font = font
      width = ctx.measureText(text).width
      if (cache.widths.size > 6000) cache.widths.clear()
      cache.widths.set(key, width)
    }
    return width
  }
  ctx.textBaseline = "middle"
  ctx.lineJoin = "round"

  // The core's name, centred beneath it, before anything else claims the space.
  const core = scene.root ? project({ x: 0, y: 0, z: 0 }, scene.camera, viewport, scene.lens) : undefined
  if (scene.root && core && onScreen(core.x, core.y, 0, viewport)) {
    const show = scene.reveal === undefined ? 1 : clamp((scene.reveal - 0.2) / 0.5, 0, 1)
    const font = `500 13px ${palette.displayFont}`
    const detailFont = `500 9px ${palette.monoFont}`
    const top = core.y + Math.max(26, 34 * core.scale)
    const w = Math.max(measure(font, scene.root.label), measure(detailFont, scene.root.detail) + scene.root.detail.length * 0.8)
    placed.push({ x: core.x - w / 2 - 4, y: top - 10, w: w + 8, h: 34 })
    ctx.textAlign = "center"
    ctx.font = font
    ctx.globalAlpha = 0.95 * show
    ctx.strokeStyle = palette.background
    ctx.lineWidth = 3
    ctx.strokeText(scene.root.label, core.x, top)
    ctx.fillStyle = palette.foreground
    ctx.fillText(scene.root.label, core.x, top)
    ctx.font = detailFont
    ctx.globalAlpha = 0.8 * show
    ctx.fillStyle = palette.tertiary
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0.8px"
    ctx.fillText(scene.root.detail, core.x, top + 16)
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px"
  }
  let drawn = 0
  for (const { entry, priority } of candidates) {
    if (drawn > 240) break
    const isProject = entry.node.kind === "project"
    const text = isProject ? entry.node.label : shorten(entry.node.label)
    const size = isProject ? (entry.core > 0.5 ? 13.5 : 12.5) : 11
    const font = `${isProject ? 500 : 400} ${size}px ${isProject ? palette.displayFont : palette.uiFont}`
    const width = measure(font, text)
    const count = isProject ? `${entry.node.size ?? 0} ${entry.node.size === 1 ? "ITEM" : "ITEMS"}` : ""
    const countFont = `500 9px ${palette.monoFont}`
    const countWidth = isProject ? measure(countFont, count) + count.length * 0.8 : 0
    const blockW = Math.max(width, countWidth)
    const blockH = isProject ? size + 14 : size + 2
    const lead = isProject ? 14 : 5
    // Beside the node, to the right unless that runs off the canvas.
    const right = entry.x + entry.r + lead + blockW < viewport.width - 8
    const x = right ? entry.x + entry.r + lead : entry.x - entry.r - lead - blockW
    const y = isProject ? entry.y - (size + 14) / 2 + 2 : entry.y - blockH / 2
    const box = { x: x - 3, y: y - 2, w: blockW + 6, h: blockH + 4 }
    if (priority < 95 && overlaps(box)) continue
    placed.push(box)
    drawn += 1
    const alpha = isProject ? clamp((0.5 + 0.5 * entry.e) * Math.max(0.65, entry.tone), 0, 1) : priority >= 80 ? 1 : clamp((0.4 + 0.5 * entry.e) * entry.tone, 0, 1)

    if (isProject) {
      // The leader: a hairline from the anchor out to its name.
      ctx.globalAlpha = alpha * 0.35
      ctx.strokeStyle = rgb(palette.starlight)
      ctx.lineWidth = 0.6
      ctx.beginPath()
      const from = right ? entry.x + entry.r + 3 : entry.x - entry.r - 3
      const to = right ? x - 4 : x + blockW + 4
      ctx.moveTo(from, entry.y)
      ctx.lineTo(to, entry.y)
      ctx.stroke()
    }
    ctx.textAlign = "left"
    ctx.font = font
    ctx.globalAlpha = alpha
    ctx.strokeStyle = palette.background
    ctx.lineWidth = 3
    const textY = isProject ? y + size / 2 : entry.y
    ctx.strokeText(text, x, textY)
    ctx.fillStyle = isProject || priority >= 80 ? palette.foreground : palette.muted
    ctx.fillText(text, x, textY)
    if (isProject) {
      ctx.font = countFont
      ctx.globalAlpha = alpha * 0.85
      ctx.fillStyle = palette.tertiary
      if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0.8px"
      ctx.strokeText(count, x, textY + size / 2 + 8)
      ctx.fillText(count, x, textY + size / 2 + 8)
      if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px"
    }
  }
  ctx.globalAlpha = 1
}

const truncated = new Map<string, string>()
function shorten(label: string): string {
  let cached = truncated.get(label)
  if (cached === undefined) {
    cached = label.length > LABEL_MAX_CHARS ? `${label.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…` : label
    if (truncated.size > 5000) truncated.clear()
    truncated.set(label, cached)
  }
  return cached
}

// ---------------------------------------------------------------- assets

/**
 * Pre-rendered light: a soft gaussian-ish glow ("soft"), a tight spark
 * ("spark") and a very wide falloff for haze ("haze"), each per colour.
 */
export function sprite(cache: RenderCache, color: RGB, kind: "soft" | "spark" | "haze"): HTMLCanvasElement {
  const key = `${kind}:${color.join(",")}`
  let canvas = cache.sprites.get(key)
  if (canvas) return canvas
  canvas = document.createElement("canvas")
  const size = kind === "haze" ? 256 : 64
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext("2d")
  if (ctx) {
    const half = size / 2
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half)
    const [r, g, b] = color
    const stops: [number, number][] =
      kind === "spark"
        ? [
            [0, 1],
            [0.18, 0.55],
            [0.45, 0.12],
            [1, 0],
          ]
        : kind === "haze"
          ? [
              [0, 1],
              [0.3, 0.5],
              [0.62, 0.16],
              [1, 0],
            ]
          : [
              [0, 1],
              [0.12, 0.6],
              [0.35, 0.2],
              [0.7, 0.04],
              [1, 0],
            ]
    for (const [at, a] of stops) gradient.addColorStop(at, `rgba(${r}, ${g}, ${b}, ${a})`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)
  }
  cache.sprites.set(key, canvas)
  return canvas
}

/**
 * An AI app's supplied logo, loaded once and kept. A one-colour logo
 * (ChatGPT's) is recoloured to the galaxy's starlight so it reads on ink.
 * Draws nothing until it has loaded — a conversation is its point of light
 * until then.
 */
/** A site's icon, once lib/favicon/client.ts holds a verified one; asking is cheap and idempotent. The canvas redraws when one arrives. */
function siteIconFor(domain: string): HTMLImageElement | undefined {
  if (typeof Image === "undefined") return undefined
  requestFavicon(domain)
  return peekFaviconImage(domain) ?? undefined
}

function logoFor(cache: RenderCache, provider: string, palette: Palette): HTMLImageElement | HTMLCanvasElement | undefined {
  const logo = providerLogo(provider)
  if (!logo) return undefined
  const key = `${provider}:${palette.dark ? "d" : "l"}`
  const held = cache.logos.get(key)
  if (held === "loading" || held === "failed") return undefined
  if (held) return held
  if (typeof Image === "undefined") return undefined
  cache.logos.set(key, "loading")
  const image = new Image()
  image.decoding = "async"
  image.onload = () => {
    let ready: HTMLImageElement | HTMLCanvasElement = image
    const size = 96
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext("2d")
    if (ctx) {
      ctx.save()
      ctx.beginPath()
      if (logo.round) ctx.roundRect(0, 0, size, size, size * 0.22)
      else ctx.rect(0, 0, size, size)
      ctx.clip()
      ctx.drawImage(image, 0, 0, size, size)
      ctx.restore()
      if (logo.mono) {
        ctx.globalCompositeOperation = "source-in"
        ctx.fillStyle = rgb(palette.dark ? palette.starlight : palette.ember)
        ctx.fillRect(0, 0, size, size)
      }
      ready = canvas
    }
    cache.logos.set(key, ready)
    cache.onAsset?.()
  }
  image.onerror = () => cache.logos.set(key, "failed")
  image.src = logo.src
  return undefined
}

// ---------------------------------------------------------------- palette

/** Reads the live theme and the Graph's own light off the document; derives ink variants on light themes. */
export function readPalette(element: Element = document.documentElement): Palette {
  const style = getComputedStyle(element)
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  const dark = v("--polarity", "dark") !== "light"
  const background = v("--background", "#0b0c0f")
  const ground = parseColor(background) ?? [11, 12, 15]
  const starlight = parseColor(v("--graph-starlight", "#f3ebe4")) ?? [243, 235, 228]
  const ink: RGB = [28, 22, 26]
  const tone = (raw: RGB, darken: number): RGB => (dark ? raw : mix(raw, ink, darken))
  const filament = tone(parseColor(v("--graph-filament", "#d24868")) ?? [210, 72, 104], 0.18)
  const rose = tone(parseColor(v("--graph-rose", "#ec8298")) ?? [236, 130, 152], 0.3)
  const blush = tone(parseColor(v("--graph-blush", "#f7c6cf")) ?? [247, 198, 207], 0.55)
  const ember = tone(parseColor(v("--graph-ember", "#8e2440")) ?? [142, 36, 64], 0.1)
  const hub = tone(parseColor(v("--graph-hub", "#e9c27c")) ?? [233, 194, 124], 0.45)
  // Kinds keep the theme's hue but are drawn mostly in starlight: restrained, never a neon legend.
  const kind = (name: string, fallback: RGB): RGB => {
    const raw = parseColor(v(name, "")) ?? fallback
    return dark ? mix(raw, starlight, 0.66) : mix(raw, ink, 0.2)
  }
  return {
    background: dark ? rgb(mix(ground, [0, 0, 0], 0.35)) : background,
    foreground: v("--foreground", "#e8eaef"),
    muted: v("--muted-foreground", "#9599a3"),
    tertiary: v("--text-tertiary", "#737781"),
    focus: v("--focus", "#8b8f98"),
    kinds: {
      conversation: kind("--kind-conversation", [138, 180, 255]),
      source: kind("--kind-source", [111, 211, 193]),
      file: kind("--kind-file", [226, 183, 122]),
      note: kind("--kind-note", [196, 169, 255]),
      session: kind("--kind-session", [242, 159, 179]),
    },
    filament,
    rose,
    blush,
    ember,
    hub,
    starlight: dark ? starlight : ink,
    displayFont: v("--hb-font-display", "system-ui") || "system-ui",
    uiFont: v("--tabdump-font-ui", "system-ui") || "system-ui",
    monoFont: v("--font-mono", "ui-monospace, monospace") || "ui-monospace, monospace",
    dark,
  }
}

export function parseColor(value: string): RGB | undefined {
  const text = value.trim()
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1]!
    const full =
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const fn = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])]
  return undefined
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]
}

const rgbCache = new Map<string, string>()
function rgb(color: RGB): string {
  const key = color.join(",")
  let css = rgbCache.get(key)
  if (!css) {
    css = `rgb(${color[0]}, ${color[1]}, ${color[2]})`
    rgbCache.set(key, css)
  }
  return css
}

// ---------------------------------------------------------------- helpers

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function onScreen(x: number, y: number, margin: number, viewport: Viewport): boolean {
  return x > -margin && y > -margin && x < viewport.width + margin && y < viewport.height + margin
}

/** The galaxy's orbits: one per project at its distance from the centre, merged where they nearly coincide. */
export function orbitRadii(nodes: readonly KnowledgeNode[], positions: ReadonlyMap<string, Point>): number[] {
  const radii: number[] = []
  let furthest = 0
  for (const node of nodes) {
    const at = positions.get(node.id)
    if (!at) continue
    const radius = Math.hypot(at.x, at.y)
    furthest = Math.max(furthest, radius)
    if (node.kind === "project" && radius > 40) radii.push(radius)
  }
  radii.sort((a, b) => a - b)
  const merged: number[] = []
  for (const radius of radii) if (merged.length === 0 || radius - merged[merged.length - 1]! > 70) merged.push(radius)
  const out = merged.slice(0, 12)
  // One more, just beyond everything: the edge of the galaxy.
  if (furthest > 0) out.push(furthest * 1.06 + 30)
  return out
}
