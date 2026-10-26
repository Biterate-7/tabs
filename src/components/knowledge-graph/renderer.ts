import { providerLogo } from "@/components/memory/provider-mark"
import { peekFaviconImage, requestFavicon } from "@/lib/favicon/client"
import { contrast, darkBackground, DEFAULT_GRAPH_COLORS, hexToRgb } from "@/lib/knowledge-graph/appearance"
import type { GraphColors, GraphEffects } from "@/lib/knowledge-graph/appearance"
import { bridgeControls, clusterReach, cubicAt, hashUnit, threadControls, worldPoint } from "@/lib/knowledge-graph/galaxy"
import type { FanKind, Point3 } from "@/lib/knowledge-graph/galaxy"
import { nodeRadius } from "@/lib/knowledge-graph/layout"
import { project } from "@/lib/knowledge-graph/projection"
import type { Lens } from "@/lib/knowledge-graph/projection"
import type { Camera, Viewport } from "@/lib/knowledge-graph/view"
import { PERSONAL_EDGE_KINDS } from "@/lib/knowledge-graph/types"
import type { KnowledgeEdge, KnowledgeNode, Point } from "@/lib/knowledge-graph/types"
import { FIELD_STRIDE } from "./galaxy-field"
import type { Field, FieldColors, Nebula } from "./galaxy-field"

/**
 * The knowledge galaxy's painter. Pure in what it decides: given the scene,
 * it draws one frame and reports where every node landed on screen (for
 * hit-testing). All state — camera, lens, emphasis, presence, the clock of
 * the ambient motion — belongs to the canvas component.
 *
 * ## Layers, back to front
 *
 *   back (2D)   the ground, a few distant stars on three parallax layers,
 *               faint gas along the arms, the core's halo and the galaxy's
 *               three orbital lines
 *   dust (GPU)  the core, arms, disc and every cluster's knot as thousands
 *               of particles (galaxy-field.ts, galaxy-gl.ts) — drawn here in
 *               2D, sparser, only where there is no WebGL
 *   front (2D)  what the person keeps: the outline of a chosen cluster,
 *               relationships as fine arcs with light moving along the
 *               chosen ones, the core's nucleus, every item as one small
 *               star shaped and tinted by kind (up close a conversation
 *               shows its AI app's logo and a source its site's icon), and
 *               names, greedy and collision-free, by priority
 *
 * Every point is projected through a real perspective camera (projection.ts)
 * from a 3D position (galaxy.ts), so depth — size, brightness, parallax — is
 * the geometry's, not a decoration's. Strokes are batched into one path per
 * colour and brightness, so thousands of relationships cost a handful of
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
  // Each field is one role of the galaxy's light; graph appearance (lib/knowledge-graph/appearance.ts) recolours them by role.
  /** Connections: relationships between items. */
  filament: RGB
  /** Connections: relationships between items, on paper. */
  bridge: RGB
  /** Connections: a cluster's threads to its own stars. */
  spoke: RGB
  /** Accent: relationships the person made, search matches, the selection's dial. */
  rose: RGB
  /** Accent, lightest: the selection, lit relationships, sparks, a chosen cluster's outline. */
  blush: RGB
  /** Accent, deepest: on light themes, what blush is on dark. */
  accent: RGB
  /** Glow: a hub's illumination. */
  glow: RGB
  /** Glow, deepest. */
  ember: RGB
  /** Space: stars, orbits, the core. */
  starlight: RGB
  /** Nodes: outlines and bright hearts. */
  node: RGB
  /** The light of a project's heart. */
  hub: RGB
  /** The galaxy's gas and dust: indigo, violet and teal. */
  nebula: readonly [RGB, RGB, RGB]
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
  /** 0 (quiet) … 1 (full) per node: what the selection or search brings forward. */
  emphasis: ReadonlyMap<string, number>
  /** 0 … 1 per node: arriving and departing nodes fade rather than pop. */
  presence: ReadonlyMap<string, number>
  /** 0 … 1 per project node: how lit its cluster is (the chosen project, or the selection's). */
  coreness: ReadonlyMap<string, number>
  selected?: string
  hovered?: string
  focused?: string
  matches: ReadonlySet<string>
  /** Edges touching the selection — drawn brightest, with light travelling along them. */
  highlighted: ReadonlySet<string>
  /** Seconds on the ambient clock; frozen when motion is reduced. */
  time: number
  /** Whether light drifts. Off: the selection's light still shows, held still. */
  ambient: boolean
  /** The opening, 0 → 1.6; undefined once it has played. */
  reveal?: number
  /** The galaxy's radius in world units (galaxy.ts `galaxyExtent`). */
  extent: number
  /** The gas along the arms (galaxy-field.ts `galaxyNebulae`). */
  nebulae: readonly Nebula[]
  /**
   * The scope the core stands for — all of the person's projects — named
   * beneath it. Absent when one project is chosen.
   */
  root?: { label: string; detail: string }
  now: number
  /** The person's chosen strengths: glow, stars, connections, node size, labels, space. */
  effects: GraphEffects
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
  /** Presence × reveal alone: whether it is there at all (hit-testing, relationships). */
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
/** The galaxy's orbital lines, as fractions of its radius, with each one's lean out of the plane. */
const ORBITS: readonly { at: number; incline: number; alpha: number; dash: boolean }[] = [
  { at: 0.4, incline: 0.16, alpha: 0.15, dash: false },
  { at: 0.68, incline: -0.1, alpha: 0.11, dash: false },
  { at: 0.93, incline: 0, alpha: 0.09, dash: true },
]

/** The back layer: everything behind the dust. With `fallback`, the dust too, for a browser without WebGL. */
export function drawBack(ctx: CanvasRenderingContext2D, scene: Scene, cache: RenderCache, fallback?: Field) {
  const { viewport, palette, dpr } = scene
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, viewport.width, viewport.height)
  ctx.globalCompositeOperation = palette.dark ? "lighter" : "source-over"
  if (scene.effects.space) {
    drawStars(ctx, scene, cache)
    drawNebulae(ctx, scene, cache)
  }
  drawOrbits(ctx, scene)
  if (fallback) drawFieldFallback(ctx, scene, fallback)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
}

/** The front layer: what the person keeps, over the dust. Returns where each node landed, for hit-testing. */
export function drawFront(ctx: CanvasRenderingContext2D, scene: Scene, cache: RenderCache): Hit[] {
  const { viewport, palette, dpr } = scene
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
  ctx.clearRect(0, 0, viewport.width, viewport.height)

  const reach = reachOf(scene.nodes, cache)
  const projected = projectNodes(scene)
  ctx.globalCompositeOperation = palette.dark ? "lighter" : "source-over"
  drawRegions(ctx, scene, projected, reach)
  const flows = drawRelations(ctx, scene, projected)
  drawSparks(ctx, scene, flows, cache)
  drawNucleus(ctx, scene, cache)
  ctx.globalCompositeOperation = "source-over"
  const hits = drawNodes(ctx, scene, projected, cache)
  drawVignette(ctx, scene)
  drawLabels(ctx, scene, projected, cache)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
  return hits
}

/** The colours the particle field is built in, from the palette. */
export function fieldColors(palette: Palette): FieldColors {
  const [indigo, violet, teal] = palette.nebula
  return {
    dark: palette.dark,
    star: palette.starlight,
    core: palette.dark ? [255, 249, 240] : mix(INK, indigo, 0.25),
    arms: [mix(indigo, violet, 0.35), mix(indigo, teal, 0.55)],
    tints: [indigo, violet, teal],
  }
}

// ---------------------------------------------------------------- projection

/** Each project's cluster reach, by node id; cached per node list. */
export function reachOf(nodes: readonly KnowledgeNode[], cache: RenderCache): Map<string, number> {
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
  for (const node of nodes) if (node.kind === "project") map.set(node.id, clusterReach(counts.get(node.id) ?? new Map()))
  cache.reach.set(nodes, map)
  return map
}

function projectNodes(scene: Scene): Map<string, PNode> {
  const { camera, viewport, lens } = scene
  const out = new Map<string, PNode>()
  for (const node of scene.nodes) {
    const w = worldPoint(node, scene.positions)
    if (!w) continue
    const at = project(w, camera, viewport, lens)
    if (!at) continue
    const worldR = nodeRadius(node)
    const r = (node.kind === "project" ? clamp(worldR * at.scale, 3, 15) : clamp(worldR * at.scale, 0.9, 6.5)) * scene.effects.nodeScale
    const emphasis = scene.emphasis.get(node.id) ?? 1
    let there = scene.presence.get(node.id) ?? 1
    // The opening: stars light from the core outward, a little after the dust has grown past them.
    if (scene.reveal !== undefined) there *= clamp((scene.reveal - 0.45 - (Math.hypot(w.x, w.y) / scene.extent) * 0.75) / 0.3, 0, 1)
    out.set(node.id, { node, w, x: at.x, y: at.y, scale: at.scale, r, e: emphasis * there, there, emphasis, tone: clamp(0.4 + ((at.s - 0.62) / 0.6) * 0.6, 0.34, 1.08), core: node.kind === "project" ? (scene.coreness.get(node.id) ?? 0) : 0 })
  }
  return out
}

// ---------------------------------------------------------------- back

function drawStars(ctx: CanvasRenderingContext2D, scene: Scene, cache: RenderCache) {
  const { viewport, camera, lens, palette } = scene
  const { width, height } = viewport
  const density = scene.effects.stars
  const key = `${Math.round(width / 80)}x${Math.round(height / 80)}x${density.toFixed(2)}`
  if (cache.starsKey !== key) {
    cache.starsKey = key
    const count = Math.round(clamp((width * height) / 9000, 40, 240) * density)
    cache.stars = Array.from({ length: count }, (_, i) => {
      const layer = i % 3
      return {
        u: hashUnit(`star-u${i}`),
        v: hashUnit(`star-v${i}`),
        size: [0.5, 0.7, 0.95][layer]! * (0.8 + hashUnit(`star-s${i}`) * 0.5),
        alpha: [0.16, 0.24, 0.36][layer]! * (0.45 + hashUnit(`star-a${i}`) * 0.55),
        layer,
        warm: hashUnit(`star-w${i}`) < 0.2,
      }
    })
  }
  const factors = [0.012, 0.03, 0.06]
  const ink = palette.dark ? 1 : 0.5
  for (const star of cache.stars) {
    const f = factors[star.layer]!
    // Far layers barely move: the camera's travel and the lens's sway, scaled by depth.
    const sx = star.u * width - camera.x * camera.k * f + lens.yaw * width * f * 7
    const sy = star.v * height - camera.y * camera.k * f * Math.cos(lens.tilt) + (lens.tilt - 0.9) * height * f * 5
    const x = ((sx % width) + width) % width
    const y = ((sy % height) + height) % height
    const twinkle = scene.ambient ? 0.75 + 0.25 * Math.sin(scene.time * 0.9 + star.u * 40) : 1
    ctx.globalAlpha = star.alpha * ink * twinkle
    ctx.fillStyle = rgb(star.warm ? palette.nebula[0] : palette.starlight)
    ctx.fillRect(x, y, star.size, star.size)
  }
  ctx.globalAlpha = 1
}

/** Gas along the arms and the core's halo: broad, faint and cool, lying in the plane of the disc. */
function drawNebulae(ctx: CanvasRenderingContext2D, scene: Scene, cache: RenderCache) {
  const { palette, camera, viewport, lens } = scene
  const strength = (palette.dark ? 1 : 0.5) * scene.effects.glow
  const grow = scene.reveal === undefined ? 1 : easeOut(clamp(scene.reveal / 1.1, 0, 1))
  const squash = Math.cos(lens.tilt)
  const haze = (x: number, y: number, size: number, color: RGB, alpha: number) => {
    const at = project({ x: x * grow, y: y * grow, z: 0 }, camera, viewport, lens)
    if (!at) return
    const s = size * at.scale
    if (!onScreen(at.x, at.y, s, viewport)) return
    ctx.globalAlpha = clamp(alpha * strength * grow, 0, 1)
    ctx.save()
    ctx.translate(at.x, at.y)
    ctx.scale(1, squash)
    ctx.drawImage(sprite(cache, color, "haze"), -s, -s, s * 2, s * 2)
    ctx.restore()
  }
  for (const nebula of scene.nebulae) haze(nebula.x, nebula.y, nebula.size, palette.nebula[nebula.tint]!, nebula.alpha)
  const breathe = scene.ambient ? 1 + 0.04 * Math.sin(scene.time * 0.8) : 1
  haze(0, 0, scene.extent * 0.42 * breathe, palette.nebula[0], 0.3)
  ctx.globalAlpha = 1
}

/** The galaxy's orbits: two fine inclined ellipses and a dashed rim, brighter on the near side. */
function drawOrbits(ctx: CanvasRenderingContext2D, scene: Scene) {
  const { palette, camera, viewport, lens } = scene
  const show = scene.reveal === undefined ? 1 : clamp(scene.reveal / 0.8, 0, 1)
  const light = palette.dark ? 1 : 1.4
  ctx.lineWidth = 0.75
  ctx.strokeStyle = rgb(palette.starlight)
  for (const orbit of ORBITS) {
    const radius = scene.extent * orbit.at * (0.86 + 0.14 * easeOut(show))
    ctx.setLineDash(orbit.dash ? [1.2, 3.6] : [])
    for (const near of [false, true]) {
      ctx.globalAlpha = orbit.alpha * show * light * (near ? 1 : 0.45)
      ctx.beginPath()
      let drawing = false
      for (let i = 0; i <= 180; i++) {
        const a = (i / 180) * Math.PI * 2
        const at = project({ x: Math.cos(a) * radius, y: Math.sin(a) * radius * Math.cos(orbit.incline), z: Math.sin(a) * radius * Math.sin(orbit.incline) }, camera, viewport, lens)
        if (!at || at.s >= 1 !== near) {
          drawing = false
          continue
        }
        if (drawing) ctx.lineTo(at.x, at.y)
        else ctx.moveTo(at.x, at.y)
        drawing = true
      }
      ctx.stroke()
    }
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

/** The dust without a GPU: the same field, sparser, projected one particle at a time. */
function drawFieldFallback(ctx: CanvasRenderingContext2D, scene: Scene, field: Field) {
  const { camera, viewport, lens, palette } = scene
  const data = field.data
  const grow = scene.reveal === undefined ? 1 : clamp(scene.reveal / 1.6, 0, 1)
  for (let i = 0; i < field.count; i++) {
    const o = i * FIELD_STRIDE
    const rn = Math.hypot(data[o]!, data[o + 1]!) / field.extent
    const g = clamp((grow * 1.6 - rn * 0.7) / 0.5, 0, 1)
    if (g <= 0) continue
    const at = project({ x: data[o]! * (0.82 + 0.18 * g), y: data[o + 1]! * (0.82 + 0.18 * g), z: data[o + 2]! }, camera, viewport, lens)
    if (!at || !onScreen(at.x, at.y, 2, viewport)) continue
    const twinkle = scene.ambient ? 0.72 + 0.28 * Math.sin(scene.time * data[o + 9]! + data[o + 8]!) : 1
    ctx.globalAlpha = clamp(data[o + 4]! * twinkle * g * (palette.dark ? 1 : 0.8), 0, 1)
    ctx.fillStyle = `rgb(${Math.round(data[o + 5]! * 255)}, ${Math.round(data[o + 6]! * 255)}, ${Math.round(data[o + 7]! * 255)})`
    const size = Math.max(0.7, data[o + 3]! * clamp(at.s, 0.6, 1.6))
    ctx.fillRect(at.x - size / 2, at.y - size / 2, size, size)
  }
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- front: regions and relationships

/** A chosen (or hovered) project's cluster, outlined: a fine ellipse round its stars, lying in the disc. */
function drawRegions(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>, reach: ReadonlyMap<string, number>) {
  const { palette, camera, viewport, lens } = scene
  const light = palette.dark ? 1 : 1.5
  for (const entry of projected.values()) {
    if (entry.node.kind !== "project") continue
    const hovered = scene.hovered === entry.node.id || scene.selected === entry.node.id
    const strength = Math.max(entry.core, hovered ? 0.55 : 0) * entry.there
    if (strength <= 0.02) continue
    const radius = (reach.get(entry.node.id) ?? 40) * 1.15 + 8
    if (!onScreen(entry.x, entry.y, radius * entry.scale * 1.3, viewport)) continue
    for (const [scaleBy, alpha, dash] of [
      [1, 0.2, []],
      [1.3, 0.1, [1.5, 4]],
    ] as const) {
      ctx.setLineDash(dash)
      ctx.beginPath()
      let drawing = false
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2
        const at = project({ x: entry.w.x + Math.cos(a) * radius * scaleBy, y: entry.w.y + Math.sin(a) * radius * scaleBy, z: entry.w.z }, camera, viewport, lens)
        if (!at) {
          drawing = false
          continue
        }
        if (drawing) ctx.lineTo(at.x, at.y)
        else ctx.moveTo(at.x, at.y)
        drawing = true
      }
      ctx.strokeStyle = rgb(palette.dark ? palette.blush : palette.accent)
      ctx.lineWidth = 0.75
      ctx.globalAlpha = alpha * strength * light
      ctx.stroke()
    }
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

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

type Flow = { curve: Curve; id: string; target: string; lit: boolean; kind: "thread" | "bridge" | "tie"; e: number; tone: number }

/**
 * Relationships as fine arcs. Belonging to a project needs no line — its
 * cluster says it — so a cluster's threads to its own stars appear only
 * while it is hovered or chosen. Every relationship between items (the
 * same source in two projects, an excerpt, a session, the links and
 * dependencies the person drew) is a faint arc lifting out of the disc,
 * the person's own in the accent. Those touching the selection brighten.
 */
function drawRelations(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>): Flow[] {
  const { palette, camera, viewport, lens } = scene
  const dark = palette.dark
  const width = clamp(0.5 + camera.k * 0.2, 0.5, 1.1)
  // How strongly the person wants relationships drawn; the selection's own stay as they are.
  const strength = scene.effects.connections
  const bridges = new Batch(rgb(dark ? palette.filament : palette.bridge), width * 0.9)
  const ties = new Batch(rgb(palette.rose), width)
  const threads = new Batch(rgb(palette.spoke), width * 0.8)
  const lit = new Batch(rgb(palette.blush), width * 1.3)
  const litTies = new Batch(rgb(palette.rose), width * 1.35)
  const flows: Flow[] = []
  const large = scene.nodes.length > LARGE

  for (const edge of scene.edges) {
    const a = projected.get(edge.source)
    const b = projected.get(edge.target)
    if (!a || !b) continue
    // Presence and the reveal, times the quieter end's emphasis.
    const e = Math.min(a.there, b.there) * Math.min(a.emphasis, b.emphasis)
    if (e <= 0.004) continue
    const thread = (edge.kind === "contains" || edge.kind === "session-project") && a.node.kind === "project"
    const tie = PERSONAL_EDGE_KINDS.has(edge.kind)
    const isLit = scene.highlighted.has(edge.id)
    const shown = isLit || !thread || scene.hovered === a.node.id
    if (!shown) continue
    const controls = thread ? threadControls(a.w, b.w) : bridgeControls(a.w, b.w, edge.id)
    const c1 = project(controls[0], camera, viewport, lens)
    const c2 = project(controls[1], camera, viewport, lens)
    if (!c1 || !c2) continue
    const minX = Math.min(a.x, b.x, c1.x, c2.x)
    const maxX = Math.max(a.x, b.x, c1.x, c2.x)
    const minY = Math.min(a.y, b.y, c1.y, c2.y)
    const maxY = Math.max(a.y, b.y, c1.y, c2.y)
    if (maxX < -20 || maxY < -20 || minX > viewport.width + 20 || minY > viewport.height + 20) continue

    let curve: Curve = { x0: a.x, y0: a.y, x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x3: b.x, y3: b.y }
    if (scene.reveal !== undefined && !thread) {
      const grow = clamp((scene.reveal - 1.05) / 0.45, 0, 1)
      if (grow <= 0) continue
      if (grow < 1) curve = sliceCurve(curve, grow)
    }
    const tone = (a.tone + b.tone) / 2
    flows.push({ curve, id: edge.id, target: edge.target, lit: isLit, kind: thread ? "thread" : tie ? "tie" : "bridge", e, tone })
    if (isLit) (tie ? litTies : lit).curve((thread ? 0.26 : 0.5) * tone, curve)
    else if (thread) threads.curve((dark ? 0.12 : 0.18) * tone * e * strength, curve)
    else if (tie) ties.curve((dark ? 0.3 : 0.4) * tone * e * strength, curve)
    else bridges.curve((dark ? 0.2 : 0.26) * tone * e * strength * (large ? 0.75 : 1), curve)
  }
  threads.flush(ctx)
  bridges.flush(ctx)
  ties.flush(ctx)
  lit.flush(ctx)
  litTies.flush(ctx)
  ctx.globalAlpha = 1
  return flows
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

/**
 * Light moving along relationships. Along the selection's: two sparks
 * each, outward from the selection, unmistakable but slow. Elsewhere, a
 * sparse drift on some relationships between projects — never more than a
 * hundred or so. With motion reduced the selection's sparks hold still and
 * nothing else is drawn.
 */
function drawSparks(ctx: CanvasRenderingContext2D, scene: Scene, flows: Flow[], cache: RenderCache) {
  const { palette } = scene
  const t = scene.time
  const glow = sprite(cache, palette.dark ? palette.blush : palette.accent, "spark")
  const halo = scene.effects.glow
  let budget = scene.nodes.length > LARGE ? 50 : 110
  for (const flow of flows) {
    let count = 0
    let speed = 0
    let brightness = 0
    if (flow.lit) {
      count = flow.kind === "thread" ? 1 : 2
      speed = 0.11
      brightness = flow.kind === "thread" ? 0.6 : 1
    } else if (scene.ambient && budget > 0 && scene.reveal === undefined && flow.kind !== "thread") {
      const roll = hashUnit(`${flow.id}/spark`)
      if (roll < 0.4) {
        count = 1
        speed = 0.025 + roll * 0.04
        brightness = flow.kind === "tie" ? 0.6 : 0.45
        budget -= 1
      }
    }
    if (count === 0) continue
    const alpha = brightness * flow.e * flow.tone
    if (alpha <= 0.02) continue
    // Outward from the selection.
    const reverse = flow.lit ? flow.target === scene.selected : false
    for (let i = 0; i < count; i++) {
      const phase = hashUnit(`${flow.id}/p${i}`) + i / count
      const u = flow.lit && !scene.ambient ? 0.32 + i * 0.36 : (((phase + t * speed) % 1) + 1) % 1
      const fade = Math.sin(Math.PI * u)
      const v = reverse ? 1 - u : u
      const x = cubicAt(flow.curve.x0, flow.curve.x1, flow.curve.x2, flow.curve.x3, v)
      const y = cubicAt(flow.curve.y0, flow.curve.y1, flow.curve.y2, flow.curve.y3, v)
      const radius = flow.lit ? 5.5 : 3.6
      ctx.globalAlpha = clamp(alpha * fade * (palette.dark ? 0.8 : 0.45) * halo, 0, 1)
      ctx.drawImage(glow, x - radius, y - radius, radius * 2, radius * 2)
      ctx.globalAlpha = clamp(alpha * fade, 0, 1)
      ctx.fillStyle = rgb(palette.dark ? palette.blush : palette.accent)
      ctx.beginPath()
      ctx.arc(x, y, flow.lit ? 1.1 : 0.8, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

/**
 * The core's nucleus: a soft bloom flattened into the disc, and a small,
 * brilliant white heart over the dust packed beneath it. It stands for the
 * whole of the person's work, so nothing else is as bright.
 */
function drawNucleus(ctx: CanvasRenderingContext2D, scene: Scene, cache: RenderCache) {
  const { palette, camera, viewport, lens } = scene
  const at = project({ x: 0, y: 0, z: 0 }, camera, viewport, lens)
  if (!at) return
  const R = scene.extent
  const bloom = R * 0.15 * at.scale
  if (!onScreen(at.x, at.y, bloom * 2, viewport)) return
  const show = scene.reveal === undefined ? 1 : clamp(scene.reveal / 0.5, 0, 1)
  const breathe = scene.ambient ? 1 + 0.05 * Math.sin(scene.time * 0.8) : 1
  const squash = Math.cos(lens.tilt)
  const intensity = scene.effects.glow
  const white: RGB = palette.dark ? [255, 251, 245] : palette.accent
  ctx.globalAlpha = clamp(0.62 * show * Math.sqrt(intensity) * (palette.dark ? 1 : 0.45), 0, 1)
  const b = bloom * breathe
  ctx.drawImage(sprite(cache, palette.dark ? palette.starlight : palette.nebula[0], "soft"), at.x - b, at.y - b * squash * 1.4, b * 2, b * 2 * squash * 1.4)
  const heart = clamp(R * 0.035 * at.scale, 5, 26)
  ctx.globalAlpha = clamp(0.95 * show * (palette.dark ? 1 : 0.6), 0, 1)
  ctx.drawImage(sprite(cache, white, "spark"), at.x - heart, at.y - heart, heart * 2, heart * 2)
  ctx.globalAlpha = show
  ctx.fillStyle = rgb(white)
  ctx.beginPath()
  ctx.arc(at.x, at.y, clamp(R * 0.004 * at.scale, 1.2, 3), 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- front: nodes

function drawNodes(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>, cache: RenderCache): Hit[] {
  const { viewport } = scene
  const hits: Hit[] = []
  // Far to near, quiet under lit: what is closer and chosen is always on top.
  const ordered = [...projected.values()].sort((a, b) => a.e - b.e || a.scale - b.scale)
  const breathe = scene.ambient ? 0.9 + 0.1 * Math.sin(scene.time * ((Math.PI * 2) / 7)) : 1
  for (const entry of ordered) {
    if (entry.e <= 0.004 || !onScreen(entry.x, entry.y, entry.r * 12, viewport)) continue
    // A star is a small target: it is hit a little beyond its light.
    if (entry.there > 0.25) hits.push({ id: entry.node.id, x: entry.x, y: entry.y, r: entry.node.kind === "project" ? entry.r * 1.6 : Math.max(entry.r, 2.5) })
    if (entry.node.kind === "project") drawHub(ctx, scene, entry, cache, breathe)
    else drawStar(ctx, scene, entry, cache)
    drawMarks(ctx, scene, entry)
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
  return hits
}

/**
 * One item: a single star. Its kind is in its tint (kept mostly starlight —
 * restrained, never a neon legend) and its shape up close: a conversation
 * is the brightest, with a faint four-point flare; a source a smaller,
 * cooler point; a file a tiny square; a note a diamond; a session a hollow
 * hexagon. Hollow too: anything still being read, and a saved tab Hubble
 * holds no text for.
 */
function drawStar(ctx: CanvasRenderingContext2D, scene: Scene, entry: PNode, cache: RenderCache) {
  const { palette, now } = scene
  const { node, x, y, r } = entry
  const kind = node.kind as FanKind
  const tint = palette.kinds[kind]
  const alpha = clamp(entry.e * entry.tone, 0, 1)
  const lifted = scene.selected === node.id || scene.hovered === node.id || scene.matches.has(node.id)
  // What was touched lately burns a little brighter.
  const recent = now - node.at < RECENT_MS ? 1 : 0

  if (palette.dark) {
    ctx.globalCompositeOperation = "lighter"
    const halo = r * (lifted ? 7 : (kind === "conversation" ? 4.4 : 3.4) + recent * 0.8)
    ctx.globalAlpha = clamp((lifted ? 0.5 : (kind === "conversation" ? 0.24 : 0.16) + recent * 0.08) * alpha * scene.effects.glow, 0, 1)
    ctx.drawImage(sprite(cache, tint, "soft"), x - halo, y - halo, halo * 2, halo * 2)
    if (kind === "conversation" && r > 2) {
      // The flare: two fine crossing lines, the way a bright star catches a lens.
      const flare = r * (lifted ? 4.2 : 3)
      ctx.globalAlpha = clamp(0.22 * alpha, 0, 1)
      ctx.strokeStyle = rgb(mix(tint, palette.node, 0.5))
      ctx.lineWidth = 0.6
      ctx.beginPath()
      ctx.moveTo(x - flare, y)
      ctx.lineTo(x + flare, y)
      ctx.moveTo(x, y - flare)
      ctx.lineTo(x, y + flare)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = "source-over"
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
    ctx.fillStyle = rgb(palette.dark ? palette.node : [255, 255, 255])
    ctx.beginPath()
    ctx.roundRect(x - size / 2 - pad, y - size / 2 - pad, size + pad * 2, size + pad * 2, size * 0.26)
    ctx.fill()
    ctx.drawImage(icon, x - size / 2, y - size / 2, size, size)
    return
  }

  const body = palette.dark ? mix(tint, palette.node, 0.3) : tint
  ctx.globalAlpha = node.unsettled ? alpha * 0.85 : Math.min(1, alpha * 1.05)
  ctx.fillStyle = rgb(body)
  ctx.strokeStyle = rgb(body)
  ctx.lineWidth = 0.8
  ctx.beginPath()
  switch (kind) {
    case "conversation":
      ctx.arc(x, y, r * 0.85, 0, Math.PI * 2)
      break
    case "source":
      ctx.arc(x, y, node.savedTab || node.unsettled ? r * 0.6 : r * 0.7, 0, Math.PI * 2)
      break
    case "file": {
      const s = r * 0.68
      ctx.rect(x - s, y - s, s * 2, s * 2)
      break
    }
    case "note": {
      const s = r * 0.95
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
  // Hollow: a session (a frame of tabs), something still being read, a saved tab Hubble holds no text for — a fainter star inside a fine ring.
  const hollow = node.unsettled || node.savedTab || kind === "session"
  if (hollow) {
    ctx.globalAlpha *= 0.75
    ctx.lineWidth = 0.6
    ctx.stroke()
    if (kind !== "session") {
      ctx.globalAlpha *= 0.6
      ctx.beginPath()
      ctx.arc(x, y, Math.max(0.6, r * 0.28), 0, Math.PI * 2)
      ctx.fill()
    }
  } else ctx.fill()
  if (kind === "session" && !node.unsettled) {
    ctx.beginPath()
    ctx.arc(x, y, r * 0.3, 0, Math.PI * 2)
    ctx.fill()
  }
  if (palette.dark && r > 1.6 && !node.savedTab && !node.unsettled && kind !== "session") {
    ctx.globalAlpha = alpha
    ctx.fillStyle = rgb(palette.node)
    ctx.beginPath()
    ctx.arc(x, y, r * 0.36, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * A project's heart: the brightest point of its cluster, in a soft glow
 * that widens and breathes while the cluster is chosen. The cluster's dust
 * (galaxy-field.ts) is what makes it a region; this is what you point at.
 */
function drawHub(ctx: CanvasRenderingContext2D, scene: Scene, entry: PNode, cache: RenderCache, breathe: number) {
  const { palette } = scene
  const { x, y, r } = entry
  const lit = entry.core
  const lifted = scene.hovered === entry.node.id || scene.selected === entry.node.id ? 1 : 0
  const alpha = clamp(entry.e * Math.max(0.6, entry.tone), 0, 1)
  const intensity = scene.effects.glow
  ctx.globalCompositeOperation = palette.dark ? "lighter" : "source-over"
  const wide = r * (3.2 + 2.6 * lit + 1.2 * lifted)
  ctx.globalAlpha = clamp((0.2 + 0.22 * lit * breathe + 0.1 * lifted) * alpha * (palette.dark ? 1 : 0.35) * intensity, 0, 1)
  ctx.drawImage(sprite(cache, palette.hub, "soft"), x - wide, y - wide, wide * 2, wide * 2)
  const close = r * (1.3 + 0.8 * lit)
  ctx.globalAlpha = clamp((0.4 + 0.35 * lit + 0.15 * lifted) * alpha * (palette.dark ? 1 : 0.4) * Math.sqrt(intensity), 0, 1)
  ctx.drawImage(sprite(cache, palette.dark ? palette.node : palette.accent, "spark"), x - close, y - close, close * 2, close * 2)
  ctx.globalCompositeOperation = "source-over"
  ctx.globalAlpha = Math.min(1, alpha * 1.1)
  ctx.fillStyle = rgb(palette.dark ? mix(palette.hub, palette.node, 0.5) : palette.accent)
  ctx.beginPath()
  ctx.arc(x, y, Math.max(1.6, r * (0.28 + 0.06 * lit)), 0, Math.PI * 2)
  ctx.fill()
}

/** Selection, hover, keyboard focus and search matches: fine rings, never fills. */
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
  if (scene.matches.has(node.id) && scene.selected !== node.id) ring(r + gap, palette.rose, 1, 0.8)
  if (scene.hovered === node.id && scene.selected !== node.id) ring(r + gap, palette.starlight, 0.9, 0.4)
  if (scene.selected === node.id) {
    ring(r + gap, palette.dark ? palette.blush : palette.accent, 1.1, 0.9)
    // A slow dial around what you chose: four short arcs turning once a minute.
    const turn = scene.time * 0.1
    ctx.globalAlpha = 0.4
    ctx.strokeStyle = rgb(palette.rose)
    ctx.lineWidth = 0.75
    for (let i = 0; i < 4; i++) {
      ctx.beginPath()
      ctx.arc(x, y, r + gap + 5, turn + (i * Math.PI) / 2, turn + (i * Math.PI) / 2 + Math.PI / 5)
      ctx.stroke()
    }
  }
  if (scene.focused === node.id) ring(r + gap + 9, palette.focus, 1.2, 0.9, [3, 3])
}

function drawVignette(ctx: CanvasRenderingContext2D, { viewport, palette }: Scene) {
  const { width, height } = viewport
  const gradient = ctx.createRadialGradient(width / 2, height * 0.48, Math.min(width, height) * 0.34, width / 2, height / 2, Math.hypot(width, height) * 0.62)
  gradient.addColorStop(0, "transparent")
  gradient.addColorStop(1, palette.background)
  ctx.globalAlpha = palette.dark ? 0.66 : 0.32
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- labels

/**
 * Names, placed greedily by priority and never overlapping: the selection,
 * the hovered node and search matches first, then every project, then what
 * the selection connects to, then — once close enough to read — the most
 * recent items. A project's name sits beside its heart on a short leader
 * line, with its count beneath in the mono figure style.
 */
function drawLabels(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, PNode>, cache: RenderCache) {
  const { palette, viewport } = scene
  // With labels hidden, only what is chosen or pointed at is named.
  const labels = scene.effects.labels
  const candidates: { entry: PNode; priority: number }[] = []
  for (const entry of projected.values()) {
    if (entry.e <= 0.05 || !onScreen(entry.x, entry.y, 0, viewport)) continue
    const id = entry.node.id
    let priority = -1
    if (scene.selected === id) priority = 100
    else if (scene.hovered === id) priority = 95
    else if (!labels) priority = -1
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
  const spacing = (value: string) => {
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = value
  }
  ctx.textBaseline = "middle"
  ctx.lineJoin = "round"

  // The core's name, centred beneath its bloom, before anything else claims the space.
  const core = scene.root ? project({ x: 0, y: 0, z: 0 }, scene.camera, viewport, scene.lens) : undefined
  if (labels && scene.root && core && onScreen(core.x, core.y, 0, viewport)) {
    const show = scene.reveal === undefined ? 1 : clamp((scene.reveal - 0.3) / 0.5, 0, 1)
    const font = `500 12px ${palette.displayFont}`
    const detailFont = `500 9px ${palette.monoFont}`
    const top = core.y + Math.max(26, scene.extent * 0.1 * core.scale * Math.cos(scene.lens.tilt) + 14)
    const w = Math.max(measure(font, scene.root.label), measure(detailFont, scene.root.detail) + scene.root.detail.length * 0.8)
    placed.push({ x: core.x - w / 2 - 4, y: top - 10, w: w + 8, h: 32 })
    ctx.textAlign = "center"
    ctx.font = font
    ctx.globalAlpha = 0.8 * show
    ctx.strokeStyle = palette.background
    ctx.lineWidth = 3
    ctx.strokeText(scene.root.label, core.x, top)
    ctx.fillStyle = palette.foreground
    ctx.fillText(scene.root.label, core.x, top)
    ctx.font = detailFont
    ctx.globalAlpha = 0.7 * show
    ctx.fillStyle = palette.tertiary
    spacing("0.8px")
    ctx.fillText(scene.root.detail, core.x, top + 15)
    spacing("0px")
  }
  let drawn = 0
  for (const { entry, priority } of candidates) {
    if (drawn > 240) break
    const isProject = entry.node.kind === "project"
    const text = isProject ? entry.node.label : shorten(entry.node.label)
    const size = isProject ? (entry.core > 0.5 ? 13 : 12) : 11
    const font = `${isProject ? 500 : 400} ${size}px ${isProject ? palette.displayFont : palette.uiFont}`
    const width = measure(font, text)
    const count = isProject ? `${entry.node.size ?? 0} ${entry.node.size === 1 ? "ITEM" : "ITEMS"}` : ""
    const countFont = `500 9px ${palette.monoFont}`
    const countWidth = isProject ? measure(countFont, count) + count.length * 0.8 : 0
    const blockW = Math.max(width, countWidth)
    const blockH = isProject ? size + 13 : size + 2
    const lead = isProject ? 16 : 5
    // Beside the node, to the right unless that runs off the canvas.
    const right = entry.x + entry.r + lead + blockW < viewport.width - 8
    const x = right ? entry.x + entry.r + lead : entry.x - entry.r - lead - blockW
    const y = isProject ? entry.y - (size + 13) / 2 + 2 : entry.y - blockH / 2
    const box = { x: x - 3, y: y - 2, w: blockW + 6, h: blockH + 4 }
    if (priority < 95 && overlaps(box)) continue
    placed.push(box)
    drawn += 1
    const alpha = isProject ? clamp((0.45 + 0.5 * entry.e) * Math.max(0.65, entry.tone), 0, 1) : priority >= 80 ? 1 : clamp((0.4 + 0.5 * entry.e) * entry.tone, 0, 1)

    if (isProject) {
      // The leader: a hairline from the heart out to its name.
      ctx.globalAlpha = alpha * 0.28
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
      ctx.globalAlpha = alpha * 0.8
      ctx.fillStyle = palette.tertiary
      spacing("0.8px")
      ctx.strokeText(count, x, textY + size / 2 + 8)
      ctx.fillText(count, x, textY + size / 2 + 8)
      spacing("0px")
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

/** A site's icon, once lib/favicon/client.ts holds a verified one; asking is cheap and idempotent. The canvas redraws when one arrives. */
function siteIconFor(domain: string): HTMLImageElement | undefined {
  if (typeof Image === "undefined") return undefined
  requestFavicon(domain)
  return peekFaviconImage(domain) ?? undefined
}

/**
 * An AI app's supplied logo, loaded once and kept. A one-colour logo
 * (ChatGPT's) is recoloured to the galaxy's starlight so it reads on ink.
 * Draws nothing until it has loaded — a conversation is its point of light
 * until then.
 */
function logoFor(cache: RenderCache, provider: string, palette: Palette): HTMLImageElement | HTMLCanvasElement | undefined {
  const logo = providerLogo(provider)
  if (!logo) return undefined
  const tint = palette.dark ? palette.node : palette.ember
  const key = `${provider}:${logo.mono ? tint.join(",") : palette.dark ? "d" : "l"}`
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
        ctx.fillStyle = rgb(tint)
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

/** Reads the live theme and the Graph's own light off the document, with the person's colours over it (see resolvePalette). */
export function readPalette(element: Element = document.documentElement, colors: GraphColors = DEFAULT_GRAPH_COLORS): Palette {
  const style = getComputedStyle(element)
  return resolvePalette((name) => style.getPropertyValue(name).trim(), colors)
}

const BLACK: RGB = [0, 0, 0]
const WHITE: RGB = [255, 255, 255]
const INK: RGB = [28, 22, 26]

/**
 * The galaxy's light from the theme's tokens and the person's colours.
 *
 * A colour left to Hubble is exactly the token's light; one the person set
 * recolours its role — accent, connections, nodes, glow, background — with
 * that role's lighter and deeper tones derived from it. Ink variants are
 * derived on light themes; a custom background is always a dark one, so it
 * turns the galaxy dark whatever the theme. Once anything is customised,
 * every line, node and label colour is kept legible on the ground: lifted
 * toward light (or ink) until it clears a contrast floor.
 */
export function resolvePalette(read: (name: string) => string, colors: GraphColors = DEFAULT_GRAPH_COLORS): Palette {
  const v = (name: string, fallback: string) => read(name) || fallback
  const token = (name: string, fallback: RGB): RGB => parseColor(read(name)) ?? fallback
  const custom = (role: keyof GraphColors): RGB | undefined => {
    const hex = colors[role]
    return hex ? hexToRgb(hex) : undefined
  }
  const accent = custom("accent")
  const link = custom("connections")
  const nodes = custom("nodes")
  const light = custom("glow")
  const customGround = colors.background ? darkBackground(colors.background).rgb : undefined

  const dark = customGround ? true : v("--polarity", "dark") !== "light"
  const themeBackground = v("--background", "#0b0c0f")
  const background = customGround ? rgb(customGround) : dark ? rgb(mix(parseColor(themeBackground) ?? [11, 12, 15], BLACK, 0.35)) : themeBackground
  const starlightRaw = token("--graph-starlight", [238, 242, 255])
  const starlight = dark ? starlightRaw : INK
  const tone = (raw: RGB, darken: number): RGB => (dark ? raw : mix(raw, INK, darken))

  // Hubble's own light, as the tokens give it.
  const own = {
    filament: tone(token("--graph-filament", [125, 140, 255]), 0.18),
    rose: tone(token("--graph-rose", [169, 184, 255]), 0.3),
    blush: tone(token("--graph-blush", [223, 230, 255]), 0.55),
    ember: tone(token("--graph-ember", [42, 47, 122]), 0.1),
    hub: tone(token("--graph-hub", [214, 224, 255]), 0.45),
  }

  const ground = parseColor(background) ?? BLACK
  const guarded = customGround !== undefined || accent !== undefined || link !== undefined || nodes !== undefined || light !== undefined
  const toward = dark ? WHITE : INK
  const keep = (color: RGB, floor = 3): RGB => (guarded ? legible(color, ground, floor, toward) : color)
  const keepText = (css: string, floor: number): string => {
    const color = guarded ? parseColor(css) : undefined
    return color ? rgb(legible(color, ground, floor, toward)) : css
  }

  // Kinds keep the theme's hue but are drawn mostly in starlight (or the person's node colour): restrained, never a neon legend.
  const kind = (name: string, fallback: RGB): RGB => {
    const raw = token(name, fallback)
    return keep(dark ? mix(raw, nodes ?? starlightRaw, 0.66) : mix(nodes ? mix(raw, nodes, 0.4) : raw, INK, 0.2))
  }
  // The gas: the theme's link, note and source hues — or variations on the person's glow.
  const gas = (name: string, fallback: RGB): RGB => tone(token(name, fallback), 0.35)
  const nebula: [RGB, RGB, RGB] = light
    ? [tone(light, 0.35), tone(mix(light, accent ?? starlightRaw, 0.4), 0.35), tone(mix(light, WHITE, 0.3), 0.35)]
    : [gas("--link", [138, 180, 255]), gas("--kind-note", [196, 169, 255]), gas("--kind-source", [111, 211, 193])]
  // A light theme's ink would only be lifted to the floor on a dark custom ground: the galaxy takes Hubble Dark's text instead.
  const text = (name: string, ownDark: string) => (customGround && v("--polarity", "dark") === "light" ? ownDark : v(name, ownDark))
  return {
    background,
    foreground: keepText(text("--foreground", "#e8eaef"), 4.5),
    muted: keepText(text("--muted-foreground", "#9599a3"), 4.5),
    tertiary: keepText(text("--text-tertiary", "#737781"), 3),
    focus: v("--focus", "#8b8f98"),
    kinds: {
      conversation: kind("--kind-conversation", [138, 180, 255]),
      source: kind("--kind-source", [111, 211, 193]),
      file: kind("--kind-file", [226, 183, 122]),
      note: kind("--kind-note", [196, 169, 255]),
      session: kind("--kind-session", [242, 159, 179]),
    },
    filament: keep(link ? tone(link, 0.18) : own.filament),
    bridge: keep(link ? (dark ? mix(link, starlightRaw, 0.55) : tone(mix(link, INK, 0.35), 0.1)) : dark ? starlight : own.ember),
    spoke: keep(link ? (dark ? mix(link, WHITE, 0.45) : tone(link, 0.18)) : dark ? own.blush : own.filament),
    rose: keep(accent ? tone(accent, 0.3) : own.rose),
    blush: keep(accent ? tone(mix(accent, WHITE, 0.55), 0.55) : own.blush),
    accent: keep(accent ? tone(accent, 0.18) : own.filament),
    glow: light ? tone(light, 0.18) : own.filament,
    ember: light ? tone(mix(light, BLACK, 0.4), 0.1) : own.ember,
    hub: keep(accent ? tone(mix(accent, WHITE, 0.3), 0.45) : own.hub),
    starlight,
    node: keep(nodes ? tone(nodes, 0.6) : starlight),
    nebula,
    displayFont: v("--hb-font-display", "system-ui") || "system-ui",
    uiFont: v("--tabdump-font-ui", "system-ui") || "system-ui",
    monoFont: v("--font-mono", "ui-monospace, monospace") || "ui-monospace, monospace",
    dark,
  }
}

/** `color`, or the nearest step from it toward `toward` that reads against `ground` at `floor`:1 or better. */
function legible(color: RGB, ground: RGB, floor: number, toward: RGB): RGB {
  if (contrast(color, ground) >= floor) return color
  for (let step = 1; step < 10; step++) {
    const next = mix(color, toward, step / 10)
    if (contrast(next, ground) >= floor) return next
  }
  return toward
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
