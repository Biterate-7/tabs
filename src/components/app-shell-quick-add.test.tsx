/**
 * Quick add, in the real <AppShell/>: the project on screen is the one Chrome
 * tabs go to. The page tells the extension which project that is
 * (TABDUMP_PROJECT_FOCUS) and, once the extension answers with its shortcut
 * (TABDUMP_QUICK_ADD_INFO), the project home says so in the project's name —
 * following the person from project to project and across a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AppShell } from "./app-shell"
import { dismissOnboarding } from "@/lib/onboarding"
import { loadWorkspaceStore, saveWorkspaceStore } from "@/lib/workspace/persistence"
import type { WorkspaceStore } from "@/lib/workspace/types"

vi.mock("@/lib/browser/history", () => ({ fetchBrowserHistory: vi.fn() }))

const SOURCE = "tabdump-extension"

function seed(currentId: string) {
  const store: WorkspaceStore = {
    version: 1,
    currentId,
    workspaces: [
      { id: "ws-history", name: "History IA", tabs: [], sections: [], createdAt: 1, updatedAt: 1 },
      { id: "ws-physics", name: "Physics EE", tabs: [], sections: [], createdAt: 2, updatedAt: 2 },
    ],
  }
  saveWorkspaceStore(store)
}

/** What the page tells the extension, as the content script would see it. */
function focusReports(): string[] {
  const seen: string[] = []
  const listener = (event: MessageEvent) => {
    const data = event.data as { source?: string; type?: string; payload?: { focus?: { id?: string } } }
    if (data?.source === SOURCE && data.type === "TABDUMP_PROJECT_FOCUS" && data.payload?.focus?.id) seen.push(data.payload.focus.id)
  }
  window.addEventListener("message", listener)
  stops.push(() => window.removeEventListener("message", listener))
  return seen
}

/** The extension answering a focus report (what content-script.js posts back). */
function extensionAnswers(shortcut = "Alt+Shift+H") {
  window.dispatchEvent(new MessageEvent("message", { data: { source: SOURCE, type: "TABDUMP_QUICK_ADD_INFO", payload: { shortcut } }, origin: window.location.origin, source: window }))
}

const target = () => document.querySelector("[data-quick-add-target]")?.getAttribute("data-quick-add-target")

const stops: (() => void)[] = []

beforeEach(() => {
  window.localStorage.clear()
  dismissOnboarding()
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  cleanup()
})

describe("the project Chrome tabs go to", () => {
  it("is the project on screen, and follows a switch to another project", async () => {
    seed("ws-history")
    const reports = focusReports()
    const user = userEvent.setup()
    render(<AppShell />)
    await waitFor(() => expect(reports.at(-1)).toBe("ws-history"))
    extensionAnswers()
    await waitFor(() => expect(target()).toBe("History IA"))
    expect(screen.getByText("Add anything useful from Chrome to this project.")).toBeTruthy()
    expect(screen.getByText(/Right-click a tab → Add to/).textContent).toBe("Right-click a tab → Add to History IA")
    expect(screen.getByText(/also works\./).textContent).toBe("Alt + Shift + H also works.")

    await user.click(await screen.findByRole("button", { name: "Switch to Physics EE" }))
    await waitFor(() => expect(target()).toBe("Physics EE"))
    expect(reports.at(-1)).toBe("ws-physics")
    expect(screen.getByText(/Right-click a tab → Add to/).textContent).toBe("Right-click a tab → Add to Physics EE")
    expect(screen.queryByText(/Add to History IA/)).toBeNull()
  }, 30_000)

  it("is still the same project after a reload", async () => {
    seed("ws-history")
    const user = userEvent.setup()
    const first = render(<AppShell />)
    await user.click(await screen.findByRole("button", { name: "Switch to Physics EE" }))
    await waitFor(() => expect(loadWorkspaceStore()?.currentId).toBe("ws-physics"))
    first.unmount()

    const reports = focusReports()
    render(<AppShell />)
    await waitFor(() => expect(reports.at(-1)).toBe("ws-physics"))
    expect(reports).not.toContain("ws-history")
    extensionAnswers()
    await waitFor(() => expect(target()).toBe("Physics EE"))
  }, 30_000)

  it("without the extension, offers no right-click instructions at all", async () => {
    seed("ws-history")
    render(<AppShell />)
    await screen.findByRole("region", { name: "History IA project" })
    // Give a (missing) extension every chance to answer.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByText(/Right-click a tab/)).toBeNull()
    expect(screen.queryByText("Add anything useful from Chrome to this project.")).toBeNull()
    expect(document.querySelector("[data-add-hint]")?.textContent ?? "").toMatch(/use Hubble for Chrome to add tabs/)
  }, 30_000)
})
