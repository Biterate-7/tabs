import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GraphAgentPanel } from "./graph-agent-panel"
import type { AgentPanelConnector } from "./graph-agent-panel"

/**
 * The workspace sidebar's multi-provider surface.
 *
 * Two things are being pinned. First, the four empty states stay apart: a
 * user who has connected nothing, one whose connector cannot observe, one
 * whose workspace has no agent work, and one whose filter hides it all need
 * four different things, and a single "nothing here" would serve none of
 * them. Second, the provider filter appears only when there is genuinely a
 * choice to make.
 */

const NOOP = () => {}

function panel(over: Partial<Parameters<typeof GraphAgentPanel>[0]> = {}) {
  return (
    <GraphAgentPanel
      available={false}
      filter="active"
      onFilterChange={NOOP}
      selection={null}
      hiddenRunCount={0}
      hasAnyAgentData={false}
      hasVisibleRuns={false}
      searchQuery=""
      searchResults={[]}
      onSelectResult={NOOP}
      onSelectRun={NOOP}
      {...over}
    />
  )
}

const CONNECTED: AgentPanelConnector = {
  provider: "claude-code",
  displayName: "Claude Code",
  statusLabel: "Connected",
  connected: true,
}

const UNAVAILABLE: AgentPanelConnector = {
  provider: "gemini",
  displayName: "Gemini",
  statusLabel: "Unavailable",
  connected: false,
}

describe("the connector strip", () => {
  it("renders nothing when the user has connected nothing", () => {
    render(panel())
    expect(screen.queryByLabelText("Connected agents")).toBeNull()
  })

  it("lists each connected provider with its state in words", () => {
    render(panel({ connectors: [CONNECTED, UNAVAILABLE] }))

    const strip = screen.getByLabelText("Connected agents")
    expect(strip.textContent).toContain("Claude Code")
    expect(strip.textContent).toContain("Connected")
    expect(strip.textContent).toContain("Gemini")
    expect(strip.textContent).toContain("Unavailable")
  })

  it("never invents a working state for a provider that is not connected", () => {
    render(panel({ connectors: [UNAVAILABLE] }))

    const strip = screen.getByLabelText("Connected agents")
    expect(strip.textContent).not.toContain("Working")
    expect(strip.textContent).toContain("Unavailable")
  })
})

describe("the empty states stay apart", () => {
  it("asks the user to connect something when nothing is connected", () => {
    render(panel({ connectors: [] }))

    expect(screen.getByText("No agents connected")).toBeTruthy()
    expect(screen.getByText(/Settings → Agents/)).toBeTruthy()
  })

  it("says a connected agent cannot be observed, rather than that none exists", () => {
    render(panel({ connectors: [UNAVAILABLE], available: false }))

    expect(screen.getByText("Agent not observable")).toBeTruthy()
    expect(screen.queryByText("No agents connected")).toBeNull()
  })

  it("distinguishes an empty workspace from an unobservable connector", () => {
    render(panel({ connectors: [CONNECTED], available: true, hasAnyAgentData: false }))

    expect(screen.getByText("No agent activity in this workspace.")).toBeTruthy()
  })

  it("says how much the filter is hiding rather than looking empty", () => {
    render(
      panel({
        connectors: [CONNECTED],
        available: true,
        hasAnyAgentData: true,
        hasVisibleRuns: false,
        hiddenRunCount: 3,
      })
    )

    expect(screen.getByText("No runs match this filter.")).toBeTruthy()
    expect(screen.getByText(/3 runs hidden/)).toBeTruthy()
  })

  it("mentions previously observed work when the connector goes away", () => {
    render(panel({ connectors: [UNAVAILABLE], available: false, hasAnyAgentData: true }))

    // The work that was observed is still real; only the ability to observe
    // more has gone.
    expect(screen.getByText(/still shows previously observed agent activity/)).toBeTruthy()
  })
})

describe("the provider filter", () => {
  it("does not appear when only one provider has worked here", () => {
    render(
      panel({
        connectors: [CONNECTED],
        available: true,
        hasAnyAgentData: true,
        hasVisibleRuns: true,
        providers: ["claude-code"],
        onProviderFilterChange: NOOP,
      })
    )

    // One provider is not a choice, and a control offering one is noise.
    expect(screen.queryByLabelText("Filter by agent")).toBeNull()
  })

  it("appears the moment a second provider has worked here", () => {
    render(
      panel({
        connectors: [CONNECTED],
        available: true,
        hasAnyAgentData: true,
        hasVisibleRuns: true,
        providers: ["claude-code", "custom"],
        providerLabels: { "claude-code": "Claude Code", custom: "My agent" },
        onProviderFilterChange: NOOP,
      })
    )

    const group = screen.getByLabelText("Filter by agent")
    expect(group.textContent).toContain("All agents")
    expect(group.textContent).toContain("Claude Code")
    expect(group.textContent).toContain("My agent")
  })

  it("reports which provider was chosen", async () => {
    const onProviderFilterChange = vi.fn()
    const user = userEvent.setup()

    render(
      panel({
        connectors: [CONNECTED],
        available: true,
        hasAnyAgentData: true,
        hasVisibleRuns: true,
        providers: ["claude-code", "custom"],
        providerLabels: { "claude-code": "Claude Code", custom: "My agent" },
        onProviderFilterChange,
      })
    )

    await user.click(screen.getByRole("button", { name: "My agent" }))
    expect(onProviderFilterChange).toHaveBeenCalledWith("custom")

    await user.click(screen.getByRole("button", { name: "All agents" }))
    expect(onProviderFilterChange).toHaveBeenLastCalledWith(null)
  })

  it("falls back to the provider id when no label is known", () => {
    render(
      panel({
        connectors: [CONNECTED],
        available: true,
        hasAnyAgentData: true,
        hasVisibleRuns: true,
        providers: ["claude-code", "some-future-agent"],
        onProviderFilterChange: NOOP,
      })
    )

    // Better a raw id than a blank pill the user cannot click with intent.
    expect(screen.getByRole("button", { name: "some-future-agent" })).toBeTruthy()
  })

  it("marks the active provider for assistive technology", () => {
    render(
      panel({
        connectors: [CONNECTED],
        available: true,
        hasAnyAgentData: true,
        hasVisibleRuns: true,
        providers: ["claude-code", "custom"],
        providerFilter: "custom",
        providerLabels: { "claude-code": "Claude Code", custom: "My agent" },
        onProviderFilterChange: NOOP,
      })
    )

    expect(screen.getByRole("button", { name: "My agent" }).getAttribute("aria-pressed")).toBe(
      "true"
    )
    expect(screen.getByRole("button", { name: "All agents" }).getAttribute("aria-pressed")).toBe(
      "false"
    )
  })
})

describe("the panel cannot change anything", () => {
  it("exposes no control that would act on an agent", () => {
    const props = Object.keys({
      available: false,
      filter: "active",
      onFilterChange: NOOP,
      connectors: [],
      providers: [],
      providerFilter: null,
      onProviderFilterChange: NOOP,
      providerLabels: {},
      selection: null,
      hiddenRunCount: 0,
      hasAnyAgentData: false,
      hasVisibleRuns: false,
      searchQuery: "",
      searchResults: [],
      onSelectResult: NOOP,
      onSelectRun: NOOP,
    })

    // Connecting is a settings action. A switch here would put a
    // system-level control where people click while exploring a graph.
    for (const forbidden of ["onConnect", "onDisconnect", "onStop", "onCancel", "onPrompt"]) {
      expect(props).not.toContain(forbidden)
    }
  })
})
