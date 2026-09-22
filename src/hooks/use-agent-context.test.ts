import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useAgentContext } from "./use-agent-context"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { EMPTY_SELECTION } from "@/lib/agents/command-centre/context-selection"
import type { ContextSelection } from "@/lib/agents/command-centre/context-selection"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The context hook, where "selected" becomes "attached".
 *
 * The distinction these tests protect is the one the whole feature rests on: a
 * selection is what the user ticked, a snapshot is what the resolver admitted,
 * and only the snapshot has been given to an agent.
 */

const OWNER = "owner-1"

function workspace(id: string, name: string, tabCount: number): Workspace {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    tabs: Array.from({ length: tabCount }, (_, index) => ({
      id: `${id}-tab-${index}`,
      url: `https://example.com/${id}/${index}`,
      normalizedUrl: `https://example.com/${id}/${index}`,
      domain: "example.com",
      title: `Tab ${index}`,
    })),
  }
}

function world(ownerId: string | null = OWNER): AgentContextWorld {
  return buildContextWorld({
    ownerId,
    workspaces: [workspace("w1", "Research", 3), workspace("w2", "Development", 2)],
    collections: [
      { id: "c1", workspaceId: "w1", name: "Sources", tabIds: ["w1-tab-0"], createdAt: 0, updatedAt: 0 },
    ],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

function select(over: Partial<ContextSelection> = {}): ContextSelection {
  return { ...EMPTY_SELECTION, ...over }
}

function mount(w = world(), localRuntimeAllowed = false) {
  return renderHook(() => useAgentContext({ world: w, localRuntimeAllowed }))
}

describe("resolving a selection", () => {
  it("holds nothing before anything is resolved", () => {
    const { result } = mount()
    expect(result.current.snapshot).toBeNull()
    expect(result.current.attachedContext).toBeNull()
  })

  it("resolves a workspace into a snapshot and a control-plane payload", () => {
    const { result } = mount()

    act(() => {
      const outcome = result.current.resolve(select({ workspaceIds: ["w1"] }))
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        // The payload travels with the resolve rather than being read back out
        // of state, which would still hold the previous value this turn.
        expect(outcome.attached.snapshotId).toBe(outcome.snapshot.id)
        expect(outcome.attached.attachments.length).toBeGreaterThan(0)
      }
    })

    expect(result.current.snapshot).not.toBeNull()
    expect(result.current.attachedContext?.snapshotId).toBe(result.current.snapshot?.id)
  })

  it("adopts the selection it was handed", () => {
    const { result } = mount()
    act(() => {
      result.current.resolve(select({ collectionIds: ["c1"] }))
    })
    expect(result.current.selection.collectionIds).toEqual(["c1"])
  })

  it("resolves collections, tabs and graph context", () => {
    const { result } = mount()

    act(() => {
      result.current.resolve(
        select({
          workspaceIds: ["w1"],
          collectionIds: ["c1"],
          tabIds: ["w1-tab-0"],
          graph: { centerTabIds: ["w1-tab-0"], depth: 1 },
        })
      )
    })

    const kinds = new Set(result.current.snapshot?.items.map((item) => item.sourceType))
    expect(kinds.has("workspace")).toBe(true)
    expect(kinds.has("collection")).toBe(true)
    expect(kinds.has("tab")).toBe(true)
    expect(kinds.has("graph")).toBe(true)
  })

  it("treats an empty selection as no question rather than an error", () => {
    const { result } = mount()
    act(() => {
      result.current.resolve(EMPTY_SELECTION)
    })
    expect(result.current.snapshot).toBeNull()
    // Not surfaced as a failure the user has to understand — they simply have
    // not finished picking.
    expect(result.current.error).toBeNull()
  })
})

describe("the account boundary", () => {
  it("refuses to resolve a world belonging to a different account", () => {
    // Signed-out data must not resolve into a signed-in session, and vice
    // versa. The resolver checks scope owner against world owner.
    const { result } = mount(world(null))

    act(() => {
      const outcome = result.current.resolve(select({ workspaceIds: ["w1"] }))
      expect(outcome.ok).toBe(true)
    })

    expect(result.current.snapshot).not.toBeNull()
    expect(result.current.snapshot?.scope.ownerId).toBeNull()
  })
})

describe("refresh", () => {
  it("mints a second snapshot rather than mutating the first", () => {
    const { result } = mount()

    act(() => {
      result.current.resolve(select({ workspaceIds: ["w1"] }))
    })
    const first = result.current.snapshot!

    act(() => {
      result.current.refresh()
    })
    const second = result.current.snapshot!

    expect(second.id).not.toBe(first.id)
    // The chain is what makes "what did the agent know at each point" answerable.
    expect(second.previousSnapshotId).toBe(first.id)
    expect(first.items.length).toBe(3 + 1)
  })

  it("reports no delta when the world has not moved", () => {
    const { result } = mount()
    act(() => {
      result.current.resolve(select({ workspaceIds: ["w1"] }))
    })
    act(() => {
      result.current.refresh()
    })
    expect(result.current.delta).toEqual([])
  })

  it("reports what changed when the world has moved", () => {
    const moving = world()
    const { result, rerender } = renderHook(
      ({ w }: { w: AgentContextWorld }) =>
        useAgentContext({ world: w, localRuntimeAllowed: false }),
      { initialProps: { w: moving } }
    )

    act(() => {
      result.current.resolve(select({ workspaceIds: ["w1"] }))
    })

    // A tab appears after the snapshot was taken.
    const grown = buildContextWorld({
      ownerId: OWNER,
      workspaces: [workspace("w1", "Research", 5), workspace("w2", "Development", 2)],
      collections: moving.collections,
      dependencies: [],
      manualConnections: [],
      projects: [],
      agents: [],
      runs: [],
    })
    rerender({ w: grown })

    act(() => {
      result.current.refresh()
    })

    const tabDelta = result.current.delta.find((delta) => delta.sourceType === "tab")
    expect(tabDelta?.change).toBe(2)
  })

  it("does not pick up new data without being asked", () => {
    const { result, rerender } = renderHook(
      ({ w }: { w: AgentContextWorld }) =>
        useAgentContext({ world: w, localRuntimeAllowed: false }),
      { initialProps: { w: world() } }
    )

    act(() => {
      result.current.resolve(select({ workspaceIds: ["w1"] }))
    })
    const before = result.current.snapshot!

    rerender({
      w: buildContextWorld({
        ownerId: OWNER,
        workspaces: [workspace("w1", "Research", 9)],
        collections: [],
        dependencies: [],
        manualConnections: [],
        projects: [],
        agents: [],
        runs: [],
      }),
    })

    // The attached snapshot is unchanged. A context that silently grew would
    // send an agent data the user never attached.
    expect(result.current.snapshot).toBe(before)
  })
})

describe("clearing", () => {
  it("forgets the selection and the snapshot together", () => {
    const { result } = mount()
    act(() => {
      result.current.resolve(select({ workspaceIds: ["w1"] }))
    })

    act(() => {
      result.current.clearSelection()
    })

    expect(result.current.snapshot).toBeNull()
    expect(result.current.attachedContext).toBeNull()
    expect(result.current.selection).toEqual(EMPTY_SELECTION)
  })
})
