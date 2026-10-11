import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AiConnectionsList } from "./ai-connections"
import type { UseAgentPlatform } from "@/hooks/use-agent-platform"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"

/** Only what the list reads: each AI's phase, its sentence, the re-check, and where Hubble is running. */
function platformWith(
  phases: Partial<Record<AgentProviderId, ConnectionPhase>>,
  retry = vi.fn(async () => true),
  surface: "web" | "desktop" = "web"
) {
  return {
    phaseOf: (provider: AgentProviderId) => phases[provider] ?? "not_installed",
    sentenceOf: () => "The agent runtime did not answer on 127.0.0.1:41517.",
    pending: null,
    retry,
    surface,
  } as unknown as UseAgentPlatform
}

function row(provider: string) {
  return document.querySelector<HTMLElement>(`[data-ai-connection="${provider}"]`)!
}

describe("AI Connections", () => {
  it("lists each AI by the name students know, with where it stands", () => {
    render(<AiConnectionsList platform={platformWith({ "claude-code": "connected", gemini: "detected", grok: "not_installed" })} onConnect={vi.fn()} />)
    expect(row("claude-code").textContent).toContain("Claude")
    expect(row("claude-code").textContent).toContain("Connected")
    expect(row("gemini").textContent).toContain("Installed")
    expect(row("grok").textContent).toContain("Not detected")
    // The custom MCP client is under "+ Connect AI", not a row of its own.
    expect(document.querySelector('[data-ai-connection="custom"]')).toBeNull()
  })

  it("connects an installed AI with one click, straight into its own Connect flow", async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn()
    render(<AiConnectionsList platform={platformWith({ gemini: "detected" })} onConnect={onConnect} />)
    await user.click(within(row("gemini")).getByRole("button", { name: "Connect →" }))
    expect(onConnect).toHaveBeenCalledWith("gemini")
  })

  it("tests a connected AI and says the result in words", async () => {
    const user = userEvent.setup()
    const retry = vi.fn(async () => true)
    render(<AiConnectionsList platform={platformWith({ "claude-code": "connected" }, retry)} onConnect={vi.fn()} />)
    await user.click(within(row("claude-code")).getByRole("button", { name: "Test connection" }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith("claude-code"))
    expect(within(row("claude-code")).getByRole("button", { name: "Reconnect" })).toBeTruthy()
  })

  it("turns a broken connection into one friendly sentence and a fix — the technical detail only on request", async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn()
    render(<AiConnectionsList platform={platformWith({ "claude-code": "connection_lost" })} onConnect={onConnect} />)
    const claude = row("claude-code")
    expect(claude.textContent).toContain("Needs reconnecting")
    expect(claude.textContent).toContain("We couldn't connect to Claude.")
    expect(claude.textContent).not.toMatch(/127\.0\.0\.1|runtime/)
    await user.click(within(claude).getByRole("button", { name: "Details" }))
    expect(claude.querySelector("[data-ai-connection-details]")!.textContent).toContain("Connection lost")
    await user.click(within(claude).getByRole("button", { name: "Fix connection" }))
    expect(onConnect).toHaveBeenCalledWith("claude-code")
  })

  it("names each button's AI for a screen reader without repeating it on screen", () => {
    render(<AiConnectionsList platform={platformWith({ gemini: "detected" })} onConnect={vi.fn()} />)
    const button = within(row("gemini")).getByRole("button", { name: "Connect →" })
    const described = button.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent)
    expect(described).toEqual(["Gemini", "Installed"])
  })

  it("on the web, an AI that runs in Hubble Desktop links to the download page — and nothing else", () => {
    render(<AiConnectionsList platform={platformWith({ gemini: "runtime_unavailable", "claude-code": "connected" })} onConnect={vi.fn()} />)
    const gemini = row("gemini")
    expect(gemini.textContent).toContain("Needs the desktop app")
    const link = within(gemini).getByRole("link")
    // Hubble's own download page (which says honestly whether a build is out), opened beside the app.
    expect(link.getAttribute("href")).toBe("/download")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("aria-label")).toMatch(/Hubble Desktop — required for Gemini CLI$/)
    // No pointless Details toggle beside it, and no desktop link for an AI that is already connected.
    expect(within(gemini).queryByRole("button", { name: "Details" })).toBeNull()
    expect(within(row("claude-code")).queryByRole("link")).toBeNull()
  })

  it("never offers the desktop app when it isn't the answer: unavailable inside the desktop app says so, with details", async () => {
    const user = userEvent.setup()
    render(<AiConnectionsList platform={platformWith({ gemini: "runtime_unavailable" }, undefined, "desktop")} onConnect={vi.fn()} />)
    const gemini = row("gemini")
    expect(gemini.textContent).toContain("Not available here")
    expect(within(gemini).queryByRole("link")).toBeNull()
    await user.click(within(gemini).getByRole("button", { name: "Details" }))
    expect(gemini.querySelector("[data-ai-connection-details]")!.textContent).toContain("Unavailable here")
  })

  it("opens the chooser from + Connect AI", async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn()
    render(<AiConnectionsList platform={platformWith({})} onConnect={onConnect} />)
    await user.click(screen.getByRole("button", { name: "Connect AI" }))
    expect(onConnect).toHaveBeenCalledWith()
  })
})
