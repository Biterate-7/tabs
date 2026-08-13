import { describe, expect, it } from "vitest"
import { orderCategoriesByPresence } from "./hierarchy"
import type { Tab } from "@/lib/tabs/types"

function makeTabs(category: string, count: number): Tab[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${category}-${i}`,
    url: `https://example.com/${category}/${i}`,
    normalizedUrl: `https://example.com/${category}/${i}`,
    domain: "example.com",
    category,
  }))
}

describe("orderCategoriesByPresence", () => {
  it("sorts categories by tab count descending", () => {
    const tabs = [
      ...makeTabs("research", 2),
      ...makeTabs("projects", 8),
      ...makeTabs("news", 1),
    ]
    const result = orderCategoriesByPresence(tabs)
    const nonEmptyIds = result.filter((e) => e.tabs.length > 0).map((e) => e.id)
    expect(nonEmptyIds[0]).toBe("projects")
    expect(nonEmptyIds[1]).toBe("research")
    expect(nonEmptyIds[2]).toBe("news")
  })

  it("always pins other last regardless of count", () => {
    const tabs = [...makeTabs("other", 20), ...makeTabs("research", 1)]
    const result = orderCategoriesByPresence(tabs)
    expect(result[result.length - 1].id).toBe("other")
  })

  it("marks the highest-count categories as large, empty ones as compact", () => {
    const tabs = [...makeTabs("projects", 10), ...makeTabs("research", 9)]
    const result = orderCategoriesByPresence(tabs)
    const byId = Object.fromEntries(result.map((e) => [e.id, e.presence]))
    expect(byId.projects).toBe("large")
    expect(byId.research).toBe("large")
    expect(byId["read-later"]).toBe("compact")
  })

  it("includes every category exactly once, even with no tabs", () => {
    const result = orderCategoriesByPresence([])
    expect(result).toHaveLength(8)
    expect(result.every((e) => e.presence === "compact")).toBe(true)
  })
})
