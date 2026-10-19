import { describe, expect, it } from "vitest"
import { buildLaunchPlan, comparableUrl, countDuplicates, launchKey } from "./combine"
import { MAX_SESSION_TABS } from "./types"
import type { TabSession } from "./types"

function session(id: string, urls: string[]): TabSession {
  return {
    id,
    name: id,
    tabs: urls.map((url, index) => ({ id: `${id}-${index}`, url, title: `${id} ${index}` })),
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
  }
}

const essay = session("essay", ["https://docs.google.com/document/d/1/edit", "https://en.wikipedia.org/wiki/WW1", "https://jstor.org/stable/1"])
const physics = session("physics", ["https://phys.example/lab", "https://en.wikipedia.org/wiki/WW1", "https://EN.wikipedia.org:443/wiki/WW1"])

describe("buildLaunchPlan", () => {
  it("combines two sessions in the order they were chosen, each in its saved order", () => {
    const plan = buildLaunchPlan([essay, physics], ["physics", "essay"], new Set(), { dedupe: false })
    expect(plan.tabs.map((tab) => tab.key)).toEqual([
      "physics:physics-0",
      "physics:physics-1",
      "physics:physics-2",
      "essay:essay-0",
      "essay:essay-1",
      "essay:essay-2",
    ])
  })

  it("leaves out unticked tabs", () => {
    const plan = buildLaunchPlan([essay, physics], ["essay", "physics"], new Set([launchKey("essay", "essay-0"), launchKey("physics", "physics-0")]), { dedupe: false })
    expect(plan.tabs.map((tab) => tab.id)).toEqual(["essay-1", "essay-2", "physics-1", "physics-2"])
  })

  it("skips exact duplicate addresses by default, keeping the first", () => {
    const plan = buildLaunchPlan([essay, physics], ["essay", "physics"], new Set(), { dedupe: true })
    expect(plan.tabs.map((tab) => tab.key)).toEqual(["essay:essay-0", "essay:essay-1", "essay:essay-2", "physics:physics-0"])
    expect(plan.duplicatesSkipped).toBe(2)
    expect(countDuplicates([essay, physics], ["essay", "physics"], new Set())).toBe(2)
  })

  it("keeps intentional duplicates when asked", () => {
    const plan = buildLaunchPlan([essay, physics], ["essay", "physics"], new Set(), { dedupe: false })
    expect(plan.tabs).toHaveLength(6)
    expect(plan.duplicatesSkipped).toBe(0)
  })

  it("does not fold together addresses that differ in their query or fragment", () => {
    const docs = session("docs", ["https://app.example/doc?id=1", "https://app.example/doc?id=2", "https://mail.example/#inbox", "https://mail.example/#sent"])
    expect(buildLaunchPlan([docs], ["docs"], new Set(), { dedupe: true }).tabs).toHaveLength(4)
    expect(comparableUrl("HTTPS://Example.com:443")).toBe("https://example.com/")
  })

  it("never changes the sessions it combines", () => {
    const before = JSON.stringify([essay, physics])
    buildLaunchPlan([essay, physics], ["essay", "physics"], new Set([launchKey("essay", "essay-1")]), { dedupe: true })
    expect(JSON.stringify([essay, physics])).toBe(before)
  })

  it("ignores a session deleted while the launcher was open, and a session chosen twice", () => {
    const plan = buildLaunchPlan([essay], ["gone", "essay", "essay"], new Set(), { dedupe: false })
    expect(plan.tabs).toHaveLength(3)
  })

  it("caps one launch and says so", () => {
    const big = session("big", Array.from({ length: MAX_SESSION_TABS + 5 }, (_, i) => `https://example.com/${i}`))
    const plan = buildLaunchPlan([big], ["big"], new Set(), { dedupe: true })
    expect(plan.tabs).toHaveLength(MAX_SESSION_TABS)
    expect(plan.truncated).toBe(true)
  })
})
