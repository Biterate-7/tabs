import { hashUnit, nodeRadius, territoryRadius } from "@/lib/knowledge-graph/layout"
import type { Camera, Viewport } from "@/lib/knowledge-graph/view"
import type { GraphNodeKind, KnowledgeEdge, KnowledgeNode, Point } from "@/lib/knowledge-graph/types"

/**
 * The knowledge graph's painter. Pure: given the scene, it draws one frame
 * and returns nothing — every piece of state (camera, emphasis, the pulse)
 * belongs to the canvas component, which decides when a frame is needed.
 *
 * Everything is drawn in screen space from positions projected once per
 * frame, so strokes and text keep a constant, crisp size at every zoom and
 * off-screen nodes cost nothing but the projection.
 *
 * ## Level of detail
 *
 *   far      projects and their names; items as small marks
 *   middle   + items emphasised by hover, selection or search are named
 *   near     + every item that has room is named
 *
 * Labels are placed greedily by priority (selection, hover, matches,
 * projects, then the most recent items) and never overlap: a name that would
 * collide is simply not drawn until there is room for it.
 */

export type Palette = {
  background: string
  foreground: string
  muted: string
  tertiary: string
  border: string
  card: string
  link: string
  focus: string
  kinds: Record<Exclude<GraphNodeKind, "project">, string>
  displayFont: string
  uiFont: string
  dark: boolean
}

export type Scene = {
  nodes: readonly KnowledgeNode[]
  edges: readonly KnowledgeEdge[]
  positions: Readonly<Record<string, Point>>
  camera: Camera
  viewport: Viewport
  dpr: number
  palette: Palette
  /** 0 (quiet) … 1 (full) per node, eased by the caller toward its target. */
  emphasis: ReadonlyMap<string, number>
  selected?: string
  /** The project node the selection belongs to (or is). */
  selectedProject?: string
  hovered?: string
  /** The node the keyboard is on (drawn with the focus ring). */
  focused?: string
  matches: ReadonlySet<string>
  /** Edges touching the selection — drawn last and brightest. */
  highlighted: ReadonlySet<string>
  /** A signal travelling out from the selection along its edges: 0 … 1, or undefined when idle. */
  pulse?: number
  /** The opening reveal, 0 … 1; undefined once it has played. */
  reveal?: number
  /** Item count per project id (sizes territories). */
  projectItems: ReadonlyMap<string, number>
  now: number
}

const RECENT_MS = 36 * 3600_000
const LABEL_MAX_CHARS = 30

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

type Projected = { node: KnowledgeNode; x: number; y: number; r: number; e: number }

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { viewport, camera, palette, dpr } = scene
  const { width, height } = viewport
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, width, height)

  drawStarfield(ctx, scene)
  drawNebula(ctx, scene)

  // ---- project every node once; cull what is far off screen ----
  const margin = 80
  const projected = new Map<string, Projected>()
  for (const node of scene.nodes) {
    const p = scene.positions[node.id]
    if (!p) continue
    const x = (p.x - camera.x) * camera.k + width / 2
    const y = (p.y - camera.y) * camera.k + height / 2
    const worldR = nodeRadius(node)
    const r = node.kind === "project" ? Math.max(7, worldR * camera.k) : Math.max(2.4, worldR * Math.min(camera.k, 2.2))
    const reach = node.kind === "project" ? territoryRadius(scene.projectItems.get(node.id) ?? 0) * camera.k : r
    if (x < -reach - margin || y < -reach - margin || x > width + reach + margin || y > height + reach + margin) {
      // Off screen, but its edges may still cross the screen: keep the point, mark it invisible.
      projected.set(node.id, { node, x, y, r, e: -1 })
      continue
    }
    projected.set(node.id, { node, x, y, r, e: scene.emphasis.get(node.id) ?? 1 })
  }
  if (scene.reveal !== undefined) applyReveal(projected, scene.reveal)

  drawTerritories(ctx, scene, projected)
  drawEdges(ctx, scene, projected)
  drawNodes(ctx, scene, projected)
  drawVignette(ctx, viewport, palette)
  drawLabels(ctx, scene, projected)
  ctx.globalAlpha = 1
}

/**
 * A faint field of points behind everything, moving at 70% of the camera —
 * enough parallax to read as depth, never enough to compete with a node.
 * Spacing doubles as the camera pulls back so density stays even.
 */
function drawStarfield(ctx: CanvasRenderingContext2D, { camera, viewport, palette }: Scene) {
  let spacing = 46 * camera.k
  while (spacing < 22) spacing *= 2
  while (spacing > 92) spacing /= 2
  const parallax = 0.7
  const ox = (((-camera.x * camera.k * parallax + viewport.width / 2) % spacing) + spacing) % spacing
  const oy = (((-camera.y * camera.k * parallax + viewport.height / 2) % spacing) + spacing) % spacing
  ctx.fillStyle = palette.foreground
  ctx.globalAlpha = palette.dark ? 0.07 : 0.09
  for (let x = ox; x < viewport.width; x += spacing) {
    for (let y = oy; y < viewport.height; y += spacing) ctx.fillRect(Math.round(x), Math.round(y), 1, 1)
  }
  ctx.globalAlpha = 1
}

/** Each project's neighbourhood: a soft pool of light under its items, brighter when it is in focus. */
function drawTerritories(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, Projected>) {
  const { palette, camera } = scene
  for (const entry of projected.values()) {
    if (entry.node.kind !== "project" || entry.e < 0) continue
    const radius = territoryRadius(scene.projectItems.get(entry.node.id) ?? 0) * camera.k
    if (radius < 8) continue
    const active = scene.selectedProject === entry.node.id
    const gradient = ctx.createRadialGradient(entry.x, entry.y, 0, entry.x, entry.y, radius)
    // A cool pool of light: the link tone, faint — brighter for the project in focus.
    const tint = palette.link
    gradient.addColorStop(0, tint)
    gradient.addColorStop(1, "transparent")
    ctx.globalAlpha = (active ? (palette.dark ? 0.11 : 0.05) : palette.dark ? 0.05 : 0.02) * (0.4 + 0.6 * entry.e)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(entry.x, entry.y, radius, 0, Math.PI * 2)
    ctx.fill()
    // The orbit: a hairline at the territory's edge, the one place the Hubble mark's ring shows up in the product.
    if (radius > 40) {
      ctx.globalAlpha = (palette.dark ? 0.07 : 0.09) * entry.e
      ctx.strokeStyle = active ? palette.link : palette.foreground
      ctx.lineWidth = 1
      ctx.setLineDash([2, 6])
      ctx.beginPath()
      ctx.arc(entry.x, entry.y, radius * 0.94, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
  ctx.globalAlpha = 1
}


/** A gentle bend, always to the same side for the same edge, so parallel lines fan rather than stack. */
function controlPoint(a: Projected, b: Projected, edgeId: string, orbital = false): Point {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  // A project's own lines all turn the same way — the neighbourhood reads as one orbiting system.
  const bend = orbital ? 0.14 : (hashUnit(edgeId) - 0.5) * 0.36
  return { x: mx - dy * bend, y: my + dx * bend }
}

function edgeColor(scene: Scene, edge: KnowledgeEdge, target: Projected): string {
  const { palette } = scene
  if (edge.kind === "contains") return target.node.kind === "project" ? palette.foreground : palette.kinds[target.node.kind]
  if (edge.kind === "session-project" || edge.kind === "session-source") return palette.kinds.session
  return palette.link
}

function drawEdges(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, Projected>) {
  const { palette } = scene
  const quiet: { edge: KnowledgeEdge; a: Projected; b: Projected }[] = []
  const lit: { edge: KnowledgeEdge; a: Projected; b: Projected }[] = []
  for (const edge of scene.edges) {
    const a = projected.get(edge.source)
    const b = projected.get(edge.target)
    if (!a || !b || (a.e < 0 && b.e < 0)) continue
    ;(scene.highlighted.has(edge.id) ? lit : quiet).push({ edge, a, b })
  }

  ctx.lineCap = "round"
  for (const { edge, a, b } of quiet) {
    const e = Math.min(a.e < 0 ? 1 : a.e, b.e < 0 ? 1 : b.e)
    const cross = edge.kind !== "contains" && edge.kind !== "session-project"
    ctx.globalAlpha = (cross ? (palette.dark ? 0.34 : 0.42) : palette.dark ? 0.17 : 0.2) * e
    ctx.strokeStyle = edgeColor(scene, edge, b)
    ctx.lineWidth = cross ? 1 : 0.9
    ctx.setLineDash(cross ? [3, 4] : [])
    const c = controlPoint(a, b, edge.id, edge.kind === "contains" || edge.kind === "session-project")
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // The selection's relationships: brighter, with the colour running from one end to the other.
  for (const { edge, a, b } of lit) {
    const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    const from = a.node.kind === "project" ? palette.foreground : a.node.kind === "session" ? palette.kinds.session : palette.kinds[a.node.kind]
    gradient.addColorStop(0, from)
    gradient.addColorStop(1, edgeColor(scene, edge, b))
    ctx.globalAlpha = palette.dark ? 0.75 : 0.85
    ctx.strokeStyle = gradient
    ctx.lineWidth = 1.5
    ctx.setLineDash(edge.kind === "contains" || edge.kind === "session-project" ? [] : [4, 4])
    const c = controlPoint(a, b, edge.id, edge.kind === "contains" || edge.kind === "session-project")
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // One signal out from the selection along each relationship, once, when it is chosen.
  if (scene.pulse !== undefined && scene.selected) {
    const t = scene.pulse
    for (const { edge, a, b } of lit) {
      const fromSelected = edge.source === scene.selected
      const start = fromSelected ? a : b
      const end = fromSelected ? b : a
      const c = controlPoint(a, b, edge.id, edge.kind === "contains" || edge.kind === "session-project")
      const u = t
      const x = (1 - u) * (1 - u) * start.x + 2 * (1 - u) * u * c.x + u * u * end.x
      const y = (1 - u) * (1 - u) * start.y + 2 * (1 - u) * u * c.y + u * u * end.y
      ctx.globalAlpha = Math.sin(Math.PI * t) * 0.9
      ctx.fillStyle = palette.link
      ctx.beginPath()
      ctx.arc(x, y, 2.2, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

function nodePath(ctx: CanvasRenderingContext2D, kind: GraphNodeKind, x: number, y: number, r: number) {
  ctx.beginPath()
  switch (kind) {
    case "source": {
      // A rounded square: something with an address.
      const s = r * 0.9
      ctx.roundRect(x - s, y - s, s * 2, s * 2, s * 0.45)
      break
    }
    case "file": {
      // A page with a folded corner.
      const w = r * 0.82
      const h = r * 1.05
      const fold = w * 0.55
      ctx.moveTo(x - w, y - h)
      ctx.lineTo(x + w - fold, y - h)
      ctx.lineTo(x + w, y - h + fold)
      ctx.lineTo(x + w, y + h)
      ctx.lineTo(x - w, y + h)
      ctx.closePath()
      break
    }
    case "note": {
      // A diamond: the person's own mark.
      const s = r * 1.15
      ctx.moveTo(x, y - s)
      ctx.lineTo(x + s, y)
      ctx.lineTo(x, y + s)
      ctx.lineTo(x - s, y)
      ctx.closePath()
      break
    }
    case "session": {
      // A hexagon: a set of tabs held together.
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i + Math.PI / 6
        const px = x + Math.cos(angle) * r
        const py = y + Math.sin(angle) * r
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      break
    }
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2)
  }
}

function drawNodes(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, Projected>) {
  const { palette, now } = scene
  // Quiet nodes first, so the emphasised ones always sit on top.
  const ordered = [...projected.values()].filter((entry) => entry.e >= 0).sort((a, b) => a.e - b.e || (a.node.kind === "project" ? 1 : 0) - (b.node.kind === "project" ? 1 : 0))
  for (const entry of ordered) {
    const { node, x, y, r, e } = entry
    if (node.kind === "project") {
      drawProject(ctx, scene, entry)
      continue
    }
    const color = palette.kinds[node.kind]
    // What the selection connects to is lit from behind — softly, and only then.
    if (scene.selected && e > 0.9 && r > 3) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2)
      glow.addColorStop(0, color)
      glow.addColorStop(1, "transparent")
      ctx.globalAlpha = palette.dark ? 0.22 : 0.14
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(x, y, r * 3.2, 0, Math.PI * 2)
      ctx.fill()
    }
    // A recent thing carries a faint ring: "this changed lately".
    if (now - node.at < RECENT_MS && r > 3) {
      ctx.globalAlpha = 0.28 * e
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(x, y, r + 3.5, 0, Math.PI * 2)
      ctx.stroke()
    }
    nodePath(ctx, node.kind, x, y, r)
    // A cut-out against the ground, so overlapping marks stay separate.
    ctx.globalAlpha = 1
    ctx.lineWidth = 2.5
    ctx.strokeStyle = palette.background
    ctx.globalAlpha = e
    ctx.stroke()
    if (node.unsettled) {
      ctx.globalAlpha = 0.35 * e
      ctx.fillStyle = color
      ctx.fill()
      ctx.globalAlpha = 0.9 * e
      ctx.setLineDash([2, 2])
      ctx.lineWidth = 1.1
      ctx.strokeStyle = color
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      ctx.globalAlpha = (0.35 + 0.65 * e) * (palette.dark ? 0.95 : 1)
      ctx.fillStyle = color
      // A soft bloom, on ink only, where it stays cheap: the graph is the one luminous thing in Hubble.
      if (palette.dark && scene.nodes.length < 900 && r > 3) {
        ctx.save()
        ctx.shadowColor = color
        ctx.shadowBlur = 6 + 6 * e
        ctx.fill()
        ctx.restore()
      } else ctx.fill()
    }
    drawRings(ctx, scene, entry)
  }
  ctx.globalAlpha = 1
}

function drawProject(ctx: CanvasRenderingContext2D, scene: Scene, { node, x, y, r, e }: Projected) {
  const { palette } = scene
  ctx.globalAlpha = 1
  ctx.fillStyle = palette.card
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = (0.25 + 0.45 * e) * (scene.selected === node.id ? 1.4 : 1)
  ctx.strokeStyle = palette.foreground
  ctx.lineWidth = 1.2
  ctx.stroke()
  // An inner orbit: the project as a small system of its own.
  ctx.globalAlpha = 0.18 * e
  ctx.beginPath()
  ctx.arc(x, y, r * 0.62, 0, Math.PI * 2)
  ctx.stroke()
  if (r >= 11) {
    ctx.globalAlpha = 0.4 + 0.6 * e
    ctx.fillStyle = palette.foreground
    ctx.font = `500 ${Math.round(Math.min(18, r * 0.78))}px ${palette.displayFont}`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(initialOf(node.label), x, y + 0.5)
  }
  drawRings(ctx, scene, { node, x, y, r, e })
}

function drawRings(ctx: CanvasRenderingContext2D, scene: Scene, { node, x, y, r }: Projected) {
  const { palette } = scene
  const ring = (radius: number, color: string, width: number, alpha: number, dash: number[] = []) => {
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (scene.matches.has(node.id) && scene.selected !== node.id) ring(r + 4, palette.link, 1.4, 0.9)
  if (scene.hovered === node.id && scene.selected !== node.id) ring(r + 3, palette.foreground, 1.2, 0.55)
  if (scene.selected === node.id) {
    // The one glow in the product: on the thing you chose, nowhere else.
    ctx.save()
    ctx.shadowColor = palette.link
    ctx.shadowBlur = 14
    ring(r + 3.5, palette.link, 2, 0.95)
    ctx.restore()
  }
  if (scene.focused === node.id) ring(r + 7, palette.focus, 1.5, 0.95, [3, 3])
}

function drawVignette(ctx: CanvasRenderingContext2D, viewport: Viewport, palette: Palette) {
  const { width, height } = viewport
  const gradient = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.hypot(width, height) * 0.62)
  gradient.addColorStop(0, "transparent")
  gradient.addColorStop(1, palette.background)
  ctx.globalAlpha = palette.dark ? 0.6 : 0.3
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  ctx.globalAlpha = 1
}

function drawLabels(ctx: CanvasRenderingContext2D, scene: Scene, projected: Map<string, Projected>) {
  const { palette, camera } = scene
  const near = camera.k >= 1.15
  const candidates: { entry: Projected; priority: number }[] = []
  for (const entry of projected.values()) {
    if (entry.e < 0) continue
    const id = entry.node.id
    let priority = -1
    if (scene.selected === id) priority = 100
    else if (scene.hovered === id) priority = 95
    else if (scene.matches.has(id)) priority = 80
    else if (entry.node.kind === "project") priority = 70
    else if (scene.selected && entry.e > 0.9) priority = 60
    // With a selection, only what it connects to is named: the rest stays quiet.
    else if (scene.selected) priority = -1
    else if (near) priority = 10 + Math.min(40, (entry.node.at / 1e12) % 40)
    if (priority >= 0) candidates.push({ entry, priority })
  }
  candidates.sort((a, b) => b.priority - a.priority || b.entry.node.at - a.entry.node.at)

  const placed: { x: number; y: number; w: number; h: number }[] = []
  const overlaps = (box: { x: number; y: number; w: number; h: number }) => placed.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)
  ctx.textBaseline = "top"
  ctx.lineJoin = "round"
  let drawn = 0
  for (const { entry, priority } of candidates) {
    if (drawn > 260) break
    const isProject = entry.node.kind === "project"
    const text = isProject ? entry.node.label : shorten(entry.node.label)
    const size = isProject ? 12.5 : 11.5
    ctx.font = `${isProject ? 500 : 400} ${size}px ${isProject ? palette.displayFont : palette.uiFont}`
    const w = ctx.measureText(text).width
    const h = size + 3
    const box = { x: entry.x - w / 2 - 3, y: entry.y + entry.r + 5, w: w + 6, h }
    if (priority < 95 && overlaps(box)) continue
    placed.push(box)
    drawn += 1
    const alpha = isProject ? 0.55 + 0.45 * entry.e : priority >= 80 ? 1 : 0.4 + 0.5 * entry.e
    ctx.textAlign = "center"
    ctx.globalAlpha = alpha
    ctx.strokeStyle = palette.background
    ctx.lineWidth = 3.5
    ctx.strokeText(text, entry.x, box.y)
    ctx.fillStyle = isProject || priority >= 80 ? palette.foreground : palette.muted
    ctx.fillText(text, entry.x, box.y)
    if (isProject && camera.k > 0.45) {
      const count = entry.node.size ?? 0
      ctx.font = `400 10.5px ${palette.uiFont}`
      ctx.globalAlpha = alpha * 0.8
      ctx.fillStyle = palette.tertiary
      ctx.strokeText(`${count} ${count === 1 ? "item" : "items"}`, entry.x, box.y + h)
      ctx.fillText(`${count} ${count === 1 ? "item" : "items"}`, entry.x, box.y + h)
      placed.push({ x: box.x, y: box.y + h, w: box.w, h: 13 })
    }
  }
  ctx.globalAlpha = 1
}

function initialOf(label: string): string {
  const match = label.trim().match(/[\p{L}\p{N}]/u)
  return (match?.[0] ?? "·").toUpperCase()
}

/** Reads the live theme off the document, so the canvas follows every theme and polarity. */
export function readPalette(element: Element = document.documentElement): Palette {
  const style = getComputedStyle(element)
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  const polarity = v("--polarity", "dark")
  return {
    background: v("--background", "#0b0c0f"),
    foreground: v("--foreground", "#e8eaef"),
    muted: v("--muted-foreground", "#9599a3"),
    tertiary: v("--text-tertiary", "#737781"),
    border: v("--border", "#22252b"),
    card: v("--card", "#121418"),
    link: v("--link", "#8ab4ff"),
    focus: v("--focus", "#8b8f98"),
    kinds: {
      conversation: v("--kind-conversation", "#8ab4ff"),
      source: v("--kind-source", "#6fd3c1"),
      file: v("--kind-file", "#e2b77a"),
      note: v("--kind-note", "#c4a9ff"),
      session: v("--kind-session", "#f29fb3"),
    },
    displayFont: v("--hb-font-display", "system-ui") || "system-ui",
    uiFont: v("--tabdump-font-ui", "system-ui") || "system-ui",
    dark: polarity !== "light",
  }
}

/**
 * The opening: each project's system assembles from its centre outward —
 * items further out arrive a beat later — so the first thing the eye learns
 * is which things belong together. Plays once per visit; never under reduced
 * motion (the caller passes no reveal then).
 */
function applyReveal(projected: Map<string, Projected>, reveal: number) {
  const centres = new Map<string, Projected>()
  for (const entry of projected.values()) if (entry.node.kind === "project") centres.set(entry.node.id.slice(2), entry)
  for (const entry of projected.values()) {
    if (entry.e < 0) continue
    let delay = 0
    if (entry.node.kind !== "project") {
      const centre = entry.node.projectId ? centres.get(entry.node.projectId) : undefined
      delay = centre ? Math.min(0.45, Math.hypot(entry.x - centre.x, entry.y - centre.y) / 900) + 0.1 : 0.35
    }
    const t = Math.max(0, Math.min(1, (reveal - delay) / 0.55))
    const eased = 1 - Math.pow(1 - t, 3)
    entry.r *= 0.4 + 0.6 * eased
    entry.e *= eased
    if (entry.node.kind !== "project" && entry.node.projectId) {
      const centre = centres.get(entry.node.projectId)
      if (centre) {
        // Drawn in from the centre along its own line.
        entry.x = centre.x + (entry.x - centre.x) * (0.75 + 0.25 * eased)
        entry.y = centre.y + (entry.y - centre.y) * (0.75 + 0.25 * eased)
      }
    }
  }
}

/** A faint nebula behind the work: one cool, wide glow centred on the graph, moving with the camera. */
function drawNebula(ctx: CanvasRenderingContext2D, { camera, viewport, palette }: Scene) {
  const cx = -camera.x * camera.k + viewport.width / 2
  const cy = -camera.y * camera.k + viewport.height / 2
  const radius = Math.max(viewport.width, viewport.height) * 0.75
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
  gradient.addColorStop(0, palette.link)
  gradient.addColorStop(1, "transparent")
  ctx.globalAlpha = palette.dark ? 0.06 : 0.025
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, viewport.width, viewport.height)
  ctx.globalAlpha = 1
}
