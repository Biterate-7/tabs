import { describe, expect, it } from "vitest"
import { computeAttention } from "./attention"
import type { Tab } from "@/lib/tabs/types"

function makeTab(overrides: Partial<Tab>): Tab {
  return {
    id: overrides.id ?? Math.random().toString(),
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    ...overrides,
  }
}

describe("computeAttention", () => {
  it("returns null when there is nothing to flag", () => {
    const tabs = [
      makeTab({ id: "1", category: "research" }),
      makeTab({ id: "2", category: "projects" }),
    ]
    expect(computeAttention(tabs)).toBeNull()
  })

  it("flags duplicates when present, taking priority over uncategorized share", () => {
    const tabs = [
      makeTab({ id: "1", isDuplicate: true }),
      makeTab({ id: "2", isDuplicate: true }),
      makeTab({ id: "3" }),
    ]
    expect(computeAttention(tabs)).toEqual({ kind: "duplicates", count: 2 })
  })

  it("flags a disproportionate other/uncategorized share when no duplicates exist", () => {
    const tabs = [
      makeTab({ id: "1", category: "other" }),
      makeTab({ id: "2", category: "other" }),
      makeTab({ id: "3", category: "other" }),
      makeTab({ id: "4", category: "research" }),
    ]
    const result = computeAttention(tabs)
    expect(result?.kind).toBe("uncategorized")
    expect(result).toMatchObject({ kind: "uncategorized", count: 3 })
  })

  it("does not flag a small other share", () => {
    const tabs = [
      makeTab({ id: "1", category: "other" }),
      makeTab({ id: "2", category: "research" }),
      makeTab({ id: "3", category: "research" }),
      makeTab({ id: "4", category: "research" }),
    ]
    expect(computeAttention(tabs)).toBeNull()
  })
})
