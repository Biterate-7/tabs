import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GraphAgentPanel, type AgentInspectorSelection } from "./graph-agent-panel"
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index"
import { buildInspectorSelection } from "@/lib/agents/spatial/inspector"
import { buildAgentSpatialScene } from "@/lib/agents/spatial/scene"
import { runSpatialId } from "@/lib/agents/spatial/types"
import {
  T0,
  withAgent,
  withArtifact,
  withRun,
  withTabLink,
  withWorkItem,
} from "@/lib/agents/intelligence/__fixtures__/domain"
import type { AgentRunSummary } from "@/lib/agents/intelligence/types"
import type { AgentState } from "@/lib/agents/types"

/**
 * Phase 16's derived summary in the inspector.
 *
 * Same discipline as the other panel suites: the inspector is the
 * accessibility fallback for the canvas, so these assert on the text a
 * screen reader would reach, never on classes, colours or glyphs.
 *
 * Both halves are covered — the wiring that puts a summary on the selection,
 * and the rendering that turns it into words.
 */

function summary(over: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    runId: "r1",
    agentId: "a1",
    status: "working",
    workItems: { total: 4, pending: 1, active: 1, blocked: 0, completed: 2, cancelled: 0 },
    progress: { completed: 2, total: 4 },
    artifactCount: 7,
    contextTabCount: 3,
    producedTabCount: 1,
    lastActivityAt: T0,
    ...over,
  }
}

function runSelection(
  over: Partial<Extract<AgentInspectorSelection, { kind: "run" }>> = {}
): Extract<AgentInspectorSelection, { kind: "run" }> {
  return {
    kind: "run",
    node: {
      kind: "run",
      id: "run:r1",
      runId: "r1",
      agentId: "a1",
      label: "Implement auth",
      provider: "claude-code",
      status: "working",
      tabCount: 4,
      artifactCount: 7,
      workItemCount: 4,
      updatedAt: T0,
      createdAt: T0,
    },
    agentName: "Claude Code",
    files: [],
    tabs: [],
    events: [],
    workItems: [],
    startedAt: T0,
    ...over,
  }
}

function renderPanel(props: Partial<React.ComponentProps<typeof GraphAgentPanel>> = {}) {
  const onSelectResult = vi.fn()
  const onSelectRun = vi.fn()

  render(
    <GraphAgentPanel
      available
      filter="active"
      onFilterChange={vi.fn()}
      selection={null}
      hiddenRunCount={0}
      hasAnyAgentData
      hasVisibleRuns
      searchQuery=""
      searchResults={[]}
      onSelectResult={onSelectResult}
      onSelectRun={onSelectRun}
      {...props}
    />
  )

  return { onSelectResult, onSelectRun }
}

describe("the derived summary in the run inspector", () => {
  it("states progress as a count of real work items", () => {
    renderPanel({ selection: runSelection({ summary: summary() }) })
    expect(screen.getByText("2 / 4 complete")).toBeTruthy()
  })

  it("breaks the work down by status, in words", () => {
    renderPanel({
      selection: runSelection({
        summary: summary({
          workItems: { total: 5, pending: 1, active: 1, blocked: 1, completed: 1, cancelled: 1 },
          progress: { completed: 1, total: 4 },
        }),
      }),
    })

    const breakdown = screen.getByText(/1 blocked/)
    expect(breakdown.textContent).toContain("1 blocked")
    expect(breakdown.textContent).toContain("1 active")
    expect(breakdown.textContent).toContain("1 pending")
    expect(breakdown.textContent).toContain("1 completed")
    expect(breakdown.textContent).toContain("1 cancelled")
  })

  it("splits tabs by role rather than reporting one number", () => {
    renderPanel({ selection: runSelection({ summary: summary() }) })

    const reach = screen.getByText(/7 files/)
    expect(reach.textContent).toContain("3 context")
    expect(reach.textContent).toContain("1 produced")
  })

  it("calls blocked work out in words, never by colour alone", () => {
    renderPanel({
      selection: runSelection({
        summary: summary({
          workItems: { total: 3, pending: 0, active: 1, blocked: 1, completed: 1, cancelled: 0 },
        }),
      }),
    })

    // A sentence, readable without seeing a glyph or a hue.
    expect(screen.getByText(/1 work item is blocked/)).toBeTruthy()
  })

  it("pluralises the blocked callout", () => {
    renderPanel({
      selection: runSelection({
        summary: summary({
          workItems: { total: 4, pending: 0, active: 1, blocked: 2, completed: 1, cancelled: 0 },
        }),
      }),
    })

    expect(screen.getByText(/2 work items are blocked/)).toBeTruthy()
  })

  it("says nothing about blocked work when none is blocked", () => {
    renderPanel({ selection: runSelection({ summary: summary() }) })
    expect(screen.queryByText(/blocked/i)).toBeNull()
  })

  it("omits counts that are zero rather than reporting them", () => {
    renderPanel({
      selection: runSelection({
        summary: summary({
          workItems: { total: 1, pending: 0, active: 1, blocked: 0, completed: 0, cancelled: 0 },
          progress: { completed: 0, total: 1 },
          artifactCount: 0,
          contextTabCount: 0,
          producedTabCount: 0,
        }),
      }),
    })

    // "0 files" reads as a measurement; the honest reading is that there are
    // none to mention.
    expect(screen.queryByText(/0 files/)).toBeNull()
    expect(screen.queryByText(/0 context/)).toBeNull()
    expect(screen.queryByText(/0 completed/)).toBeNull()
  })

  it("renders the Phase 15 inspector unchanged when there is no summary", () => {
    renderPanel({ selection: runSelection() })

    expect(screen.queryByText("SUMMARY")).toBeNull()
    // The run itself still renders.
    expect(screen.getByText("Implement auth")).toBeTruthy()
  })

  it("keeps every control reachable by keyboard", async () => {
    const user = userEvent.setup()
    const { onSelectRun } = renderPanel({
      selection: {
        kind: "agent",
        node: {
          kind: "agent",
          id: "agent:a1",
          agentId: "a1",
          label: "Claude Code",
          provider: "claude-code",
          activeRunCount: 1,
          totalRunCount: 1,
          status: "working",
          createdAt: T0,
        },
        recentRuns: [{ runId: "r1", title: "Implement auth", status: "working" }],
      },
    })

    const control = screen.getByRole("button", { name: /Implement auth/ })
    control.focus()
    await user.keyboard("{Enter}")

    expect(onSelectRun).toHaveBeenCalledWith("r1")
  })
})

describe("the inspector is wired to the intelligence index", () => {
  /** One run with two completed items, one blocked, a file and two tabs. */
  function populated(): { state: AgentState; runId: string } {
    const base = withAgent()
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "working",
      title: "Auth work",
    })

    let state = withWorkItem(
      run.state,
      { runId: run.runId, title: "Implement authentication", status: "completed" },
      T0
    ).state
    state = withWorkItem(
      state,
      { runId: run.runId, title: "Wire the store", status: "completed" },
      T0 + 1_000
    ).state
    state = withWorkItem(
      state,
      { runId: run.runId, title: "Investigate failure", status: "blocked" },
      T0 + 2_000
    ).state
    state = withArtifact(state, { runId: run.runId, path: "src/auth.ts", role: "edited" }).state
    state = withTabLink(state, { runId: run.runId, tabId: "t1", role: "context" })
    state = withTabLink(state, { runId: run.runId, tabId: "t2", role: "produced" })

    return { state, runId: run.runId }
  }

  function selectionFor(state: AgentState, runId: string, withIndex: boolean) {
    const scene = buildAgentSpatialScene(state, {
      agents: state.agents,
      runs: state.runs,
      artifacts: state.artifacts,
      workspaceId: "w1",
      filter: "all",
      selectedId: runSpatialId(runId),
      now: T0,
    })

    return buildInspectorSelection({
      state,
      scene,
      selectedId: runSpatialId(runId),
      tabTitles: new Map([
        ["t1", "API reference"],
        ["t2", "App"],
      ]),
      ...(withIndex ? { intelligence: buildAgentDomainIndex(state) } : {}),
    })
  }

  it("attaches a derived summary that matches the underlying data", () => {
    const { state, runId } = populated()
    const selection = selectionFor(state, runId, true)

    expect(selection?.kind).toBe("run")
    const runSummary = (selection as Extract<AgentInspectorSelection, { kind: "run" }>).summary
    expect(runSummary).toBeDefined()
    expect(runSummary!.workItems).toEqual({
      total: 3,
      pending: 0,
      active: 0,
      blocked: 1,
      completed: 2,
      cancelled: 0,
    })
    expect(runSummary!.progress).toEqual({ completed: 2, total: 3 })
    expect(runSummary!.artifactCount).toBe(1)
    expect(runSummary!.contextTabCount).toBe(1)
    expect(runSummary!.producedTabCount).toBe(1)
  })

  it("renders that summary end to end", () => {
    const { state, runId } = populated()
    renderPanel({ selection: selectionFor(state, runId, true) })

    expect(screen.getByText("2 / 3 complete")).toBeTruthy()
    expect(screen.getByText(/1 work item is blocked/)).toBeTruthy()
  })

  it("omits the summary entirely when no index is supplied", () => {
    const { state, runId } = populated()
    const selection = selectionFor(state, runId, false)

    expect((selection as Extract<AgentInspectorSelection, { kind: "run" }>).summary).toBeUndefined()
  })

  it("gives a selected work item its owning run's summary", () => {
    const { state, runId } = populated()
    const scene = buildAgentSpatialScene(state, {
      agents: state.agents,
      runs: state.runs,
      artifacts: state.artifacts,
      workspaceId: "w1",
      filter: "all",
      selectedId: runSpatialId(runId),
      now: T0,
    })

    const item = scene.workItems[0]
    const selection = buildInspectorSelection({
      state,
      scene,
      selectedId: item.id,
      tabTitles: new Map(),
      intelligence: buildAgentDomainIndex(state),
    })

    expect(selection?.kind).toBe("workItem")
    const runSummary = (selection as Extract<AgentInspectorSelection, { kind: "workItem" }>)
      .runSummary
    expect(runSummary?.progress).toEqual({ completed: 2, total: 3 })
  })

  it("exposes no absolute path or session id through the inspector", () => {
    const { state, runId } = populated()
    const selection = selectionFor(state, runId, true)
    const runSummary = (selection as Extract<AgentInspectorSelection, { kind: "run" }>).summary

    expect(JSON.stringify(runSummary)).not.toContain("projects/demo")
    expect(JSON.stringify(runSummary)).not.toContain("externalId")
  })
})
