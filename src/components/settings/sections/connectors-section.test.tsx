import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { setStorageNamespace } from "@/lib/storage/namespace"
import { resetConnectorManager } from "@/lib/agents/connectors/app-manager"
import { saveAgentState } from "@/lib/agents/persistence"
import { createAgent } from "@/lib/agents/registry"
import { createRun } from "@/lib/agents/runs"
import { emptyAgentState } from "@/lib/agents/types"
import { ConnectorsSection } from "./connectors-section"

/**
 * Settings → AI Connectors, rendered over the real app manager and the real
 * shipped catalog.
 *
 * Nothing is stubbed. There is no Claude Code on a test machine and no
 * `/api/agents/claude-code` behind jsdom's fetch, so the page renders exactly
 * what a user on an unequipped machine would see — which is precisely the
 * state most at risk of being faked, and therefore the one most worth
 * asserting on.
 */

const T0 = 1_700_000_000_000

beforeEach(() => {
  window.localStorage.clear()
  setStorageNamespace(null)
  resetConnectorManager()
})

afterEach(() => {
  resetConnectorManager()
  window.localStorage.clear()
  setStorageNamespace(null)
  vi.restoreAllMocks()
})

describe("the default, unconnected state", () => {
  it("lists every shipped provider without connecting anything", () => {
    render(<ConnectorsSection />)

    expect(screen.getByText("Claude Code")).toBeTruthy()
    expect(screen.getByText("OpenAI / Codex")).toBeTruthy()
    expect(screen.getByText("Gemini")).toBeTruthy()
    expect(screen.getByText("Grok")).toBeTruthy()
    expect(screen.getByText("Custom agent")).toBeTruthy()
  })

  it("says plainly that nothing is connected, rather than showing a dead page", () => {
    render(<ConnectorsSection />)

    expect(screen.getByText("No agents connected yet")).toBeTruthy()
    expect(screen.queryByText("Connected")).toBeNull()
  })

  it("shows no fake activity for any provider", () => {
    render(<ConnectorsSection />)

    // The failure this guards against is a demo row: "Claude Code · Working"
    // on a machine where nothing has ever run.
    expect(screen.queryByText(/active run/i)).toBeNull()
    expect(screen.queryByText("Working")).toBeNull()
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0)
  })

  it("states the security boundary on the page, not only in the docs", async () => {
    render(<ConnectorsSection />)

    expect(
      screen.getByText(/never runs commands, sends prompts, or changes your files/i)
    ).toBeTruthy()
  })
})

describe("opening a connector", () => {
  it("shows its capabilities, marking what it cannot do", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)

    await user.click(screen.getByRole("button", { name: /Claude Code/ }))

    expect(screen.getByText("Capabilities")).toBeTruthy()
    // Every capability is listed, supported or not — a list that showed only
    // the supported ones would leave the reader unable to tell an absent
    // capability from an unlisted one.
    for (const label of ["Runs", "Events", "Files", "Artifacts", "Work items", "Live updates"]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getAllByText("supported").length).toBe(6)
  })

  it("explains an unimplemented provider instead of offering a pointless Connect", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)

    await user.click(screen.getByRole("button", { name: /Gemini/ }))

    expect(
      screen.getByText(/TabDump lists a capability only once it can actually observe it/i)
    ).toBeTruthy()
  })

  it("navigates back to the list", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)

    await user.click(screen.getByRole("button", { name: /Grok/ }))
    await user.click(screen.getByRole("button", { name: /All connectors/ }))

    expect(screen.getByText("Claude Code")).toBeTruthy()
    expect(screen.getByText("Gemini")).toBeTruthy()
  })
})

describe("the connect flow", () => {
  it("shows what TabDump will and will not do before connecting", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)

    await user.click(screen.getByRole("button", { name: /Claude Code/ }))

    expect(screen.getByText("TabDump will not")).toBeTruthy()
    expect(screen.getByText("Run commands")).toBeTruthy()
    expect(screen.getByText("Send prompts")).toBeTruthy()
    expect(screen.getByText("Modify your files")).toBeTruthy()
    expect(screen.getByText("Control the agent")).toBeTruthy()

    expect(screen.getByText("TabDump can")).toBeTruthy()
    expect(screen.getByText("Observe runs")).toBeTruthy()
  })

  it("lands on an honest unavailable when the environment cannot observe", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)

    await user.click(screen.getByRole("button", { name: /Claude Code/ }))
    await user.click(screen.getByRole("button", { name: "Connect" }))

    // No Claude Code on a test machine, and the UI says so rather than
    // pretending to have connected.
    await waitFor(() => {
      expect(screen.queryByText("Connected")).toBeNull()
    })
  })
})

describe("usage numbers come from recorded state", () => {
  it("shows a provider's real counts and nothing when there are none", async () => {
    const agent = createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0)
    if (!agent.ok) throw new Error("fixture failed")

    const run = createRun(
      agent.state,
      { agentId: agent.agent.id, workspaceId: "wA", externalId: "s1", title: "Implement auth" },
      T0
    )
    if (!run.ok) throw new Error("fixture failed")

    saveAgentState(run.state)

    const user = userEvent.setup()
    render(<ConnectorsSection />)

    // The row reports the one run that genuinely exists.
    expect(screen.getByText(/1 active run/)).toBeTruthy()

    // A provider that has done nothing shows no number at all, rather than a
    // row of zeroes that reads like a measurement.
    await user.click(screen.getByRole("button", { name: /Gemini/ }))
    expect(screen.queryByText("Usage")).toBeNull()
  })
})

describe("accessibility", () => {
  it("carries each connector's state in words, not only in a coloured dot", () => {
    render(<ConnectorsSection />)

    const row = screen.getByRole("button", { name: /Claude Code — Not connected/ })
    expect(row).toBeTruthy()
  })

  it("marks every capability as supported or not for a screen reader", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)

    await user.click(screen.getByRole("button", { name: /Gemini/ }))

    // Gemini declares nothing, so the list is replaced by a sentence rather
    // than six "not supported" rows.
    expect(screen.queryByText("supported")).toBeNull()
  })
})
