import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SAVE_FROM_AI_STEPS, SaveFromAiCard, SaveFromAiDialog } from "./save-from-ai"
import { __resetBrowserBridgeForTests } from "@/lib/browser/bridge"
import { BROWSER_MESSAGE_SOURCE, MSG_EXTENSION_PONG } from "@/lib/browser/protocol"

/** Hubble for Chrome answering the page's ping — jsdom's postMessage sets no origin or source, so dispatched by hand. */
function extensionAnswers() {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { source: BROWSER_MESSAGE_SOURCE, type: MSG_EXTENSION_PONG, payload: { requestId: "r" } }, origin: window.location.origin, source: window }))
  })
}

beforeEach(() => __resetBrowserBridgeForTests())

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete window.__TAURI_INTERNALS__
  __resetBrowserBridgeForTests()
})

describe("SaveFromAiCard", () => {
  it("without the extension: the call to install it, how it works, and its real download", async () => {
    const user = userEvent.setup()
    render(<SaveFromAiCard />)
    const card = document.querySelector<HTMLElement>("[data-save-from-ai]")!
    expect(card.getAttribute("data-save-from-ai")).toBe("install")
    expect(screen.getByText("Bring your AI conversations into Hubble")).toBeTruthy()
    expect(screen.getByText("Save conversations from your supported AI tools directly to Hubble with the Chrome extension.")).toBeTruthy()
    expect([...screen.getByRole("list", { name: "How it works" }).querySelectorAll("li")].map((li) => li.textContent)).toEqual(SAVE_FROM_AI_STEPS.map((step, index) => `${index + 1}${step}`))
    expect(SAVE_FROM_AI_STEPS[1]).toBe("Open a conversation in ChatGPT, Claude, Gemini or Perplexity.")
    expect(screen.queryByRole("button", { name: /Open AI chat/ })).toBeNull()
    // No store listing is configured: the packaged ZIP, with its install steps — never a made-up store link.
    await user.click(screen.getByRole("button", { name: "Get the Chrome Extension" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "Install Hubble for Chrome" })).toBeTruthy()
    const download = within(dialog).getByRole("link", { name: "Download Extension" })
    expect(download.getAttribute("href")).toBe("/hubble-extension.zip")
    expect(download.hasAttribute("download")).toBe(true)
    expect(document.querySelector('a[href*="chromewebstore"]')).toBeNull()
  })

  it("with a Chrome Web Store listing configured, links straight to it", () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_STORE_URL", "https://chromewebstore.google.com/detail/hubble/abc")
    render(<SaveFromAiCard />)
    const link = screen.getByRole("link", { name: "Get the Chrome Extension" })
    expect(link.getAttribute("href")).toBe("https://chromewebstore.google.com/detail/hubble/abc")
    expect(link.getAttribute("target")).toBe("_blank")
  })

  it("once the extension answers this page: organized, and Open AI chat instead of installing again", async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    render(<SaveFromAiCard />)
    expect(document.querySelector("[data-save-from-ai]")!.getAttribute("data-save-from-ai")).toBe("install")
    extensionAnswers()
    expect(document.querySelector("[data-save-from-ai]")!.getAttribute("data-save-from-ai")).toBe("connected")
    expect(screen.getByText("Your AI conversations, organized")).toBeTruthy()
    expect(screen.getByText("Open a supported AI conversation and save it to your Hubble workspace using the extension.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Get the Chrome Extension" })).toBeNull()
    await user.click(screen.getByRole("button", { name: /Open AI chat/ }))
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["ChatGPT", "Claude", "Gemini", "Perplexity"])
    await user.click(screen.getByRole("menuitem", { name: "Claude" }))
    expect(open).toHaveBeenCalledWith("https://claude.ai/new", "_blank", "noopener,noreferrer")
  })

  it("in Hubble Desktop, which never hears from the extension: install, or open a chat — never 'connected'", () => {
    window.__TAURI_INTERNALS__ = {}
    render(<SaveFromAiCard />)
    extensionAnswers()
    expect(document.querySelector("[data-save-from-ai]")!.getAttribute("data-save-from-ai")).toBe("desktop")
    expect(screen.getByText("Bring your AI conversations into Hubble")).toBeTruthy()
    expect(screen.getByText(/While Hubble Desktop is open, they're saved here\./)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Get the Chrome Extension" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Open AI chat/ })).toBeTruthy()
    expect(screen.queryByText("Your AI conversations, organized")).toBeNull()
  })
})

describe("SaveFromAiDialog", () => {
  it("shows the install steps in place, and Back returns to how it works", async () => {
    const user = userEvent.setup()
    render(<SaveFromAiDialog open onOpenChange={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Get the Chrome Extension" }))
    expect(screen.getByRole("heading", { name: "Install Hubble for Chrome" })).toBeTruthy()
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByRole("heading", { name: "Bring your AI conversations into Hubble" })).toBeTruthy()
  })
})
