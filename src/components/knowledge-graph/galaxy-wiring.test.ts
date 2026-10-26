import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { armAngle, armPoint } from "@/lib/knowledge-graph/galaxy"
import { loadKnowledgeGraphState, saveKnowledgeGraphState } from "@/lib/knowledge-graph/persistence"

/**
 * The Graph is the spiral galaxy: projects are clusters strung along two
 * logarithmic arms, drawn as back 2D / WebGL / front 2D layers. This once
 * silently reverted to the earlier particle galaxy because the spiral commit
 * sat on its own branch while main moved on. These tests pin the wiring, so a
 * merge that swaps the renderer, the layout geometry or the layout generation
 * back fails loudly instead of shipping.
 */

const SRC = join(process.cwd(), "src")
const read = (path: string) => readFileSync(join(SRC, path), "utf8")

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, found)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) found.push(full)
  }
  return found
}

describe("the Graph is the spiral galaxy", () => {
  beforeEach(() => window.localStorage.clear())

  it("draws through the back, WebGL and front layers", () => {
    const canvas = read("components/knowledge-graph/knowledge-graph-canvas.tsx")
    expect(canvas).toMatch(/import \{ galaxyField, galaxyNebulae \} from "\.\/galaxy-field"/)
    expect(canvas).toMatch(/import \{ GalaxyGL \} from "\.\/galaxy-gl"/)
    expect(canvas).toMatch(/\bdrawBack\b/)
    expect(canvas).toMatch(/\bdrawFront\b/)
    expect(canvas).toMatch(/GalaxyGL\.create\(/)
  })

  it("has exactly one graph canvas, mounted by the one graph view, which the shell renders", () => {
    const importers = sources(SRC)
      .filter((file) => /from "[^"]*knowledge-graph-canvas"/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file).replace(/\\/g, "/"))
    expect(importers).toEqual(["components/knowledge-graph/knowledge-graph-view.tsx"])
    expect(read("components/app-shell.tsx")).toMatch(/<KnowledgeGraphView\b/)
    const canvases = sources(SRC).filter((file) => /graph-canvas\.tsx$/.test(file))
    expect(canvases.map((file) => relative(SRC, file).replace(/\\/g, "/"))).toEqual(["components/knowledge-graph/knowledge-graph-canvas.tsx"])
  })

  it("lays projects along logarithmic arms, two of them half a turn apart", () => {
    for (const r of [60, 140, 320]) {
      const a = armPoint(0, r)
      const b = armPoint(1, r)
      expect(Math.hypot(a.x, a.y)).toBeCloseTo(r, 3)
      expect(Math.hypot(b.x, b.y)).toBeCloseTo(r, 3)
      expect(a.x).toBeCloseTo(r * Math.cos(armAngle(0, r)), 3)
      expect(a.y).toBeCloseTo(r * Math.sin(armAngle(0, r)), 3)
      expect(armAngle(1, r) - armAngle(0, r)).toBeCloseTo(Math.PI, 5)
    }
    // A spiral winds: further out is further round.
    expect(armAngle(0, 320)).toBeGreaterThan(armAngle(0, 60))
  })

  it("drops positions saved by an earlier layout instead of stranding projects between arms", () => {
    saveKnowledgeGraphState({ version: 1, positions: { p: { x: 10, y: 20 } }, camera: { x: 1, y: 2, k: 1 } }, new Set(["p"]))
    expect(loadKnowledgeGraphState().positions.p).toEqual({ x: 10, y: 20 })

    const key = Object.keys(window.localStorage).find((k) => window.localStorage.getItem(k)?.includes('"layout"'))!
    const stored = JSON.parse(window.localStorage.getItem(key)!)
    window.localStorage.setItem(key, JSON.stringify({ ...stored, layout: stored.layout - 1 }))
    expect(loadKnowledgeGraphState().positions).toEqual({})
  })
})
