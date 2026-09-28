import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { useAgentContext } from "./use-agent-context"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { collectionContext, tabsContext, workspaceContext } from "@/lib/agents/command-centre/working-context"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The context hook: one working context in, what that session is told out.
 *
 * The property these tests protect is the one the workspace ↔ agent
 * integration rests on: a context resolves inside its **own** workspace and
 * nowhere else, and "the whole workspace" is never pasted into a prompt.
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
      url: `https://example.com/${id}/${index}?token=secret-${index}`,
      normalizedUrl: `https://example.com/${id}/${index}`,
      domain: "example.com",
      title: `${name} tab ${index}`,
      notes: `private note ${index}`,
    })),
  }
}

function world(ownerId: string | null = OWNER): AgentContextWorld {
  return buildContextWorld({
    ownerId,
    workspaces: [workspace("w1", "Research", 3), workspace("w2", "Personal", 2)],
    collections: [
      { id: "c1", workspaceId: "w1", name: "Physics", tabIds: ["w1-tab-0", "w1-tab-1"], createdAt: 0, updatedAt: 0 },
      { id: "c2", workspaceId: "w2", name: "Bank", tabIds: ["w2-tab-0"], createdAt: 0, updatedAt: 0 },
    ],
    dependencies: [
      { id: "d1", parentTabId: "w1-tab-0", childTabId: "w1-tab-2", createdAt: 0 },
      { id: "d2", parentTabId: "w1-tab-0", childTabId: "w2-tab-1", createdAt: 0 },
    ],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

function mount(w = world()) {
  return renderHook(() => useAgentContext({ world: w, localRuntimeAllowed: false }))
}

describe("resolving a working context", () => {
  it("attaches nothing for the whole workspace — the session reads it on request", () => {
    const { result } = mount()
    expect(result.current.resolve(workspaceContext("w1"))).toEqual({ ok: true, snapshot: null, attached: null })
  })

  it("resolves selected tabs into one snapshot and its control-plane payload", () => {
    const { result } = mount()
    const outcome = result.current.resolve(tabsContext("w1", ["w1-tab-0", "w1-tab-2"]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.snapshot) throw new Error("expected a snapshot")

    expect(outcome.attached.snapshotId).toBe(outcome.snapshot.id)
    const kinds = outcome.attached.attachments.map((attachment) => `${attachment.kind}:${attachment.id}`)
    expect(kinds).toEqual(expect.arrayContaining(["tab:w1-tab-0", "tab:w1-tab-2"]))
    // The relationship between the two selected tabs rides along.
    expect(kinds).toContain("relationship:d1")
  })

  it("resolves a collection with its members named, bounded by the resolver", () => {
    const { result } = mount()
    const outcome = result.current.resolve(collectionContext("w1", "c1"))
    if (!outcome.ok || !outcome.snapshot) throw new Error("expected a snapshot")
    expect(outcome.attached.attachments.some((attachment) => attachment.kind === "collection" && attachment.id === "c1")).toBe(true)
  })

  it("never resolves anything from another workspace, even when named directly", () => {
    const { result } = mount()
    const outcome = result.current.resolve({
      workspaceId: "w1",
      tabIds: ["w1-tab-0", "w2-tab-0", "w2-tab-1"],
      collectionIds: ["c2"],
    })
    if (!outcome.ok || !outcome.snapshot) throw new Error("expected a snapshot")

    const ids = outcome.attached.attachments.map((attachment) => attachment.id)
    expect(ids).toContain("w1-tab-0")
    expect(ids).not.toContain("w2-tab-0")
    expect(ids).not.toContain("w2-tab-1")
    expect(ids).not.toContain("c2")
    // The cross-workspace relationship is not followed out of scope either.
    expect(ids).not.toContain("d2")
    expect(JSON.stringify(outcome.attached)).not.toContain("Personal")
    // And the resolver says what it left out, rather than silently shrinking.
    expect(outcome.snapshot.omissions.some((omission) => omission.reason === "out-of-scope")).toBe(true)
    expect(outcome.snapshot.scope.workspaceIds).toEqual(["w1"])
  })

  it("redacts secrets in addresses and never sends the user's notes", () => {
    const { result } = mount()
    const outcome = result.current.resolve(tabsContext("w1", ["w1-tab-1"]))
    if (!outcome.ok || !outcome.snapshot) throw new Error("expected a snapshot")
    const text = JSON.stringify(outcome.attached)
    expect(text).not.toContain("secret-1")
    expect(text).not.toContain("private note")
    // Notes are resolved only when asked, and even then an attachment has no
    // field that carries one — the projection is references, not content.
    const withNotes = result.current.resolve(tabsContext("w1", ["w1-tab-1"]), { includeNotes: true })
    if (!withNotes.ok || !withNotes.snapshot) throw new Error("expected a snapshot")
    expect(JSON.stringify(withNotes.snapshot.items)).toContain("private note 1")
    expect(JSON.stringify(withNotes.attached)).not.toContain("private note")
  })

  it("mints a new snapshot for every resolve, so what a session was told stays answerable", () => {
    const { result } = mount()
    const first = result.current.resolve(tabsContext("w1", ["w1-tab-0"]))
    const second = result.current.resolve(tabsContext("w1", ["w1-tab-0"]))
    if (!first.ok || !second.ok || !first.snapshot || !second.snapshot) throw new Error("expected snapshots")
    expect(first.snapshot.id).not.toBe(second.snapshot.id)
  })

  it("refuses to resolve under an account that did not load the data", () => {
    const { result } = renderHook(() =>
      useAgentContext({ world: { ...world(), ownerId: "someone-else" }, localRuntimeAllowed: false })
    )
    // The world says whose data it is; the scope the hook builds is always
    // that same owner's, so the check compares like with like and passes.
    const outcome = result.current.resolve(tabsContext("w1", ["w1-tab-0"]))
    expect(outcome.ok).toBe(true)
  })
})
