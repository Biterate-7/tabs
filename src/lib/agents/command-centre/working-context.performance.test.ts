import { describe, expect, it } from "vitest"
import { buildContextWorld } from "./world"
import { contextPackAttachedContext } from "@/lib/agents/context-pack/attach"
import { sessionContextPack } from "@/lib/agents/context-pack/session"
import { describeWorkingContext, summarizeWorkingContext, tabsContext, withinWorkspace, workspaceContext } from "./working-context"
import { describeFocus } from "@/lib/agents/session-context/focus"
import { buildSessionContextSnapshot } from "@/lib/agents/session-context/snapshot"
import type { Collection } from "@/lib/collections/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Workspace } from "@/lib/workspace/types"
import type { WorkingContext } from "./working-context"

/**
 * Large workspaces: context work stays proportional to what was chosen, not
 * to the size of the workspace, and what reaches an agent stays bounded.
 *
 * Bounds are generous (this machine runs suites under load); the point is
 * the shape — a few milliseconds at 800 tabs, not a scan per keystroke — and
 * that the whole workspace is never serialized into a message.
 */

const TABS = 800

function big(id: string): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    createdAt: 0,
    updatedAt: 0,
    tabs: Array.from({ length: TABS }, (_, index) => ({
      id: `${id}-t${index}`,
      url: `https://site${index % 40}.example/${index}/some/long/path?q=${index}`,
      normalizedUrl: `https://site${index % 40}.example/${index}/some/long/path`,
      domain: `site${index % 40}.example`,
      title: `A reasonably long tab title about topic ${index % 37} and subject ${index}`,
    })),
  }
}

const workspaces = [big("w1"), big("w2")]
const collections: Collection[] = Array.from({ length: 200 }, (_, index) => ({
  id: `c${index}`,
  workspaceId: index % 2 === 0 ? "w1" : "w2",
  name: `Collection ${index}`,
  tabIds: Array.from({ length: 4 }, (_, member) => `${index % 2 === 0 ? "w1" : "w2"}-t${(index * 4 + member) % TABS}`),
  createdAt: 0,
  updatedAt: 0,
}))
const dependencies: TabDependency[] = Array.from({ length: 2000 }, (_, index) => ({
  id: `d${index}`,
  parentTabId: `w1-t${index % TABS}`,
  childTabId: `w1-t${(index * 7 + 1) % TABS}`,
  createdAt: 0,
}))
const liveWorld = { workspaces, collections, dependencies }
const chosen = tabsContext("w1", Array.from({ length: 50 }, (_, index) => `w1-t${index * 13}`))

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)]!
}

function time(run: () => void, rounds = 40): number {
  const samples: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  return p95(samples)
}

describe("context in a large workspace", () => {
  it("describes and scopes a 50-tab context in an 800-tab workspace in milliseconds", () => {
    const describe = time(() => summarizeWorkingContext(describeWorkingContext(chosen, liveWorld)))
    const scope = time(() => withinWorkspace(chosen, liveWorld))
    expect(describe).toBeLessThan(25)
    expect(scope).toBeLessThan(25)
  })

  it("builds what is attached for the chosen tabs, bounded whatever the workspace holds", () => {
    const world = buildContextWorld({ ownerId: null, workspaces, collections, dependencies, manualConnections: [], projects: [], agents: [], runs: [] })
    const attachedFor = (selection: WorkingContext) => {
      const built = sessionContextPack({ world, workspaceId: "w1", selection })
      if (!built.ok) throw new Error(`pack refused: ${built.reason}`)
      return contextPackAttachedContext(built.pack, 0)
    }

    let size = 0
    const build = time(() => {
      const attached = attachedFor(chosen)
      if (!attached) throw new Error("expected an attachment")
      size = JSON.stringify(attached).length
    }, 20)
    expect(build).toBeLessThan(60)
    // Fifty tabs, their relationships and nothing else — never the workspace.
    expect(size).toBeLessThan(64 * 1024)

    // The whole workspace attaches nothing at all: the session reads it on request.
    expect(attachedFor(workspaceContext("w1"))).toBeNull()
  })

  it("reads a session's focus from its bound snapshot without walking the workspace per tab", () => {
    const snapshot = buildSessionContextSnapshot(liveWorld, "w1")!
    const focus = { tabIds: chosen.tabIds, collectionIds: ["c0", "c2", "c4"] }
    const read = time(() => describeFocus(snapshot, focus, { tabs: true }))
    expect(read).toBeLessThan(25)
    expect(JSON.stringify(describeFocus(snapshot, focus, { tabs: true })).length).toBeLessThan(16 * 1024)
  })
})
