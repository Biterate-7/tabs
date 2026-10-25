import { armAngle, clusterAxis, hashUnit } from "@/lib/knowledge-graph/galaxy"
import type { RGB } from "./renderer"

/**
 * The galaxy's body: the dust of its core, arms and disc, and the knot of
 * dust each project's cluster sits in.
 *
 * None of these particles is a thing the person keeps — those are drawn
 * over them, one star each (renderer.ts) — but where they lie is the
 * graph's: the arms are the same spirals the layout strings projects along,
 * and every cluster knot is centred on a real project's hub, sized by what
 * it holds. Generated from a fixed seed and the projects' ids, so the same
 * galaxy is always the same dust; nothing is random between frames.
 *
 * The result is one interleaved buffer, ready for the GPU (galaxy-gl.ts) or,
 * where there is no WebGL, for a sparser 2D pass.
 */

/** Floats per particle: x, y, z, size, alpha, r, g, b, phase, speed. */
export const FIELD_STRIDE = 10

export type Field = { data: Float32Array; count: number; extent: number }

export type FieldCluster = { id: string; x: number; y: number; z: number; reach: number; count: number }

export type FieldColors = {
  dark: boolean
  /** The arms' own light near the core, and the brightest points. */
  star: RGB
  /** The heart of the core: a warm white. */
  core: RGB
  /** What each arm's dust opens into toward the rim. */
  arms: readonly [RGB, RGB]
  /** The cool tints a cluster's dust leans toward, chosen by its id. */
  tints: readonly RGB[]
}

export type Nebula = { x: number; y: number; size: number; alpha: number; tint: number }

/** How much dust a full galaxy is made of; `budget` scales it (a 2D fallback draws far fewer). */
const BULGE = 2600
const ARM = 9600
const DISC = 1900
const CLUSTER_MAX = 260
const CLUSTERS_TOTAL = 4200

export function galaxyField(extent: number, clusters: readonly FieldCluster[], colors: FieldColors, budget = 1): Field {
  const R = extent
  const bulge = Math.round(BULGE * budget)
  const arm = Math.round(ARM * budget)
  const disc = Math.round(DISC * budget)
  const wanted = clusters.map((cluster) => Math.min(CLUSTER_MAX, 46 + Math.round(18 * Math.sqrt(cluster.count))))
  const totalWanted = wanted.reduce((a, b) => a + b, 0)
  const share = totalWanted > CLUSTERS_TOTAL ? CLUSTERS_TOTAL / totalWanted : 1
  const perCluster = wanted.map((n) => Math.round(n * share * budget))
  const count = bulge + arm + disc + perCluster.reduce((a, b) => a + b, 0)
  const data = new Float32Array(count * FIELD_STRIDE)
  let at = 0
  const push = (x: number, y: number, z: number, size: number, alpha: number, color: RGB, phase: number, speed: number) => {
    data[at] = x
    data[at + 1] = y
    data[at + 2] = z
    data[at + 3] = size
    data[at + 4] = alpha
    data[at + 5] = color[0] / 255
    data[at + 6] = color[1] / 255
    data[at + 7] = color[2] / 255
    data[at + 8] = phase
    data[at + 9] = speed
    at += FIELD_STRIDE
  }
  const ink = !colors.dark
  // Ink on paper reads heavier than light on ink: the same galaxy, drawn lighter-handed.
  const weight = ink ? 0.55 : 1

  // The core: thousands of points packed into a bulge, white at the heart.
  const rand = random(0x9e3779b1)
  for (let i = 0; i < bulge; i++) {
    const r = Math.abs(gauss(rand)) * R * 0.075 + Math.pow(rand(), 3) * R * 0.05
    const angle = rand() * Math.PI * 2
    const rn = r / R
    const heat = Math.min(1, rn / 0.11)
    const color = mix(colors.core, colors.star, heat)
    const bright = rand() < 0.04
    push(
      Math.cos(angle) * r,
      Math.sin(angle) * r * 0.92,
      gauss(rand) * R * 0.022 * (1 - heat * 0.6),
      bright ? 1.3 + rand() * 0.9 : 0.45 + Math.pow(rand(), 3) * 0.9,
      (bright ? 0.95 : 0.4 + rand() * 0.55) * (1 - heat * 0.45) * weight,
      color,
      rand() * Math.PI * 2,
      0.5 + rand() * 1.5
    )
  }

  // The arms: dense near the core, thinning and cooling toward the rim, each a lane of dust a little wider the further out it runs.
  for (let i = 0; i < arm; i++) {
    const side = i % 2
    const u = rand()
    const r = R * (0.05 + 0.97 * Math.pow(u, 1.3))
    const rn = r / R
    const across = gauss(rand) * (5 + r * 0.075)
    const along = gauss(rand) * r * 0.02
    const angle = armAngle(side, r) + across / r
    const x = Math.cos(angle) * (r + along)
    const y = Math.sin(angle) * (r + along)
    const spark = rand()
    const bright = spark < 0.025
    // Most dust is the arm's own hue opening from starlight; a few motes lean violet or teal, as gas does.
    const lean = rand()
    const base = mix(colors.star, colors.arms[side]!, Math.min(1, rn * 1.6))
    const color = lean < 0.12 ? mix(base, colors.tints[1]!, 0.5) : lean < 0.22 ? mix(base, colors.tints[2]!, 0.5) : base
    push(
      x,
      y,
      gauss(rand) * (2 + R * 0.01 * (1 - rn)),
      bright ? 1.25 + rand() * 1.1 : 0.42 + Math.pow(rand(), 4) * 1.2,
      (bright ? 0.95 : 0.3 + Math.pow(rand(), 1.5) * 0.65) * (1 - rn * 0.5) * weight,
      color,
      rand() * Math.PI * 2,
      0.4 + rand() * 1.6
    )
  }

  // The disc between the arms: faint, everywhere, so the arms sit in something.
  for (let i = 0; i < disc; i++) {
    const r = R * Math.sqrt(rand()) * 1.02
    const angle = rand() * Math.PI * 2
    const rn = r / R
    push(
      Math.cos(angle) * r,
      Math.sin(angle) * r,
      gauss(rand) * 3,
      0.4 + Math.pow(rand(), 5) * 0.9,
      (0.08 + rand() * 0.2) * (1 - rn * 0.5) * weight,
      mix(colors.star, colors.arms[i % 2]!, Math.min(1, rn * 1.3)),
      rand() * Math.PI * 2,
      0.4 + rand() * 1.2
    )
  }

  // Each project's knot: dust gathered round its hub and drawn out along its arm, tinted its own way.
  clusters.forEach((cluster, index) => {
    const n = perCluster[index]!
    if (n === 0) return
    const own = random(Math.floor(hashUnit(cluster.id) * 0xffffffff) || 1)
    const tint = colors.tints[Math.floor(hashUnit(`${cluster.id}/tint`) * colors.tints.length)]!
    const axis = clusterAxis(cluster)
    const cos = Math.cos(axis)
    const sin = Math.sin(axis)
    const spread = Math.max(16, cluster.reach * 0.62)
    for (let i = 0; i < n; i++) {
      const heart = own() < 0.18
      const lx = gauss(own) * spread * (heart ? 0.22 : 1) * 1.14
      const ly = gauss(own) * spread * (heart ? 0.22 : 1) * 0.88
      const d = Math.hypot(lx, ly) / spread
      push(
        cluster.x + lx * cos - ly * sin,
        cluster.y + lx * sin + ly * cos,
        cluster.z + gauss(own) * (3 + d * 5),
        0.45 + Math.pow(own(), 4) * 1.3,
        (heart ? 0.6 + own() * 0.35 : 0.22 + own() * 0.5) * Math.max(0.25, 1 - d * 0.35) * weight,
        mix(colors.star, tint, heart ? 0.2 : 0.5),
        own() * Math.PI * 2,
        0.5 + own() * 1.4
      )
    }
  })

  return { data, count: at / FIELD_STRIDE, extent: R }
}

/**
 * The faint gas along the arms: a few broad patches of indigo, violet and
 * teal light, never a bright gradient. Positions only; the painter draws
 * them as sprites under the dust.
 */
export function galaxyNebulae(extent: number): Nebula[] {
  const places = [0.16, 0.24, 0.33, 0.42, 0.52, 0.64, 0.78]
  return places.flatMap((fraction, i) =>
    [0, 1].map((side) => {
      const key = `nebula${i}/${side}`
      const r = extent * (fraction + (hashUnit(`${key}r`) - 0.5) * 0.05)
      const angle = armAngle(side, r) + (hashUnit(`${key}a`) - 0.5) * 0.24
      return {
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        size: extent * (0.09 + fraction * 0.16 + hashUnit(`${key}s`) * 0.05),
        alpha: (0.11 + hashUnit(`${key}b`) * 0.08) * (1 - fraction * 0.45),
        tint: (i + side * 2) % 3,
      }
    })
  )
}

// ---------------------------------------------------------------- helpers

/** mulberry32: a small, fast, seeded generator — the same seed, the same galaxy. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A standard normal sample (Box–Muller), clipped so no mote lands absurdly far out. */
function gauss(rand: () => number): number {
  const u = Math.max(1e-6, rand())
  const v = rand()
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v)
  return Math.max(-3, Math.min(3, g))
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
