import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GraphAgentPanel, type AgentInspectorSelection } from "./graph-agent-panel"
import type { WorkItemSummary } from "@/lib/agents/spatial/types"

/**
 * Work items in the agent inspector.
 *
 * Same discipline as graph-agent-panel.test.tsx: the inspector is the
 * accessibility fallback for the canvas, so these assert on what a screen
 * reader would reach — accessible names and readable text — rather than on
 * classes, colours or glyphs.
 */

const T0 = 1_700_000_000_000

/** A work item summary, as the scene would supply it. */
function item(over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id: "workitem:wi1",
    workItemId: "wi1",
    runId: "r1",
    runSpatialId: "run:r1",
    title: "Implement authentication",
    status: "active",
    createdAt: T0,
    updatedAt: T0,
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
      tabCount: 0,
      artifactCount: 0,
      workItemCount: 0,
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

function workItemSelection(
  over: Partial<Extract<AgentInspectorSelection, { kind: "workItem" }>> = {}
): Extract<AgentInspectorSelection, { kind: "workItem" }> {
  return {
    kind: "workItem",
    item: item(),
    runTitle: "Implement auth",
    runSpatialId: "run:r1",
    runStatus: "working",
    agentName: "Claude Code",
    provider: "claude-code",
    files: [{ artifactId: "wa1", relativePath: "src/lib/auth.ts", role: "edited" }],
    tabs: [{ tabId: "t1", title: "API reference", role: "context" }],
    events: [{ id: "e1", runId: "r1", timestamp: T0, kind: "activity", summary: "Edited auth.ts" }],
    ...over,
  }
}

function renderPanel(props: Partial<React.ComponentProps<typeof GraphAgentPanel>> = {}) {
  const onSelectResult = vi.fn()
  const onSelectRun = vi.fn()

  const { container } = render(
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

  return { container, onSelectResult, onSelectRun }
}

describe("work items in the run inspector", () => {
  it("lists a run's work items as selectable rows", async () => {
    const user = userEvent.setup()
    const { onSelectResult } = renderPanel({
      selection: runSelection({
        workItems: [
          item(),
          item({
            id: "workitem:wi2",
            workItemId: "wi2",
            title: "Write the docs",
            status: "pending",
          }),
        ],
      }),
    })

    const list = screen.getByRole("list", { name: /work items/i })
    expect(within(list).getAllByRole("button")).toHaveLength(2)

    await user.click(within(list).getByRole("button", { name: /Write the docs/i }))
    expect(onSelectResult).toHaveBeenCalledWith("workitem:wi2")
  })

  it("states the tally in words", () => {
    const { container } = renderPanel({
      selection: runSelection({
        workItems: [
          item({ status: "completed" }),
          item({ id: "workitem:wi2", workItemId: "wi2", title: "Second", status: "active" }),
        ],
      }),
    })

    expect(container.textContent).toContain("1 of 2 done")
  })

  it("excludes cancelled work from the tally", () => {
    const { container } = renderPanel({
      selection: runSelection({
        workItems: [
          item({ status: "completed" }),
          item({ id: "workitem:wi2", workItemId: "wi2", title: "Abandoned", status: "cancelled" }),
        ],
      }),
    })

    // One finished, one abandoned - the plan is done, not half done.
    expect(container.textContent).toContain("1 of 1 done")
  })

  it("shows no WORK section at all for a run with no observed work items", () => {
    const { container } = renderPanel({ selection: runSelection({ workItems: [] }) })

    // An absence, not a message. A run legitimately has no observed plan, and
    // announcing that on every run would be noise.
    expect(screen.queryByRole("list", { name: /work items/i })).toBeNull()
    expect(container.textContent).not.toMatch(/of \d+ done/)
  })

  it("names each row's status in words, never colour or glyph alone", () => {
    renderPanel({
      selection: runSelection({
        workItems: [
          item({ status: "blocked", title: "Blocked task" }),
          item({
            id: "workitem:wi2",
            workItemId: "wi2",
            title: "Pending task",
            status: "pending",
          }),
        ],
      }),
    })

    expect(screen.getByRole("button", { name: /Blocked task .* Blocked/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Pending task .* Pending/ })).toBeTruthy()
  })

  it("omits progress from a row when no provider counted anything", () => {
    renderPanel({ selection: runSelection({ workItems: [item()] }) })

    const button = screen.getByRole("button", { name: /Implement authentication/ })
    // No fabricated ratio anywhere in the accessible name.
    expect(button.getAttribute("aria-label")).not.toMatch(/\d+ of \d+/)
  })

  it("includes explicit progress when there is some", () => {
    renderPanel({
      selection: runSelection({ workItems: [item({ progress: { completed: 2, total: 5 } })] }),
    })

    expect(
      screen.getByRole("button", { name: /Implement authentication .* Active, 2 of 5 done/ })
    ).toBeTruthy()
  })
})

describe("the work item inspector", () => {
  it("shows the item, its status and its summary", () => {
    const { container } = renderPanel({
      selection: workItemSelection({ item: item({ summary: "Sign-in route and tests" }) }),
    })

    const text = container.textContent ?? ""
    expect(text).toContain("Implement authentication")
    expect(text).toContain("Work item")
    expect(text).toContain("Active")
    expect(text).toContain("Sign-in route and tests")
  })

  it("shows the owning run, agent and the run's context", () => {
    const { container } = renderPanel({ selection: workItemSelection() })

    const text = container.textContent ?? ""
    expect(text).toContain("Implement auth")
    expect(text).toContain("Claude Code")
    expect(text).toContain("src/lib/auth.ts")
    expect(text).toContain("API reference")
    expect(text).toContain("Edited auth.ts")
  })

  it("offers the owning run as a control, so selection can be returned", async () => {
    const user = userEvent.setup()
    const { onSelectResult } = renderPanel({ selection: workItemSelection() })

    await user.click(screen.getByRole("button", { name: /Select run Implement auth/i }))
    expect(onSelectResult).toHaveBeenCalledWith("run:r1")
  })

  it("is reachable and operable from the keyboard alone", async () => {
    const user = userEvent.setup()
    const { onSelectResult } = renderPanel({ selection: workItemSelection() })

    const runButton = screen.getByRole("button", { name: /Select run Implement auth/i })
    runButton.focus()
    expect(document.activeElement).toBe(runButton)

    await user.keyboard("{Enter}")
    expect(onSelectResult).toHaveBeenCalledWith("run:r1")
  })

  it("shows timestamps only for the ones that exist", () => {
    const { container } = renderPanel({
      selection: workItemSelection({ item: item({ status: "pending", startedAt: undefined }) }),
    })

    const text = container.textContent ?? ""
    expect(text).toContain("Updated")
    // Never started, never finished - so neither is claimed.
    expect(text).not.toContain("Started")
    expect(text).not.toContain("Completed")
  })

  it("shows a completion time once there is one", () => {
    const { container } = renderPanel({
      selection: workItemSelection({
        item: item({ status: "completed", startedAt: T0, completedAt: T0 + 5_000 }),
      }),
    })

    const text = container.textContent ?? ""
    expect(text).toContain("Started")
    expect(text).toContain("Completed")
  })

  it("renders no progress indicator when there is no evidence for one", () => {
    const { container } = renderPanel({ selection: workItemSelection() })
    expect(container.textContent).not.toMatch(/\d+ of \d+ done/)
  })

  it("survives a missing run without crashing", () => {
    const { container } = renderPanel({
      selection: workItemSelection({
        runTitle: "Untitled run",
        runStatus: undefined,
        agentName: "Agent",
        files: [],
        tabs: [],
        events: [],
      }),
    })

    expect(container.textContent).toContain("Untitled run")
    expect(container.textContent).toContain("Implement authentication")
  })

  it("never renders an absolute path or an identifier", () => {
    const { container } = renderPanel({ selection: workItemSelection() })
    const text = container.textContent ?? ""

    expect(text).not.toContain("C:\\")
    expect(text).not.toContain("workitem:")
    expect(text).not.toContain("wi1")
  })
})

describe("work item search results", () => {
  it("labels a work item result by type, so it does not read as a tab", () => {
    renderPanel({
      searchQuery: "auth",
      searchResults: [
        {
          id: "workitem:wi1",
          kind: "workItem",
          label: "Implement authentication",
          detail: "Active",
          typeLabel: "Work item",
        },
      ],
    })

    const results = screen.getByRole("list", { name: /agent search results/i })
    expect(within(results).getByText(/Work item · Active/)).toBeTruthy()
  })

  it("selects the work item when its result is chosen", async () => {
    const user = userEvent.setup()
    const { onSelectResult } = renderPanel({
      searchQuery: "auth",
      searchResults: [
        {
          id: "workitem:wi1",
          kind: "workItem",
          label: "Implement authentication",
          typeLabel: "Work item",
        },
      ],
    })

    await user.click(screen.getByRole("button", { name: /Implement authentication/ }))
    expect(onSelectResult).toHaveBeenCalledWith("workitem:wi1")
  })
})
