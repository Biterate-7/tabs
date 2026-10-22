import { describe, expect, it } from "vitest"
import { galaxyScene } from "./project-galaxy"
import type { KnowledgeItem } from "@/lib/memory/items"

function item(id: string, type: KnowledgeItem["type"]): KnowledgeItem {
  return { ref: { kind: "source", tabId: id }, id, workspaceId: "w", type, title: id, addedAt: 0, updatedAt: 0, hasText: true, status: "ready", origin: "extension" } as KnowledgeItem
}

describe("galaxyScene", () => {
  const items = [item("a", "conversation"), item("b", "webpage"), item("c", "webpage"), item("d", "note"), item("e", "conversation")]

  it("draws the same galaxy for the same project, and a different one for another", () => {
    expect(galaxyScene(items, "w1")).toEqual(galaxyScene(items, "w1"))
    expect(galaxyScene(items, "w2").dust).not.toEqual(galaxyScene(items, "w1").dust)
  })

  it("puts every item on its kind's orbit, newest brightest", () => {
    const { bodies } = galaxyScene(items, "w")
    expect(bodies.map((body) => body.id)).toEqual(["a", "b", "c", "d", "e"])
    const inner = bodies.filter((body) => body.kind === "conversation" || body.kind === "note")
    const outer = bodies.filter((body) => body.kind === "source")
    expect(new Set(inner.map((body) => body.orbit)).size).toBe(1)
    expect(outer.every((body) => body.orbit > inner[0]!.orbit)).toBe(true)
    expect(bodies[0]!.fresh).toBeGreaterThan(bodies[4]!.fresh)
  })

  it("only joins items that share an orbit", () => {
    const { bodies, links } = galaxyScene(items, "w")
    for (const [a, b] of links) expect(bodies[a]!.orbit).toBe(bodies[b]!.orbit)
  })

  it("caps the stars it draws, and an empty project is an empty orbit", () => {
    const many = Array.from({ length: 80 }, (_, i) => item(`x${i}`, "webpage"))
    expect(galaxyScene(many, "w").bodies).toHaveLength(36)
    const empty = galaxyScene([], "w")
    expect(empty.bodies).toHaveLength(0)
    expect(empty.links).toHaveLength(0)
    expect(empty.dust.length).toBeGreaterThan(0)
  })
})
