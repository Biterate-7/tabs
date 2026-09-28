import { beforeEach, describe, expect, it } from "vitest"
import { act, render, renderHook } from "@testing-library/react"
import { useState } from "react"
import { useCollectionStore } from "./use-collection-store"
import { loadCollectionState } from "@/lib/collections/persistence"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The collection store puts a change on disk before the next surface reads it.
 *
 * Hubble mounts one surface at a time and each loads collections from storage
 * when it mounts. An agent's approved change is applied by the Command Centre,
 * and the natural next step is "View" — which renders the workspace view
 * (reading storage) before the Command Centre unmounts. A debounced save that
 * had not fired yet was lost there, and the collection the user had just
 * approved was missing from the workspace.
 */

const WORKSPACES: Workspace[] = [
  {
    id: "w1",
    name: "Research",
    createdAt: 0,
    updatedAt: 0,
    tabs: [
      { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", title: "A" },
      { id: "t2", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example", title: "B" },
    ],
  },
]

beforeEach(() => window.localStorage.clear())

describe("persisting collections", () => {
  it("writes a change in the same commit, with no timer to wait out", () => {
    const { result } = renderHook(() => useCollectionStore(WORKSPACES))
    act(() => {
      result.current.createCollection("w1", "Physics Sources", ["t1", "t2"])
    })
    expect(loadCollectionState().collections.map((collection) => collection.name)).toEqual(["Physics Sources"])
  })

  it("undoes a change exactly, and only while nothing has been changed since", () => {
    const { result } = renderHook(() => useCollectionStore(WORKSPACES))
    act(() => {
      result.current.createCollection("w1", "Mine", ["t1"])
    })
    const before = result.current.collections
    let batch: ReturnType<typeof result.current.applyBatch> | undefined
    act(() => {
      batch = result.current.applyBatch("w1", [{ kind: "create_collection", name: "Agent made", tabIds: ["t1", "t2"] }])
    })
    if (!batch?.ok) throw new Error("expected the batch to apply")
    const after = batch.collections
    // The agent's collection took t1 out of "Mine" — an undo must put it back.
    expect(result.current.collections.find((c) => c.name === "Mine")?.tabIds).toEqual([])

    act(() => {
      expect(result.current.restoreCollections("w1", before, after)).toBe(true)
    })
    expect(result.current.collections).toEqual(before)
    expect(loadCollectionState().collections.map((c) => c.name)).toEqual(["Mine"])

    // Applied again, then edited by hand: the undo would discard that edit, so it is refused.
    let again: ReturnType<typeof result.current.applyBatch> | undefined
    act(() => {
      again = result.current.applyBatch("w1", [{ kind: "create_collection", name: "Agent made", tabIds: ["t2"] }])
    })
    if (!again?.ok) throw new Error("expected the batch to apply")
    const madeId = again.created[0]!
    act(() => result.current.renameCollection(madeId, "Renamed by me"))
    act(() => {
      expect(result.current.restoreCollections("w1", before, again!.ok ? again!.collections : [])).toBe(false)
    })
    expect(result.current.collections.map((c) => c.name)).toContain("Renamed by me")
  })

  it("hands a change to the next surface even when the swap is immediate", () => {
    let apply: (() => void) | undefined

    function CommandCentre() {
      const store = useCollectionStore(WORKSPACES)
      apply = () => {
        store.applyBatch("w1", [{ kind: "create_collection", name: "Agent made", tabIds: ["t1"] }])
      }
      return null
    }
    let seenByWorkspace: string[] = []
    function Workspace() {
      const store = useCollectionStore(WORKSPACES)
      seenByWorkspace = store.collections.map((collection) => collection.name)
      return null
    }
    let show: (view: "cc" | "ws") => void = () => {}
    function Shell() {
      const [view, setView] = useState<"cc" | "ws">("cc")
      show = setView
      return view === "cc" ? <CommandCentre /> : <Workspace />
    }

    render(<Shell />)
    act(() => apply?.())
    // "View": straight to the workspace, nothing in between.
    act(() => show("ws"))
    expect(seenByWorkspace).toEqual(["Agent made"])
  })
})
