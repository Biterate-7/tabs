import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AiView } from "./ai-view"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

const NOW = new Date(2026, 9, 20, 15, 0).getTime()
const chat: Tab = {
  id: "a",
  url: "https://claude.ai/chat/cccccccc-3333",
  normalizedUrl: "claude.ai/chat/cccccccc-3333",
  domain: "claude.ai",
  title: "Outline critique",
  resource: { kind: "conversation", origin: "extension", status: "ready", addedAt: NOW, updatedAt: NOW, meta: { provider: "claude" }, content: { chars: 10, extractedAt: NOW } },
}
const project: Workspace = { id: "p", name: "Essay", tabs: [chat], createdAt: 0, updatedAt: 0 }
const empty: Workspace = { id: "q", name: "Empty", tabs: [], createdAt: 0, updatedAt: 0 }

function renderAi() {
  const props = { workspaces: [project, empty], now: NOW, onUseInAi: vi.fn(), onOpenItem: vi.fn(), onOpenUrl: vi.fn(), onSaveFromAi: vi.fn() }
  render(<AiView {...props} />)
  return props
}

describe("AiView", () => {
  it("sends a project's context to the AI app chosen on the page", async () => {
    const user = userEvent.setup()
    const props = renderAi()
    await user.click(screen.getByRole("radio", { name: /Gemini/ }))
    await user.click(screen.getByRole("button", { name: "Use in Gemini" }))
    expect(props.onUseInAi).toHaveBeenCalledWith("p", [], "gemini")
  })

  it("offers only projects that hold something", () => {
    renderAi()
    expect(screen.queryByText("Empty")).toBeNull()
  })

  it("counts saved conversations per app from the records", () => {
    renderAi()
    expect(screen.getByRole("radio", { name: /Claude.*1 conversation saved/ })).toBeTruthy()
    expect(screen.getByRole("radio", { name: /ChatGPT.*None saved yet/ })).toBeTruthy()
  })

  it("continues a saved conversation in its own app, or reads it in Hubble", async () => {
    const user = userEvent.setup()
    const props = renderAi()
    await user.click(screen.getByRole("button", { name: "Continue Outline critique in Claude" }))
    expect(props.onOpenUrl).toHaveBeenCalledWith(chat.url)
    await user.click(screen.getByRole("button", { name: /^Outline critique/ }))
    expect(props.onOpenItem).toHaveBeenCalledWith("p", { kind: "source", tabId: "a" })
  })

  it("says plainly what happens without Hubble for Chrome, and claims no capability the registry does not", () => {
    renderAi()
    expect(screen.getByRole("status").textContent).toMatch(/copies the context and opens the app for you to paste/)
    expect(screen.getAllByText(/: (supported|not available)$/).length).toBeGreaterThan(0)
  })
})
