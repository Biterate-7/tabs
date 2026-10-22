import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { defaultGraphState, loadGraphState, saveGraphState } from "@/lib/graph/persistence"
import { useTabLinks } from "./use-tab-links"

const ALL = new Set(["a", "b", "c"])

beforeEach(() => {
  window.localStorage.clear()
})

describe("useTabLinks", () => {
  it("reads the links made in the tab map, and writes only links back", () => {
    saveGraphState({ ...defaultGraphState(), positions: { a: { x: 1, y: 2 } }, manualConnections: [{ a: "a", b: "b", createdAt: 1 }] })
    const { result } = renderHook(() => useTabLinks(ALL))
    expect(result.current.links).toEqual([{ a: "a", b: "b", createdAt: 1 }])

    act(() => {
      expect(result.current.add("b", "c")).toBe(true)
    })
    expect(loadGraphState().manualConnections.map((link) => [link.a, link.b])).toEqual([["a", "b"], ["b", "c"]])
    // Everything else kept in that record is left as it was.
    expect(loadGraphState().positions).toEqual({ a: { x: 1, y: 2 } })
  })

  it("refuses a self-link or a duplicate either way round", () => {
    const { result } = renderHook(() => useTabLinks(ALL))
    act(() => {
      expect(result.current.add("a", "a")).toBe(false)
      expect(result.current.add("a", "b")).toBe(true)
    })
    act(() => {
      expect(result.current.add("b", "a")).toBe(false)
    })
    expect(loadGraphState().manualConnections).toHaveLength(1)
  })

  it("lets an Undo held from before a removal put the link back", () => {
    saveGraphState({ ...defaultGraphState(), manualConnections: [{ a: "a", b: "b", createdAt: 1 }] })
    const { result } = renderHook(() => useTabLinks(ALL))
    const before = result.current
    act(() => before.remove("a", "b"))
    expect(result.current.links).toEqual([])
    act(() => {
      expect(before.add("a", "b")).toBe(true)
    })
    expect(result.current.links).toHaveLength(1)
  })

  it("hides a link whose tab is gone without deleting it", () => {
    saveGraphState({ ...defaultGraphState(), manualConnections: [{ a: "a", b: "gone", createdAt: 1 }] })
    const { result } = renderHook(() => useTabLinks(ALL))
    expect(result.current.links).toEqual([])
    expect(loadGraphState().manualConnections).toHaveLength(1)
  })
})
