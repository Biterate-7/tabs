import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { useAgentIntelligence } from "./use-agent-intelligence"
import {
  withAgent,
  withArtifact,
  withRun,
  withTabLink,
  withWorkItem,
} from "@/lib/agents/intelligence/__fixtures__/domain"
import { runSpatialId } from "@/lib/agents/spatial/types"
import type { AgentState } from "@/lib/agents/types"

/**
 * The React seam of the intelligence layer.
 *
 * What matters here is not the derivation itself — that is covered by the
 * pure tests under lib/agents/intelligence — but the three things only a
 * hook can get wrong: recomputing when it should not, failing to recompute
 * when it should, and holding state of its own.
 */

/** A run in `w1` with a work item, a file and two tabs. */
function populated(workspaceId = "w1") {
  const base = withAgent()
  const run = withRun(base.state, {
    agentId: base.agentId,
    workspaceId,
    status: "working",
  })

  let state = withWorkItem(run.state, {
    runId: run.runId,
    title: "Implement authentication",
    status: "active",
  }).state
  const file = withArtifact(state, {
    runId: run.runId,
    path: "src/auth.ts",
    role: "edited",
  })
  state = file.state
  state = withTabLink(state, { runId: run.runId, tabId: "t1", role: "context" })
  state = withTabLink(state, { runId: run.runId, tabId: "t2", role: "produced" })

  return { state, runId: run.runId, artifactId: file.artifactId }
}

describe("useAgentIntelligence", () => {
  it("derives the workspace activity for the current workspace", () => {
    const { state, runId } = populated()
    const { result } = renderHook(() =>
      useAgentIntelligence({ state, workspaceId: "w1" })
    )

    expect(result.current.activity.workspaceId).toBe("w1")
    expect(result.current.activity.activeRuns.map((r) => r.runId)).toEqual([runId])
    expect(result.current.activity.activeWorkItems).toHaveLength(1)
  })

  it("reuses the index while the state object is unchanged", () => {
    const { state } = populated()
    const { result, rerender } = renderHook(
      (props: { state: AgentState; workspaceId: string }) => useAgentIntelligence(props),
      { initialProps: { state, workspaceId: "w1" } }
    )

    const first = result.current.index
    rerender({ state, workspaceId: "w1" })

    // Same state object, same index — the whole point of memoising here.
    expect(result.current.index).toBe(first)
  })

  it("rebuilds when the state changes", () => {
    const { state } = populated()
    const { result, rerender } = renderHook(
      (props: { state: AgentState; workspaceId: string }) => useAgentIntelligence(props),
      { initialProps: { state, workspaceId: "w1" } }
    )

    const first = result.current.index

    const base = withAgent()
    const next = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" }).state
    rerender({ state: next, workspaceId: "w1" })

    expect(result.current.index).not.toBe(first)
  })

  it("re-scopes when the workspace changes, without leaking the previous one", () => {
    const { state, runId } = populated("w1")
    const { result, rerender } = renderHook(
      (props: { state: AgentState; workspaceId: string }) => useAgentIntelligence(props),
      { initialProps: { state, workspaceId: "w1" } }
    )

    expect(result.current.activity.activeRuns.map((r) => r.runId)).toEqual([runId])

    rerender({ state, workspaceId: "w2" })
    expect(result.current.activity.activeRuns).toEqual([])
    expect(result.current.activity.lastActivityAt).toBeUndefined()
  })

  it("highlights what a selected run touches", () => {
    const { state, runId, artifactId } = populated()
    const { result } = renderHook(() =>
      useAgentIntelligence({
        state,
        workspaceId: "w1",
        selectedId: runSpatialId(runId),
      })
    )

    expect(result.current.highlighted.tabIds).toEqual(new Set(["t1", "t2"]))
    expect(result.current.highlighted.artifactIds).toEqual(new Set([artifactId]))
    expect(result.current.highlighted.workItemIds.size).toBe(1)
  })

  it("highlights nothing without a selection", () => {
    const { state } = populated()
    const { result } = renderHook(() =>
      useAgentIntelligence({ state, workspaceId: "w1", selectedId: null })
    )

    expect(result.current.highlighted.tabIds.size).toBe(0)
    expect(result.current.highlighted.artifactIds.size).toBe(0)
  })

  it("highlights nothing for a non-run selection", () => {
    const { state, artifactId } = populated()
    const { result } = renderHook(() =>
      useAgentIntelligence({
        state,
        workspaceId: "w1",
        // A file has no single set of things it touched — it is reached BY
        // runs rather than reaching them — so the canvas stays quiet.
        selectedId: `artifact:${artifactId}`,
      })
    )

    expect(result.current.highlighted.tabIds.size).toBe(0)
    expect(result.current.highlighted.workItemIds.size).toBe(0)
  })

  it("does not mutate the state it is given", () => {
    const { state } = populated()
    const snapshot = JSON.parse(JSON.stringify(state))

    renderHook(() => useAgentIntelligence({ state, workspaceId: "w1" }))

    expect(state).toEqual(snapshot)
  })

  it("renders an empty workspace without throwing", () => {
    const base = withAgent()
    const { result } = renderHook(() =>
      useAgentIntelligence({ state: base.state, workspaceId: "w1" })
    )

    expect(result.current.activity.activeRuns).toEqual([])
    expect(result.current.index.runsById.size).toBe(0)
  })
})
