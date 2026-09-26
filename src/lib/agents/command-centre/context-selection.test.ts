import { describe, expect, it } from "vitest"
import { isWellFormedRequest } from "@/lib/agents/context/types"
import { resolveContext } from "@/lib/agents/context/resolve"
import {
  EMPTY_SELECTION,
  describeDelta,
  describeOmissionReason,
  diffSnapshots,
  isEmptySelection,
  selectedSources,
  selectionToRequest,
  summarizeAttachment,
  summarizeSnapshot,
  toggleId,
} from "./context-selection"
import { buildContextWorld } from "./world"
import type { ContextSelection } from "./context-selection"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { Workspace } from "@/lib/workspace/types"

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

function world(over: Partial<Parameters<typeof buildContextWorld>[0]> = {}): AgentContextWorld {
  return buildContextWorld({
    ownerId: OWNER,
    workspaces: [workspace("w1", "Research", 3), workspace("w2", "Development", 2)],
    collections: [
      { id: "c1", workspaceId: "w1", name: "Sources", tabIds: ["w1-tab-0"], createdAt: 0, updatedAt: 0 },
    ],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
    ...over,
  })
}

const SCOPE = { ownerId: OWNER, workspaceIds: ["w1", "w2"], projectIds: [] }

function select(over: Partial<ContextSelection> = {}): ContextSelection {
  return { ...EMPTY_SELECTION, ...over }
}

describe("a selection only becomes a request when it is one", () => {
  it("is empty by default", () => {
    expect(isEmptySelection(EMPTY_SELECTION)).toBe(true)
    expect(selectionToRequest(EMPTY_SELECTION, SCOPE)).toBeNull()
  })

  it("refuses to build a request with no sources", () => {
    // `AgentContextRequest` requires a non-empty `sources`, and a request that
    // violated it would be answered `invalid-request` — a failure the user
    // would read as "context is broken" rather than "you picked nothing".
    expect(selectionToRequest(select({ includeNotes: true }), SCOPE)).toBeNull()
  })

  it("refuses when the account has no workspaces to scope to", () => {
    expect(
      selectionToRequest(select({ workspaceIds: ["w1"] }), {
        ownerId: OWNER,
        workspaceIds: [],
        projectIds: [],
      })
    ).toBeNull()
  })

  it("produces a well-formed request the resolver accepts", () => {
    const request = selectionToRequest(select({ workspaceIds: ["w1"] }), SCOPE)
    expect(request).not.toBeNull()
    expect(isWellFormedRequest(request!)).toBe(true)
  })
})

describe("sources follow what was ticked", () => {
  it("asks for a workspace and its tabs together", () => {
    // "Attach this workspace" means the workspace and what is in it — the
    // bounded version of the intent, which is what the resolver documents.
    expect(selectedSources(select({ workspaceIds: ["w1"] }))).toEqual(["workspace", "tab"])
  })

  it("asks for tabs alone when only tabs were named", () => {
    expect(selectedSources(select({ tabIds: ["w1-tab-0"] }))).toEqual(["tab"])
  })

  it("never asks for a source with nothing to resolve", () => {
    const sources = selectedSources(select({ collectionIds: ["c1"] }))
    expect(sources).toEqual(["collection"])
    expect(sources).not.toContain("graph")
    expect(sources).not.toContain("agent_activity")
  })

  it("ignores a graph depth with no centre", () => {
    // A depth with nothing to expand from is a number, not a request.
    expect(selectedSources(select({ graph: { centerTabIds: [], depth: 3 } }))).toEqual([])
  })

  it("includes the graph once a centre exists", () => {
    expect(
      selectedSources(select({ tabIds: ["w1-tab-0"], graph: { centerTabIds: ["w1-tab-0"], depth: 2 } }))
    ).toContain("graph")
  })
})

describe("scope is the account's boundary, not the selection", () => {
  it("keeps every owned workspace in scope even when one is ticked", () => {
    // Narrowing scope to the ticked workspace would drop a collection or tab
    // named directly from another one, with no explanation the user could act
    // on.
    const request = selectionToRequest(select({ workspaceIds: ["w1"] }), SCOPE)
    expect(request!.scope.workspaceIds).toEqual(["w1", "w2"])
    expect(request!.workspaceIds).toEqual(["w1"])
  })

  it("carries the owner through unchanged", () => {
    const request = selectionToRequest(select({ workspaceIds: ["w1"] }), SCOPE)
    expect(request!.scope.ownerId).toBe(OWNER)
  })

  it("resolves against a matching world", () => {
    const request = selectionToRequest(select({ workspaceIds: ["w1"] }), SCOPE)!
    const resolution = resolveContext(request, world())
    expect(resolution.ok).toBe(true)
  })

  it("is refused by the resolver when the owner disagrees", () => {
    const request = selectionToRequest(select({ workspaceIds: ["w1"] }), {
      ...SCOPE,
      ownerId: "somebody-else",
    })!
    const resolution = resolveContext(request, world())
    expect(resolution).toEqual({ ok: false, reason: "owner-mismatch" })
  })
})

describe("notes are opt-in", () => {
  it("is off in the empty selection", () => {
    expect(EMPTY_SELECTION.includeNotes).toBe(false)
  })

  it("passes the choice through to the request", () => {
    const off = selectionToRequest(select({ workspaceIds: ["w1"] }), SCOPE)
    expect(off!.includeNotes).toBe(false)

    const on = selectionToRequest(select({ workspaceIds: ["w1"], includeNotes: true }), SCOPE)
    expect(on!.includeNotes).toBe(true)
  })
})

describe("toggling", () => {
  it("adds and removes", () => {
    expect(toggleId([], "a")).toEqual(["a"])
    expect(toggleId(["a", "b"], "a")).toEqual(["b"])
  })
})

describe("summarizing what was actually resolved", () => {
  function snapshotOf(selection: ContextSelection, w = world()) {
    const request = selectionToRequest(selection, SCOPE)!
    const resolution = resolveContext(request, w)
    if (!resolution.ok) throw new Error(`unexpected: ${resolution.reason}`)
    return resolution.snapshot
  }

  it("counts items from the snapshot, not from the request", () => {
    const snapshot = snapshotOf(select({ workspaceIds: ["w1"] }))
    const rows = summarizeSnapshot(snapshot)

    const workspaces = rows.find((row) => row.sourceType === "workspace")
    const tabs = rows.find((row) => row.sourceType === "tab")
    expect(workspaces?.count).toBe(1)
    expect(tabs?.count).toBe(3)
  })

  it("omits source types that resolved nothing", () => {
    const rows = summarizeSnapshot(snapshotOf(select({ workspaceIds: ["w1"] })))
    expect(rows.some((row) => row.sourceType === "agent_activity")).toBe(false)
  })

  it("reports the graph by its real size rather than its item count", () => {
    const snapshot = snapshotOf(
      select({
        workspaceIds: ["w1"],
        tabIds: ["w1-tab-0"],
        graph: { centerTabIds: ["w1-tab-0"], depth: 1 },
      })
    )
    const graph = summarizeSnapshot(snapshot).find((row) => row.sourceType === "graph")
    expect(graph?.detail).toMatch(/Depth \d+ · \d+ nodes · \d+ edges/)
  })

  it("gives the composer a single line", () => {
    expect(summarizeAttachment(snapshotOf(select({ workspaceIds: ["w1"] })))).toContain("tabs")
  })

  it("counts one of a thing in the singular", () => {
    expect(summarizeAttachment(snapshotOf(select({ workspaceIds: ["w1"] })))).toMatch(/^1 workspace · /)
    const before = snapshotOf(select({ workspaceIds: ["w1"] }))
    const after = snapshotOf(select({ workspaceIds: ["w1", "w2"] }))
    expect(describeDelta(diffSnapshots(before, after))).toMatch(/^\+1 workspace · /)
  })

  it("diffs two snapshots by source type", () => {
    const before = snapshotOf(select({ workspaceIds: ["w1"] }))
    const after = snapshotOf(select({ workspaceIds: ["w1", "w2"] }))

    const deltas = diffSnapshots(before, after)
    expect(deltas.find((delta) => delta.sourceType === "tab")?.change).toBe(2)
    expect(describeDelta(deltas)).toContain("+2 tabs")
  })

  it("reports no delta when nothing moved", () => {
    const snapshot = snapshotOf(select({ workspaceIds: ["w1"] }))
    expect(describeDelta(diffSnapshots(snapshot, snapshot))).toBeNull()
  })
})

describe("omissions are explained", () => {
  it("has a sentence for every reason the resolver can give", () => {
    // Bounded by the resolver's own union: a reason with no sentence would
    // leave the user believing the agent sees more than it does.
    for (const reason of [
      "not-found",
      "out-of-scope",
      "source-not-requested",
      "limit-workspaces",
      "limit-tabs",
      "limit-collections",
      "limit-collection-members",
      "limit-relationships",
      "limit-graph-nodes",
      "limit-graph-edges",
      "limit-projects",
      "limit-agent-activity",
      "limit-items",
      "limit-characters",
      "hosted-runtime",
    ] as const) {
      expect(describeOmissionReason(reason), reason).toBeTruthy()
    }
  })

  it("records a cap as an omission rather than dropping it silently", () => {
    const big = world({ workspaces: [workspace("w1", "Huge", 30)] })
    const request = selectionToRequest(select({ workspaceIds: ["w1"] }), {
      ownerId: OWNER,
      workspaceIds: ["w1"],
      projectIds: [],
    })!

    const resolution = resolveContext({ ...request, limits: { maxTabs: 5 } }, big)
    if (!resolution.ok) throw new Error("unexpected")

    expect(resolution.snapshot.truncated).toBe(true)
    const omission = resolution.snapshot.omissions.find((entry) => entry.sourceType === "tab")
    expect(omission).toBeDefined()
    expect(describeOmissionReason(omission!.reason)).toBeTruthy()
  })
})
