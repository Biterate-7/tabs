import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { setStorageNamespace } from "@/lib/storage/namespace"
import { resetConnectorManager } from "@/lib/agents/connectors/app-manager"
import { PLATFORM_PROVIDERS } from "@/lib/agents/platform/catalog"
import { authenticationLine } from "./agent-connections-panel"
import { ConnectorsSection } from "./connectors-section"

/**
 * Settings → Agents → Connections (Agent Authentication & Runtime), over the
 * real page with no runtime behind jsdom — the state most at risk of being
 * dressed up. Every row comes from the catalogue; every "Authentication"
 * line names only what Hubble offers here.
 */

beforeEach(() => {
  window.localStorage.clear()
  setStorageNamespace(null)
  resetConnectorManager()
})

afterEach(() => {
  resetConnectorManager()
  window.localStorage.clear()
})

function connections() {
  return screen.getByRole("region", { name: "Agent connections" })
}

describe("the connections list", () => {
  it("lists every agent in the catalogue, with how it authenticates here", () => {
    render(<ConnectorsSection />)
    const region = connections()
    for (const provider of PLATFORM_PROVIDERS) expect(within(region).getByText(provider.displayName)).toBeTruthy()

    const text = region.textContent ?? ""
    // The web: Claude on the user's own key; the others on their own sign-in.
    expect(text).toContain("Authentication · Anthropic API key")
    expect(text).toContain("Authentication · Google account")
    expect(text).toContain("Authentication · ChatGPT account")
    expect(text).toContain("Authentication · xAI account")
    expect(text).toContain("Authentication · Hubble access token")
    // Never a claim that a Claude subscription can be used here.
    expect(text).not.toMatch(/Claude subscription|Claude account/)
    expect(within(region).getByText(/Use your existing account where the provider supports it/)).toBeTruthy()
  })

  it("says honestly that nothing can run here, rather than Connecting…", () => {
    render(<ConnectorsSection />)
    const text = connections().textContent ?? ""
    expect(text).not.toMatch(/Connecting/)
    expect(text).toContain("Unavailable here")
  })

  it("offers to connect Codex like any agent that asks before every action", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)
    const row = within(connections()).getByText("Codex").closest("div")!.parentElement!
    expect(row.textContent).not.toMatch(/Sessions ·/)
    await user.click(within(row).getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("dialog", { name: /Connect Codex/ })).toBeTruthy()
  })

  it("says a connected Codex is connected through Codex, with its ChatGPT account — never an account detail", () => {
    const codex = PLATFORM_PROVIDERS.find((provider) => provider.provider === "openai-codex")!
    const status = {
      provider: "openai-codex" as const,
      connection: "connected" as const,
      available: true,
      authentication: "authenticated" as const,
      authKind: "subscription" as const,
      capabilities: ["create_session" as const],
    }
    expect(authenticationLine(codex, "desktop", status, "connected")).toBe("Connected through Codex · ChatGPT account")
    // Before it is approved, the sign-in in use — not "connected".
    expect(authenticationLine(codex, "desktop", status, "awaiting_approval")).toBe("ChatGPT account · in use")
  })

  it("opens the same Connect Agent flow for the chosen agent", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)
    const row = within(connections()).getByText("Gemini CLI").closest("div")!.parentElement!
    await user.click(within(row).getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("dialog", { name: /Connect Gemini CLI/ })).toBeTruthy()
  })

  it("is reachable by keyboard, and each button says which agent it is for", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)
    const buttons = within(connections()).getAllByRole("button", { name: "Connect" })
    // Every agent but the one Hubble cannot start sessions with, which offers its details instead.
    const unusable = PLATFORM_PROVIDERS.filter((provider) => provider.chat && !provider.sessions.available)
    expect(buttons).toHaveLength(PLATFORM_PROVIDERS.length - unusable.length)
    expect(within(connections()).queryAllByRole("button", { name: "Details" })).toHaveLength(unusable.length)
    // Described by the agent's name and state, so a screen reader hears which.
    const describedBy = buttons[0]!.getAttribute("aria-describedby")!.split(" ")
    expect(describedBy.map((id) => document.getElementById(id)?.textContent).join(" ")).toMatch(/Claude Code.*Unavailable here/)

    buttons[0]!.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("dialog", { name: /Connect Claude Code/ })).toBeTruthy()
  })
})

describe("a connector's page", () => {
  it("replaces the Anthropic-only card with the provider-neutral authentication block", async () => {
    const user = userEvent.setup()
    render(<ConnectorsSection />)
    await user.click(screen.getByRole("button", { name: /Claude Code — Not connected/ }))

    expect(screen.getByText("Authentication")).toBeTruthy()
    expect(screen.getByText("Claude Code runs on your own Anthropic API key here.")).toBeTruthy()
    // The subscription route is shown as unavailable, with Anthropic's reason.
    expect(screen.getByText(/doesn't allow apps built on the Claude Agent SDK/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Connect Claude Code" }))
    expect(await screen.findByRole("dialog", { name: /Connect Claude Code/ })).toBeTruthy()
  })
})
