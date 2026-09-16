import { describe, expect, it } from "vitest"
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index"
import { getHighlightedObjectIds } from "@/lib/agents/intelligence/relationships"
import { getAgentRunSummary } from "@/lib/agents/intelligence/run-summary"
import { getWorkspaceActivityCards } from "@/lib/agents/intelligence/workspace-activity"
import { toProjectRelative } from "@/lib/agents/paths"
import {
  DEMO_AGENT_INDEX,
  DEMO_AGENT_STATE,
  DEMO_ALL_ARTIFACT_SEEDS,
  DEMO_ARTIFACT_SEEDS,
  DEMO_CONTEXT_TABS,
  DEMO_PRIOR_RUN_ID,
  DEMO_PRODUCED_TABS,
  DEMO_RUN_ID,
  DEMO_WORKSPACE_ID,
  demoClock,
} from "./agent-data"

/**
 * The landing page's agent fixture.
 *
 * These are not tests of the marketing components — they are tests of the one
 * thing a product page can get catastrophically wrong, which is claiming
 * something the product does not do.
 *
 * The page prints "5 files · 3 context tabs", derives its progress bar, and
 * highlights a set of rows, all by running a fixture through the product's own
 * selectors. That only stays honest while the fixture stays *valid*: the domain
 * index silently drops rows that break isolation (a work item whose run is
 * unknown, an artifact belonging to another workspace), so a malformed fixture
 * would not throw — it would quietly render smaller, wrong numbers. These tests
 * are what turn that silence into a failure.
 */

describe("the landing page's agent fixture", () => {
  it("survives the domain index without anything being dropped", () => {
    // The index fail-closes on cross-workspace and orphaned rows. If any of
    // them were dropped, these counts would come back short — which is exactly
    // the failure mode that would otherwise reach the page as a wrong number.
    const index = buildAgentDomainIndex(DEMO_AGENT_STATE)

    const indexedWorkItems = [...index.workItemsByRun.values()].flat()
    expect(indexedWorkItems).toHaveLength(DEMO_AGENT_STATE.workItems.length)

    const indexedArtifactLinks = [...index.artifactLinksByRun.values()].flat()
    expect(indexedArtifactLinks).toHaveLength(DEMO_AGENT_STATE.artifactLinks.length)

    const indexedTabLinks = [...index.tabLinksByRun.values()].flat()
    expect(indexedTabLinks).toHaveLength(DEMO_AGENT_STATE.links.length)

    expect(index.runsByWorkspace.get(DEMO_WORKSPACE_ID)).toHaveLength(
      DEMO_AGENT_STATE.runs.length
    )
  })

  it("keeps every run, work item and artifact inside the one workspace", () => {
    for (const run of DEMO_AGENT_STATE.runs) {
      expect(run.workspaceId).toBe(DEMO_WORKSPACE_ID)
    }
    for (const item of DEMO_AGENT_STATE.workItems) {
      expect(item.workspaceId).toBe(DEMO_WORKSPACE_ID)
      // Denormalised from the run; the index drops any item where these disagree.
      const run = DEMO_AGENT_STATE.runs.find((r) => r.id === item.runId)
      expect(run?.workspaceId).toBe(item.workspaceId)
    }
    for (const artifact of DEMO_AGENT_STATE.artifacts) {
      expect(artifact.workspaceId).toBe(DEMO_WORKSPACE_ID)
    }
  })

  it("never exposes an absolute filesystem path", () => {
    // The whole feature reads a real person's local sessions. A landing page
    // that printed someone's home directory — even a fictional one — would be
    // advertising the opposite of what the product promises.
    for (const artifact of DEMO_AGENT_STATE.artifacts) {
      // Checked with the product's own rule rather than a regex of my own: a
      // path is project-relative exactly when toProjectRelative accepts it and
      // hands back the same string unchanged.
      expect(toProjectRelative(artifact.projectPath, artifact.relativePath)).toEqual({
        ok: true,
        relativePath: artifact.relativePath,
      })
    }
    for (const seed of DEMO_ALL_ARTIFACT_SEEDS) {
      expect(seed.path).not.toMatch(/^[~/]/)
    }
  })

  it("carries no field a provider payload could travel through", () => {
    // The domain has no key for a prompt, a command, a transcript or a tool
    // result — so neither can the fixture. Pinned because the temptation on a
    // marketing page is to add "just one" richer field to a demo object.
    const forbidden = ["prompt", "command", "transcript", "toolResult", "output", "content"]
    const serialized = JSON.stringify(DEMO_AGENT_STATE)
    for (const key of forbidden) {
      expect(serialized).not.toContain(`"${key}":`)
    }
  })

  describe("the numbers the page prints", () => {
    it("matches what the product's own selector derives", () => {
      const summary = getAgentRunSummary(DEMO_AGENT_INDEX, DEMO_RUN_ID)

      expect(summary).toBeDefined()
      // The hero's counts line and the impact section's lede both read these.
      expect(summary?.artifactCount).toBe(DEMO_ARTIFACT_SEEDS.length)
      expect(summary?.contextTabCount).toBe(DEMO_CONTEXT_TABS.length)
      expect(summary?.producedTabCount).toBe(DEMO_PRODUCED_TABS.length)
      // Distinct files, not links: session.ts is both created and edited.
      expect(summary?.artifactCount).toBeLessThan(
        DEMO_AGENT_STATE.artifactLinks.filter((l) => l.runId === DEMO_RUN_ID).length
      )
    })

    it("reports progress only from items that actually finished", () => {
      const summary = getAgentRunSummary(DEMO_AGENT_INDEX, DEMO_RUN_ID)
      const items = DEMO_AGENT_STATE.workItems.filter((i) => i.runId === DEMO_RUN_ID)

      expect(summary?.progress).toEqual({
        completed: items.filter((i) => i.status === "completed").length,
        total: items.filter((i) => i.status !== "cancelled").length,
      })
    })

    it("shows a plan wide enough to contain a blocked item", () => {
      // The blocked item is the point of the work-tracking section: work an
      // agent cannot finish on its own is the thing you most need to see.
      const summary = getAgentRunSummary(DEMO_AGENT_INDEX, DEMO_RUN_ID)
      expect(summary?.workItems.blocked).toBeGreaterThan(0)
      expect(summary?.workItems.active).toBeGreaterThan(0)
      expect(summary?.workItems.pending).toBeGreaterThan(0)
      expect(summary?.workItems.completed).toBeGreaterThan(0)
    })
  })

  describe("the impact demo's highlight", () => {
    it("is a strict subset of the workspace, not all of it", () => {
      // If selecting a run lit up everything, the demo would be making a claim
      // it cannot support. The second run exists to make this assertion true.
      const highlighted = getHighlightedObjectIds(DEMO_AGENT_INDEX, DEMO_RUN_ID)

      expect(highlighted.artifactIds.size).toBeGreaterThan(0)
      expect(highlighted.artifactIds.size).toBeLessThan(DEMO_AGENT_STATE.artifacts.length)
      expect(highlighted.workItemIds.size).toBeLessThan(DEMO_AGENT_STATE.workItems.length)
    })

    it("gives the two runs disjoint files", () => {
      const first = getHighlightedObjectIds(DEMO_AGENT_INDEX, DEMO_RUN_ID)
      const second = getHighlightedObjectIds(DEMO_AGENT_INDEX, DEMO_PRIOR_RUN_ID)

      for (const id of second.artifactIds) {
        expect(first.artifactIds.has(id)).toBe(false)
      }
    })

    it("highlights nothing when the selection is cleared", () => {
      const cleared = getHighlightedObjectIds(DEMO_AGENT_INDEX, null)
      expect(cleared.artifactIds.size).toBe(0)
      expect(cleared.workItemIds.size).toBe(0)
      expect(cleared.tabIds.size).toBe(0)
    })
  })

  it("renders both runs as activity cards, newest first", () => {
    const cards = getWorkspaceActivityCards(DEMO_AGENT_INDEX, DEMO_WORKSPACE_ID)

    expect(cards).toHaveLength(2)
    expect(cards[0].runId).toBe(DEMO_RUN_ID)
    expect(cards[1].runId).toBe(DEMO_PRIOR_RUN_ID)
    // The card label is the run's title, never a provider session id — checked
    // because `externalId` is set on both runs and must not surface.
    expect(cards[0].label).toBe("Implement account sign-in")
    expect(cards.map((c) => c.label).join(" ")).not.toContain("sess-")
  })
})

describe("demoClock", () => {
  it("formats in UTC so the server and the browser agree", () => {
    // A locale-dependent format would be a hydration mismatch on every
    // timeline row for any visitor outside UTC.
    expect(demoClock(Date.UTC(2026, 8, 15, 9, 41))).toBe("09:41")
    expect(demoClock(Date.UTC(2026, 8, 15, 23, 5))).toBe("23:05")
    expect(demoClock(Date.UTC(2026, 8, 15, 0, 0))).toBe("00:00")
  })

  it("is stable regardless of the process timezone", () => {
    const before = demoClock(Date.UTC(2026, 8, 15, 9, 41))
    const original = process.env.TZ
    try {
      process.env.TZ = "Asia/Kolkata"
      expect(demoClock(Date.UTC(2026, 8, 15, 9, 41))).toBe(before)
    } finally {
      process.env.TZ = original
    }
  })
})
