import { describe, expect, it } from "vitest"
import { collectionsMatch, restoreWorkspaceCollections } from "./restore"
import type { Collection } from "./types"

/**
 * The exact inverse of an applied change: the workspace's collections put
 * back as they were, only while nothing has changed since.
 */

const c = (id: string, workspaceId: string, name: string, tabIds: string[]): Collection => ({
  id,
  workspaceId,
  name,
  tabIds,
  createdAt: 0,
  updatedAt: 0,
})

const sources = c("c1", "w1", "Sources", ["t1", "t2"])
const personal = c("c2", "w2", "Bank", ["p1"])

describe("restoring a workspace's collections", () => {
  it("removes a collection the change created and returns the tabs it took", () => {
    const before = [sources]
    const after = [c("c1", "w1", "Sources", ["t1"]), c("c9", "w1", "Pricing", ["t2", "t3"])]
    const restored = restoreWorkspaceCollections([personal, ...after], "w1", before, after)!
    expect(restored.collections).toEqual([personal, sources])
    expect(restored.removed).toEqual(["c9"])
    expect(restored.changed).toEqual(["c1"])
  })

  it("reverts a rename", () => {
    const renamed = { ...sources, name: "Primary sources", updatedAt: 5 }
    const restored = restoreWorkspaceCollections([renamed, personal], "w1", [sources], [renamed])!
    expect(restored.collections.find((collection) => collection.id === "c1")!.name).toBe("Sources")
    expect(restored.removed).toEqual([])
  })

  it("never touches another workspace's collections", () => {
    const after = [sources, c("c9", "w1", "New", [])]
    const restored = restoreWorkspaceCollections([personal, ...after], "w1", [sources], after)!
    expect(restored.collections.filter((collection) => collection.workspaceId === "w2")).toEqual([personal])
  })

  it("refuses, changing nothing, once the workspace has moved on", () => {
    const after = [sources, c("c9", "w1", "New", [])]
    const edited = [sources, c("c9", "w1", "New, then renamed by hand", [])]
    const current = [personal, ...edited]
    const snapshot = JSON.stringify(current)
    expect(collectionsMatch(current, "w1", after)).toBe(false)
    expect(restoreWorkspaceCollections(current, "w1", [sources], after)).toBeNull()
    expect(JSON.stringify(current)).toBe(snapshot)
  })

  it("refuses a 'before' that names another workspace's collection", () => {
    expect(restoreWorkspaceCollections([sources], "w1", [personal], [sources])).toBeNull()
  })
})
