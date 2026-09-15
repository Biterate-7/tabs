import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { namespacedKey, setStorageNamespace } from "@/lib/storage/namespace"
import { recordArtifactWork } from "@/lib/agents/artifacts"
import { createAgent } from "@/lib/agents/registry"
import { createRun, transitionRunStatus } from "@/lib/agents/runs"
import { emptyAgentState } from "@/lib/agents/types"
import {
  AGENT_LAYOUT_STORAGE_KEY,
  loadAgentLayout,
} from "@/lib/agents/spatial/persistence"
import { runSpatialId } from "@/lib/agents/spatial/types"
import { useAgentSpatial } from "./use-agent-spatial"
import type { AgentState } from "@/lib/agents/types"

const T0 = 1_700_000_000_000
const PROJECT = "C:\\repo\\project"
const ADA = "11111111-1111-4111-8111-111111111111"
const GRACE = "22222222-2222-4222-8222-222222222222"

function seed(workspaceIds: string[] = ["wA"]) {
  const agent = createAgent(emptyAgentState(), { provider: "p", name: "Claude Code" }, T0)
  if (!agent.ok) throw new Error("fixture failed")

  let state: AgentState = agent.state
  const runIds: string[] = []
  for (const [index, workspaceId] of workspaceIds.entries()) {
    const run = createRun(
      state,
      { agentId: agent.agent.id, workspaceId, title: `Run ${index}` },
      T0 + index
    )
    if (!run.ok) throw new Error("fixture failed")
    state = run.state
    runIds.push(run.run.id)
  }

  return { state, agentId: agent.agent.id, runIds }
}

beforeEach(() => {
  window.localStorage.clear()
  setStorageNamespace(null)
})

afterEach(() => {
  setStorageNamespace(null)
  window.localStorage.clear()
})

describe("building the layer", () => {
  it("produces nodes and positions for the current workspace", () => {
    const { state, runIds } = seed()
    const { result } = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))

    expect(result.current.scene.nodes).toHaveLength(2)
    expect(result.current.positions.get(runSpatialId(runIds[0]))).toBeDefined()
  })

  it("produces nothing for a workspace with no agent work", () => {
    const { state } = seed()
    const { result } = renderHook(() => useAgentSpatial({ state, workspaceId: "wEmpty", now: T0 + 1 }))

    expect(result.current.scene.nodes).toEqual([])
    expect(result.current.hiddenRunCount).toBe(0)
  })
})

describe("workspace switching", () => {
  it("shows only the runs of the workspace it is asked for", () => {
    const { state, runIds } = seed(["wA", "wB"])

    const { result, rerender } = renderHook(
      ({ workspaceId }) => useAgentSpatial({ state, workspaceId, now: T0 + 10 }),
      { initialProps: { workspaceId: "wA" } }
    )

    expect(result.current.scene.nodes.some((n) => n.id === runSpatialId(runIds[0]))).toBe(true)
    expect(result.current.scene.nodes.some((n) => n.id === runSpatialId(runIds[1]))).toBe(false)

    rerender({ workspaceId: "wB" })
    expect(result.current.scene.nodes.some((n) => n.id === runSpatialId(runIds[1]))).toBe(true)
    expect(result.current.scene.nodes.some((n) => n.id === runSpatialId(runIds[0]))).toBe(false)

    rerender({ workspaceId: "wA" })
    expect(result.current.scene.nodes.some((n) => n.id === runSpatialId(runIds[0]))).toBe(true)
    expect(result.current.scene.nodes.some((n) => n.id === runSpatialId(runIds[1]))).toBe(false)
  })

  it("does not carry a selection into another workspace", () => {
    const { state, runIds } = seed(["wA", "wB"])
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useAgentSpatial({ state, workspaceId, now: T0 + 10 }),
      { initialProps: { workspaceId: "wA" } }
    )

    act(() => result.current.select(runSpatialId(runIds[0])))
    expect(result.current.selectedId).toBe(runSpatialId(runIds[0]))

    rerender({ workspaceId: "wB" })
    expect(result.current.selectedId).toBeNull()

    // ...and restores it on the way back.
    rerender({ workspaceId: "wA" })
    expect(result.current.selectedId).toBe(runSpatialId(runIds[0]))
  })

  it("keeps each workspace's dragged positions apart", async () => {
    const { state, runIds } = seed(["wA", "wB"])
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useAgentSpatial({ state, workspaceId, now: T0 + 10 }),
      { initialProps: { workspaceId: "wA" } }
    )

    act(() => result.current.moveNode(runSpatialId(runIds[0]), { x: 11, y: 22 }))
    expect(result.current.positions.get(runSpatialId(runIds[0]))).toEqual({ x: 11, y: 22 })

    rerender({ workspaceId: "wB" })
    // wB's run has its own computed position, untouched by wA's drag.
    expect(result.current.positions.get(runSpatialId(runIds[1]))).not.toEqual({ x: 11, y: 22 })

    rerender({ workspaceId: "wA" })
    expect(result.current.positions.get(runSpatialId(runIds[0]))).toEqual({ x: 11, y: 22 })
  })
})

describe("layout persistence", () => {
  it("saves a dragged position and restores it on a fresh mount", async () => {
    const { state, runIds } = seed()
    const first = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))

    act(() => first.result.current.moveNode(runSpatialId(runIds[0]), { x: 123, y: 456 }))

    await waitFor(() => {
      expect(loadAgentLayout().positions.wA?.[runSpatialId(runIds[0])]).toEqual({ x: 123, y: 456 })
    })
    first.unmount()

    const second = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))
    expect(second.result.current.positions.get(runSpatialId(runIds[0]))).toEqual({ x: 123, y: 456 })
  })

  it("keeps positions stable when a new run arrives after a reload", async () => {
    const { state, agentId, runIds } = seed()
    const first = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))

    act(() => first.result.current.moveNode(runSpatialId(runIds[0]), { x: 77, y: 88 }))
    await waitFor(() => {
      expect(loadAgentLayout().positions.wA).toBeDefined()
    })
    first.unmount()

    const later = createRun(state, { agentId, workspaceId: "wA", title: "Later" }, T0 + 500)
    if (!later.ok) throw new Error("fixture failed")

    const second = renderHook(() =>
      useAgentSpatial({ state: later.state, workspaceId: "wA", now: T0 + 600 })
    )

    // The dragged node is exactly where it was left, and the new one has
    // appeared alongside it rather than displacing it.
    expect(second.result.current.positions.get(runSpatialId(runIds[0]))).toEqual({ x: 77, y: 88 })
    expect(second.result.current.positions.get(runSpatialId(later.run.id))).toBeDefined()
  })

  it("saves and restores the filter", async () => {
    const { state } = seed()
    const first = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))

    act(() => first.result.current.setFilter("all"))
    await waitFor(() => {
      expect(loadAgentLayout().filter).toBe("all")
    })
    first.unmount()

    const second = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))
    expect(second.result.current.filter).toBe("all")
  })
})

describe("live updates", () => {
  it("reflects a status change without moving anything", () => {
    const { state, runIds } = seed()
    const { result, rerender } = renderHook(
      ({ agentState }: { agentState: AgentState }) =>
        useAgentSpatial({ state: agentState, workspaceId: "wA", now: T0 + 10 }),
      { initialProps: { agentState: state } }
    )

    const before = new Map(result.current.positions)
    const runNode = result.current.scene.nodes.find((n) => n.kind === "run")
    expect(runNode?.kind === "run" && runNode.status).toBe("working")

    const moved = transitionRunStatus(state, runIds[0], "waiting", T0 + 20)
    if (!moved.ok) throw new Error("fixture failed")
    rerender({ agentState: moved.state })

    const after = result.current.scene.nodes.find((n) => n.kind === "run")
    expect(after?.kind === "run" && after.status).toBe("waiting")

    for (const [id, point] of before) {
      expect(result.current.positions.get(id)).toEqual(point)
    }
  })

  it("adds a new run without moving the existing one", () => {
    const { state, agentId, runIds } = seed()
    const { result, rerender } = renderHook(
      ({ agentState }: { agentState: AgentState }) =>
        useAgentSpatial({ state: agentState, workspaceId: "wA", now: T0 + 10 }),
      { initialProps: { agentState: state } }
    )

    const before = result.current.positions.get(runSpatialId(runIds[0]))

    const added = createRun(state, { agentId, workspaceId: "wA", title: "Later" }, T0 + 500)
    if (!added.ok) throw new Error("fixture failed")
    rerender({ agentState: added.state })

    expect(result.current.positions.get(runSpatialId(runIds[0]))).toEqual(before)
    expect(result.current.scene.nodes.filter((n) => n.kind === "run")).toHaveLength(2)
  })

  it("discloses a run's files when it is selected, without moving it", () => {
    const { state, agentId, runIds } = seed()
    const second = createRun(state, { agentId, workspaceId: "wA", title: "Other" }, T0 + 5)
    if (!second.ok) throw new Error("fixture failed")

    const withFile = recordArtifactWork(
      second.state,
      { runId: runIds[0], projectPath: PROJECT, path: "src/a.ts", role: "edited" },
      T0 + 10
    )
    if (!withFile.ok) throw new Error("fixture failed")

    const { result } = renderHook(() =>
      useAgentSpatial({ state: withFile.state, workspaceId: "wA", now: T0 + 20 })
    )

    expect(result.current.scene.nodes.filter((n) => n.kind === "artifact")).toHaveLength(0)
    const before = result.current.positions.get(runSpatialId(runIds[0]))

    act(() => result.current.select(runSpatialId(runIds[0])))

    expect(result.current.scene.nodes.filter((n) => n.kind === "artifact")).toHaveLength(1)
    expect(result.current.positions.get(runSpatialId(runIds[0]))).toEqual(before)
  })
})

describe("account isolation", () => {
  it("keeps one account's agent layout invisible to another", async () => {
    const { state, runIds } = seed()

    setStorageNamespace(ADA)
    const ada = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))
    act(() => ada.result.current.moveNode(runSpatialId(runIds[0]), { x: 500, y: 600 }))
    await waitFor(() => {
      expect(loadAgentLayout().positions.wA).toBeDefined()
    })
    ada.unmount()

    setStorageNamespace(GRACE)
    const grace = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))
    expect(grace.result.current.positions.get(runSpatialId(runIds[0]))).not.toEqual({
      x: 500,
      y: 600,
    })
    grace.unmount()

    setStorageNamespace(ADA)
    const back = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))
    expect(back.result.current.positions.get(runSpatialId(runIds[0]))).toEqual({ x: 500, y: 600 })
  })

  it("writes under the account-prefixed key, not the bare one", async () => {
    const { state, runIds } = seed()

    setStorageNamespace(ADA)
    const { result } = renderHook(() => useAgentSpatial({ state, workspaceId: "wA", now: T0 + 1 }))
    act(() => result.current.moveNode(runSpatialId(runIds[0]), { x: 1, y: 2 }))

    await waitFor(() => {
      expect(window.localStorage.getItem(namespacedKey(AGENT_LAYOUT_STORAGE_KEY, ADA))).toBeTruthy()
    })
    expect(window.localStorage.getItem(AGENT_LAYOUT_STORAGE_KEY)).toBeNull()
  })
})

describe("a large workspace", () => {
  it("builds and places without quadratic blow-up", () => {
    const agent = createAgent(emptyAgentState(), { provider: "p", name: "Claude Code" }, T0)
    if (!agent.ok) throw new Error("fixture failed")

    let state: AgentState = agent.state
    const runIds: string[] = []
    for (let i = 0; i < 100; i += 1) {
      const run = createRun(state, { agentId: agent.agent.id, workspaceId: "wA", title: `Run ${i}` }, T0 + i)
      if (!run.ok) throw new Error("fixture failed")
      state = run.state
      runIds.push(run.run.id)
    }
    for (let i = 0; i < 500; i += 1) {
      const result = recordArtifactWork(
        state,
        {
          runId: runIds[i % runIds.length],
          projectPath: PROJECT,
          path: `src/file-${i}.ts`,
          role: "edited",
        },
        T0 + i
      )
      if (!result.ok) throw new Error("fixture failed")
      state = result.state
    }

    const started = Date.now()
    const { result } = renderHook(() =>
      useAgentSpatial({ state, workspaceId: "wA", now: T0 + 100_000 })
    )
    const elapsed = Date.now() - started

    expect(state.artifacts).toHaveLength(500)
    // 100 runs plus their agent. Artifacts stay collapsed by default, which is
    // the whole point of progressive disclosure on a workspace this size.
    expect(result.current.scene.nodes.filter((n) => n.kind === "run")).toHaveLength(100)
    expect(result.current.scene.nodes.filter((n) => n.kind === "artifact")).toHaveLength(0)
    expect(result.current.positions.size).toBe(101)
    // Generous: this is a smoke check against an accidental O(n²), not a benchmark.
    expect(elapsed).toBeLessThan(2000)
  })

  it("discloses only the selected run's files, however many exist", () => {
    const agent = createAgent(emptyAgentState(), { provider: "p", name: "Claude Code" }, T0)
    if (!agent.ok) throw new Error("fixture failed")

    let state: AgentState = agent.state
    const runs: string[] = []
    for (let i = 0; i < 20; i += 1) {
      const run = createRun(state, { agentId: agent.agent.id, workspaceId: "wA", title: `Run ${i}` }, T0 + i)
      if (!run.ok) throw new Error("fixture failed")
      state = run.state
      runs.push(run.run.id)
    }
    for (let i = 0; i < 200; i += 1) {
      const result = recordArtifactWork(
        state,
        { runId: runs[i % runs.length], projectPath: PROJECT, path: `src/f${i}.ts`, role: "edited" },
        T0 + i
      )
      if (!result.ok) throw new Error("fixture failed")
      state = result.state
    }

    const { result } = renderHook(() =>
      useAgentSpatial({ state, workspaceId: "wA", now: T0 + 100_000 })
    )

    act(() => result.current.select(runSpatialId(runs[0])))

    const artifacts = result.current.scene.nodes.filter((n) => n.kind === "artifact")
    expect(artifacts.length).toBeGreaterThan(0)
    expect(artifacts.length).toBeLessThanOrEqual(10)
  })
})
