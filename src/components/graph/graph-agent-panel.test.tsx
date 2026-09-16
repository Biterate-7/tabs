import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GraphAgentPanel, type AgentInspectorSelection } from "./graph-agent-panel"
import type { AgentSearchResult } from "@/lib/agents/spatial/search"

/**
 * The inspector is the accessibility fallback for the canvas, so these assert
 * on what a screen reader would reach — accessible names and readable text —
 * rather than on classes or colours.
 */

const T0 = 1_700_000_000_000

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
      label: "Implement authentication",
      provider: "claude-code",
      status: "working",
      activity: "Edited sidebar.tsx",
      tabCount: 1,
      artifactCount: 2,
      workItemCount: 0,
      updatedAt: T0,
      createdAt: T0,
    },
    agentName: "Claude Code",
    files: [
      { artifactId: "wa1", relativePath: "src/lib/agents/artifacts.ts", role: "edited" },
      { artifactId: "wa2", relativePath: "src/lib/agents/paths.ts", role: "inspected" },
    ],
    tabs: [{ tabId: "t1", title: "API reference", role: "context" }],
    events: [
      { id: "e1", runId: "r1", timestamp: T0, kind: "activity", summary: "Edited artifacts.ts" },
      { id: "e2", runId: "r1", timestamp: T0 - 1, kind: "activity", summary: "Ran the tests" },
    ],
    workItems: [],
    startedAt: T0 - 10_000,
    ...over,
  }
}

function renderPanel(props: Partial<React.ComponentProps<typeof GraphAgentPanel>> = {}) {
  const onFilterChange = vi.fn()
  const onSelectResult = vi.fn()
  const onSelectRun = vi.fn()

  render(
    <GraphAgentPanel
      available
      filter="active"
      onFilterChange={onFilterChange}
      // The situation these tests describe: one provider connected, so the
      // panel is past "nothing is connected" and into the states below.
      // Phase 17's connector-specific behaviour lives in
      // graph-agent-panel-connectors.test.tsx.
      connectors={[
        {
          provider: "claude-code",
          displayName: "Claude Code",
          statusLabel: "Connected",
          connected: true,
        },
      ]}
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

  return { onFilterChange, onSelectResult, onSelectRun }
}

describe("filters", () => {
  it("offers every filter as a labelled control", () => {
    renderPanel()
    const group = screen.getByRole("group", { name: /filter agent runs/i })

    for (const label of ["All", "Active", "Waiting", "Needs attention", "Finished"]) {
      expect(within(group).getByRole("button", { name: label })).toBeTruthy()
    }
  })

  it("marks the active filter with aria-pressed, not colour alone", () => {
    renderPanel({ filter: "active" })

    expect(screen.getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false")
  })

  it("reports a filter change without touching anything else", async () => {
    const user = userEvent.setup()
    const { onFilterChange } = renderPanel()

    await user.click(screen.getByRole("button", { name: "Finished" }))

    expect(onFilterChange).toHaveBeenCalledWith("finished")
  })

  it("is reachable by keyboard", async () => {
    const user = userEvent.setup()
    const { onFilterChange } = renderPanel()

    await user.tab()
    await user.keyboard("{Enter}")

    expect(onFilterChange).toHaveBeenCalled()
  })
})

describe("empty and unavailable states", () => {
  it("says there is no agent activity when the workspace has none", () => {
    renderPanel({ hasAnyAgentData: false, hasVisibleRuns: false })

    expect(screen.getByText(/no agent activity in this workspace/i)).toBeTruthy()
  })

  it("distinguishes unavailable from empty", () => {
    renderPanel({ available: false, hasAnyAgentData: false, hasVisibleRuns: false })

    // Provider-neutral since Phase 17: a workspace may have several connected
    // agents, and naming one of them here would be wrong for the others.
    expect(screen.getByText(/agent not observable/i)).toBeTruthy()
    expect(screen.queryByText(/no agent activity in this workspace/i)).toBeNull()
  })

  it("says historical activity is still shown when unavailable but data exists", () => {
    renderPanel({ available: false, hasAnyAgentData: true, hasVisibleRuns: true })

    expect(screen.getByText(/agent not observable/i)).toBeTruthy()
    expect(screen.getByText(/previously observed agent activity/i)).toBeTruthy()
  })

  it("does not claim a connection mechanism that does not exist", () => {
    renderPanel({ available: false, hasAnyAgentData: false, hasVisibleRuns: false })

    expect(screen.queryByText(/connect claude code/i)).toBeNull()
  })

  it("explains an empty filter result and how many runs are hidden", () => {
    renderPanel({ hasVisibleRuns: false, hiddenRunCount: 3 })

    expect(screen.getByText(/no runs match this filter/i)).toBeTruthy()
    expect(screen.getByText(/3 runs hidden/i)).toBeTruthy()
  })

  it("prompts for a selection when runs are visible but none is selected", () => {
    renderPanel()

    expect(screen.getByText(/select an agent, a run, or a file/i)).toBeTruthy()
  })
})

describe("the run inspector", () => {
  it("gives the run a readable name, agent and status as text", () => {
    renderPanel({ selection: runSelection() })

    expect(screen.getByText("Implement authentication")).toBeTruthy()
    // Two matches since Phase 17: the connector strip names the provider too.
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0)
    // Status as words, not only a colour.
    expect(screen.getAllByText("Working").some((el) => el.tagName === "SPAN")).toBe(true)
  })

  it("shows the safe activity line", () => {
    renderPanel({ selection: runSelection() })

    expect(screen.getByText("Edited sidebar.tsx")).toBeTruthy()
  })

  it("lists files grouped by role, as project-relative paths", () => {
    renderPanel({ selection: runSelection() })

    expect(screen.getByText("src/lib/agents/artifacts.ts")).toBeTruthy()
    expect(screen.getByText("src/lib/agents/paths.ts")).toBeTruthy()
    expect(screen.getByText("edited")).toBeTruthy()
    expect(screen.getByText("inspected")).toBeTruthy()
  })

  it("keeps tabs visibly separate from files", () => {
    renderPanel({ selection: runSelection() })

    expect(screen.getByText("FILES")).toBeTruthy()
    expect(screen.getByText("TABS")).toBeTruthy()
    expect(screen.getByText("API reference")).toBeTruthy()
  })

  it("lists recent activity", () => {
    renderPanel({ selection: runSelection() })

    expect(screen.getByText("RECENT ACTIVITY")).toBeTruthy()
    expect(screen.getByText("Edited artifacts.ts")).toBeTruthy()
    expect(screen.getByText("Ran the tests")).toBeTruthy()
  })

  it("summarises counts, omitting the ones that are zero", () => {
    renderPanel({ selection: runSelection({ tabs: [] }) })

    // Two files and two events, but no tabs — so "tabs" is not mentioned at
    // all rather than reported as zero.
    const summary = screen.getByText(/2 files/i)
    expect(summary).toBeTruthy()
    expect(summary.textContent).not.toMatch(/0 tab/i)
  })

  it("says so plainly when a run has recorded no work", () => {
    renderPanel({ selection: runSelection({ files: [], tabs: [], events: [] }) })

    expect(screen.getByText(/no recorded work yet/i)).toBeTruthy()
  })

  it("shows every status as words", () => {
    for (const [status, label] of [
      ["waiting", "Waiting"],
      ["completed", "Completed"],
      ["failed", "Failed"],
      ["blocked", "Blocked"],
      ["cancelled", "Cancelled"],
    ] as const) {
      const { unmount } = render(
        <GraphAgentPanel
          available
          filter="all"
          onFilterChange={vi.fn()}
          selection={runSelection({ node: { ...runSelection().node, status } as never })}
          hiddenRunCount={0}
          hasAnyAgentData
          hasVisibleRuns
          searchQuery=""
          searchResults={[]}
          onSelectResult={vi.fn()}
          onSelectRun={vi.fn()}
        />
      )
      // Scoped past the filter pills, which carry some of the same words —
      // this asserts the run's own status line, not the control beside it.
      const statusLines = screen.getAllByText(label).filter((el) => el.tagName === "SPAN")
      expect(statusLines.length).toBeGreaterThan(0)
      unmount()
    }
  })

  it("renders no absolute path anywhere", () => {
    const { container } = render(
      <GraphAgentPanel
        available
        filter="all"
        onFilterChange={vi.fn()}
        selection={runSelection()}
        hiddenRunCount={0}
        hasAnyAgentData
        hasVisibleRuns
        searchQuery=""
        searchResults={[]}
        onSelectResult={vi.fn()}
        onSelectRun={vi.fn()}
      />
    )

    expect(container.textContent ?? "").not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it("exposes no raw transcript data", () => {
    const { container } = render(
      <GraphAgentPanel
        available
        filter="all"
        onFilterChange={vi.fn()}
        selection={runSelection()}
        hiddenRunCount={0}
        hasAnyAgentData
        hasVisibleRuns
        searchQuery=""
        searchResults={[]}
        onSelectResult={vi.fn()}
        onSelectRun={vi.fn()}
      />
    )

    const text = container.textContent ?? ""
    for (const forbidden of ["thinking", "toolUseResult", "old_string", "messagingSocketPath", "pipe"]) {
      expect(text).not.toContain(forbidden)
    }
  })

  it("offers no control that would change the run", () => {
    renderPanel({ selection: runSelection() })

    for (const label of [/^stop$/i, /^start$/i, /^kill$/i, /^delete$/i, /send prompt/i, /^run$/i]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull()
    }
  })
})

describe("the agent inspector", () => {
  const selection: AgentInspectorSelection = {
    kind: "agent",
    node: {
      kind: "agent",
      id: "agent:a1",
      agentId: "a1",
      label: "Claude Code",
      provider: "claude-code",
      activeRunCount: 2,
      totalRunCount: 5,
      status: "working",
      createdAt: T0,
    },
    recentRuns: [
      { runId: "r1", title: "Implement authentication", status: "working" },
      { runId: "r2", title: "Fix the poller", status: "completed" },
    ],
  }

  it("shows provider, status and counts", () => {
    renderPanel({ selection })

    // Two matches since Phase 17: the connector strip names the provider too.
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0)
    expect(screen.getByText("claude-code")).toBeTruthy()
    expect(screen.getAllByText("Working").some((el) => el.tagName === "SPAN")).toBe(true)
    expect(screen.getByText(/2 active · 5 total/)).toBeTruthy()
  })

  it("lists recent runs and selects one when clicked", async () => {
    const user = userEvent.setup()
    const { onSelectRun } = renderPanel({ selection })

    await user.click(screen.getByRole("button", { name: /implement authentication/i }))

    expect(onSelectRun).toHaveBeenCalledWith("r1")
  })
})

describe("the artifact inspector", () => {
  const selection: AgentInspectorSelection = {
    kind: "artifact",
    node: {
      kind: "artifact",
      id: "artifact:wa1",
      artifactId: "wa1",
      label: "artifacts.ts",
      relativePath: "src/lib/agents/artifacts.ts",
      runCount: 1,
      updatedAt: T0,
      createdAt: T0,
    },
    touchedBy: [
      { runId: "r1", runTitle: "Implement artifacts", agentName: "Claude Code", role: "edited" },
    ],
  }

  it("shows the filename and its project-relative path", () => {
    renderPanel({ selection })

    expect(screen.getByText("artifacts.ts")).toBeTruthy()
    expect(screen.getByText("src/lib/agents/artifacts.ts")).toBeTruthy()
  })

  it("shows which runs worked on it and how", () => {
    renderPanel({ selection })

    expect(screen.getByText(/claude code — implement artifacts/i)).toBeTruthy()
    expect(screen.getByText("edited")).toBeTruthy()
  })

  it("shows no file contents or diff", () => {
    const { container } = render(
      <GraphAgentPanel
        available
        filter="all"
        onFilterChange={vi.fn()}
        selection={selection}
        hiddenRunCount={0}
        hasAnyAgentData
        hasVisibleRuns
        searchQuery=""
        searchResults={[]}
        onSelectResult={vi.fn()}
        onSelectRun={vi.fn()}
      />
    )

    expect(container.querySelector("pre")).toBeNull()
    expect(container.querySelector("code")).toBeNull()
  })
})

describe("search results", () => {
  const results: AgentSearchResult[] = [
    { id: "run:r1", kind: "run", label: "Implement authentication", detail: "Edited sidebar.tsx", typeLabel: "Agent run" },
    { id: "artifact:wa1", kind: "artifact", label: "artifacts.ts", detail: "src/lib/agents/artifacts.ts", typeLabel: "File" },
  ]

  it("labels each result with its type", () => {
    renderPanel({ searchQuery: "a", searchResults: results })

    expect(screen.getByText(/Agent run · Edited sidebar.tsx/)).toBeTruthy()
    expect(screen.getByText(/File · src\/lib\/agents\/artifacts.ts/)).toBeTruthy()
  })

  it("selects the entity when a result is clicked", async () => {
    const user = userEvent.setup()
    const { onSelectResult } = renderPanel({ searchQuery: "a", searchResults: results })

    await user.click(screen.getByRole("button", { name: /implement authentication/i }))

    expect(onSelectResult).toHaveBeenCalledWith("run:r1")
  })

  it("says so when nothing matches", () => {
    renderPanel({ searchQuery: "zzz", searchResults: [] })

    expect(screen.getByText(/no agent work matches/i)).toBeTruthy()
  })

  it("shows no result list when the query is empty", () => {
    renderPanel({ searchQuery: "", searchResults: results })

    expect(screen.queryByLabelText(/agent search results/i)).toBeNull()
  })
})

describe("accessibility", () => {
  it("names the section", () => {
    renderPanel()

    expect(screen.getByRole("region", { name: /agent/i })).toBeTruthy()
  })

  it("gives the whole run a linear text representation", () => {
    const { container } = render(
      <GraphAgentPanel
        available
        filter="all"
        onFilterChange={vi.fn()}
        selection={runSelection()}
        hiddenRunCount={0}
        hasAnyAgentData
        hasVisibleRuns
        searchQuery=""
        searchResults={[]}
        onSelectResult={vi.fn()}
        onSelectRun={vi.fn()}
      />
    )

    // Everything the canvas says spatially, readable without it.
    const text = container.textContent ?? ""
    expect(text).toContain("Implement authentication")
    expect(text).toContain("Claude Code")
    expect(text).toContain("Working")
    expect(text).toContain("src/lib/agents/artifacts.ts")
    expect(text).toContain("API reference")
    expect(text).toContain("Edited artifacts.ts")
  })
})


describe("the live activity section", () => {
  const working = [
    {
      id: "run:r1",
      provider: "claude-code",
      agentName: "Claude Code",
      state: "working" as const,
      activity: "Researching competitor architecture",
    },
  ]

  it("is absent entirely when nothing is running", () => {
    renderPanel()
    expect(screen.queryByText("NOW")).toBeNull()
  })

  it("names who is working and what they are doing", () => {
    renderPanel({ activity: working })
    expect(screen.getByText("NOW")).toBeTruthy()

    // Scoped to the list: the agent's name is legitimately in the connector
    // strip too, and the two sections answer different questions — "who is
    // connected" and "who is working right now".
    const list = within(screen.getByRole("list", { name: "Agent activity" }))
    expect(list.getByText("Claude Code")).toBeTruthy()
    expect(list.getByText(/Researching competitor architecture/)).toBeTruthy()
  })

  it("selects the run behind a row", async () => {
    const user = userEvent.setup()
    const { onSelectResult } = renderPanel({ activity: working })

    await user.click(screen.getByRole("button", { name: /Claude Code — Working/ }))
    expect(onSelectResult).toHaveBeenCalledWith("run:r1")
  })
})

describe("the Agent World entry point", () => {
  it("is absent when the world is turned off", () => {
    renderPanel()
    expect(screen.queryByRole("button", { name: "Agent World" })).toBeNull()
  })

  it("is offered before this workspace has any agent history", async () => {
    // It used to be hidden here, on the principle that a button opening an
    // empty room promises more than it delivers. That was true of the room it
    // used to open. The world now has a real idle state — the connected
    // agents standing in it, and a line saying what would make them work — so
    // the gate was hiding the view that explains the feature from exactly the
    // people who had not found it yet.
    const user = userEvent.setup()
    const onOpenWorld = vi.fn()
    renderPanel({ onOpenWorld, hasAnyAgentData: false })

    await user.click(screen.getByRole("button", { name: "Agent World" }))
    expect(onOpenWorld).toHaveBeenCalled()
  })

  it("opens the world once there is work in it", async () => {
    const user = userEvent.setup()
    const onOpenWorld = vi.fn()
    renderPanel({ onOpenWorld })

    await user.click(screen.getByRole("button", { name: "Agent World" }))
    expect(onOpenWorld).toHaveBeenCalled()
  })
})

describe("a connector that is still connecting", () => {
  it("says which agent is getting ready rather than 'no activity'", () => {
    // Mid-handshake is neither a failure nor a finish, and saying "no agent
    // activity" while it is still connecting would be wrong in a way the user
    // would act on.
    renderPanel({
      connectors: [
        {
          provider: "claude-code",
          displayName: "Claude Code",
          statusLabel: "Connecting",
          connected: false,
          statusKind: "connecting",
        },
      ],
      hasVisibleRuns: false,
    })

    expect(screen.getByText("Claude Code is getting ready…")).toBeTruthy()
  })
})
