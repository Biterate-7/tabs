import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CLAUDE_SESSION, GEMINI_SESSION } from "./data"
import { DemoApp } from "./demo-app"
import { DemoFrame } from "./demo-frame"
import DemoGraph from "./demo-graph"
import { DEMO_REPLY_DELAY_MS, HubbleDemoProvider, type DemoScheme } from "./demo-provider"
import type { DemoInit } from "./demo-state"

/*
 * The landing page's live windows, driven the way a visitor drives them.
 *
 * Each test renders a whole demo window — the real app components on the
 * demo's isolated state — and asserts on what the visitor would see change.
 * Two things are asserted throughout because they are the demo's promise:
 * nothing reaches the network and nothing is written to storage.
 */

let fetchSpy: ReturnType<typeof vi.fn>
let openSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  window.localStorage.clear()
  fetchSpy = vi.fn(() => Promise.reject(new Error("the demo must not fetch")))
  vi.stubGlobal("fetch", fetchSpy)
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  )
  openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
})

afterEach(() => {
  // The isolation promise, checked after every test's interactions.
  expect(window.localStorage.length).toBe(0)
  expect(fetchSpy).not.toHaveBeenCalled()
  openSpy.mockRestore()
  vi.unstubAllGlobals()
})

function renderDemo(init?: DemoInit, scheme?: { value: DemoScheme; set: (scheme: DemoScheme) => void }) {
  const user = userEvent.setup()
  const view = render(
    <HubbleDemoProvider {...(init ? { init } : {})} {...(scheme ? { scheme } : {})}>
      <DemoFrame palette label="Hubble demo">
        <DemoApp />
      </DemoFrame>
    </HubbleDemoProvider>
  )
  const frame = () => screen.getByRole("region", { name: "Hubble demo" })
  return { user, frame, ...view }
}

function buttonByText(container: HTMLElement, text: string) {
  const found = within(container)
    .getAllByRole("button")
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

describe("the demo window", () => {
  it("is a named region with its overlay container beside it", () => {
    const { frame, container } = renderDemo()
    expect(frame().hasAttribute("data-hubble-demo")).toBe(true)
    expect(frame().classList.contains("m-app")).toBe(true)
    expect(container.querySelector("[data-hubble-demo-portal]")?.classList.contains("m-app")).toBe(true)
  })

  it("renders the real sidebar in its embedded form, without an account row", () => {
    const { frame } = renderDemo()
    expect(within(frame()).getByRole("navigation", { name: "Views" })).toBeTruthy()
    expect(within(frame()).queryByRole("button", { name: /Sign in/ })).toBeNull()
  })
})

describe("workspace", () => {
  it("renders the Research workspace with its collections", () => {
    const { frame } = renderDemo()
    const region = within(frame())
    expect(region.getByText("20 tabs")).toBeTruthy()
    expect(region.getByText("AI Research")).toBeTruthy()
    expect(region.getByText("Product Ideas")).toBeTruthy()
  })

  it("switches workspace from the rail", async () => {
    const { user, frame } = renderDemo()
    await user.click(within(frame()).getByRole("button", { name: "Switch to Hubble Build" }))
    expect(within(frame()).getByText("Release checklist")).toBeTruthy()
    expect(within(frame()).queryByText("AI Research")).toBeNull()
  })

  it("searches, then selects tabs for a collection", async () => {
    const { user, frame } = renderDemo()
    await user.type(within(frame()).getByPlaceholderText("Search tabs..."), "swe")
    await user.click(within(frame()).getByRole("button", { name: "Select" }))
    await user.click(within(frame()).getByRole("checkbox", { name: "Select swebench.com" }))
    expect(within(frame()).getAllByText("1 selected").length).toBeGreaterThan(0)
  })

  it("opens a saved tab in a new browser tab, never navigating the page", async () => {
    const { user, frame } = renderDemo()
    await user.click(within(frame()).getAllByRole("button", { name: "Open arxiv.org" })[0])
    expect(openSpy).toHaveBeenCalledWith("https://arxiv.org/abs/1706.03762", "_blank", "noopener,noreferrer")
  })
})

describe("Command Centre", () => {
  function renderCommandCentre(init: DemoInit = {}) {
    return renderDemo({ view: "command-centre", selectedSessionId: CLAUDE_SESSION, ...init })
  }

  it("renders the sessions, the roster and the open session", () => {
    const { frame } = renderCommandCentre()
    const region = within(frame())
    expect(region.getByRole("navigation", { name: "Agent sessions" })).toBeTruthy()
    expect(region.getByRole("region", { name: "Connected agents" })).toBeTruthy()
    expect(region.getByRole("heading", { name: "Summarize the SWE-bench reading list" })).toBeTruthy()
    // Codex is connected but, as in Hubble, runs no sessions.
    expect(region.getByText("Connected · sessions unavailable")).toBeTruthy()
    // The view bar says what the demo is rather than reporting a runtime.
    expect(region.getByRole("status").textContent).toMatch(/Demo/)
  })

  it("renders the approval card without taking focus on load", () => {
    const { frame } = renderCommandCentre()
    const card = within(frame()).getByRole("group", { name: "Approval required" })
    expect(within(card).getByText("SWE-bench")).toBeTruthy()
    expect(document.activeElement).toBe(document.body)
  })

  it("Allow applies the change: the collection appears in the workspace", async () => {
    const { user, frame } = renderCommandCentre()
    await user.click(buttonByText(within(frame()).getByRole("group", { name: "Approval required" }), "Allow"))
    expect(within(frame()).queryByRole("group", { name: "Approval required" })).toBeNull()
    expect(within(frame()).getByText(/“SWE-bench” is in Research/)).toBeTruthy()
    await user.click(within(frame()).getByRole("button", { name: "Workspace" }))
    expect(within(frame()).getByText("SWE-bench")).toBeTruthy()
  })

  it("Deny changes nothing and says so", async () => {
    const { user, frame } = renderCommandCentre()
    await user.click(buttonByText(within(frame()).getByRole("group", { name: "Approval required" }), "Deny"))
    expect(within(frame()).getByText(/I won't create it/)).toBeTruthy()
    await user.click(within(frame()).getByRole("button", { name: "Workspace" }))
    expect(within(frame()).queryByText("SWE-bench")).toBeNull()
  })

  it("sends a composer message and shows the demo's honest reply", async () => {
    const { user, frame } = renderCommandCentre()
    await user.click(buttonByText(within(frame()).getByRole("group", { name: "Approval required" }), "Deny"))
    const box = within(frame()).getAllByRole("textbox").find((el) => el.tagName === "TEXTAREA")!
    await user.type(box, "What else is in Research?{Enter}")
    expect(within(frame()).getByText("What else is in Research?")).toBeTruthy()
    expect(await within(frame()).findByText(/no agent is connected/, {}, { timeout: DEMO_REPLY_DELAY_MS + 2000 })).toBeTruthy()
  })

  it("switches sessions from the list", async () => {
    const { user, frame } = renderCommandCentre()
    await user.click(within(frame()).getByRole("button", { name: /Group Product Ideas by theme/ }))
    expect(within(frame()).getByRole("heading", { name: "Group Product Ideas by theme" })).toBeTruthy()
    expect(within(frame()).queryByRole("group", { name: "Approval required" })).toBeNull()
  })

  it("switches to an agent's latest session from the roster", async () => {
    const { user, frame } = renderCommandCentre()
    await user.click(within(frame()).getByRole("button", { name: /^Gemini CLI —/ }))
    expect(within(frame()).getByRole("heading", { name: "Group Product Ideas by theme" })).toBeTruthy()
  })

  it("master/detail: the back button returns to the session list", async () => {
    const { user, frame } = renderCommandCentre()
    await user.click(within(frame()).getByRole("button", { name: "All sessions" }))
    expect(within(frame()).queryByRole("heading", { name: "Summarize the SWE-bench reading list" })).toBeNull()
    expect(within(frame()).getByRole("heading", { name: "Command Centre" })).toBeTruthy()
    expect(within(frame()).getByRole("navigation", { name: "Agent sessions" })).toBeTruthy()
  })

  it("opens the context picker, selects context, and attaches it", async () => {
    const { user, frame } = renderCommandCentre({ selectedSessionId: GEMINI_SESSION })
    await user.click(within(frame()).getAllByRole("button", { name: "Attach Hubble context" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Attach Hubble context" })
    // Portalled beside the window, in the app's palette, not into <body>.
    expect(dialog.closest("[data-hubble-demo-portal]")).not.toBeNull()
    const attach = buttonByText(dialog, "Attach")
    expect((attach as HTMLButtonElement).disabled).toBe(true)
    await user.click(within(dialog).getByText("Research"))
    // The real resolver previews what will be attached.
    expect(within(dialog).getByText("Will be attached").parentElement?.textContent).toMatch(/Workspaces/)
    expect((attach as HTMLButtonElement).disabled).toBe(false)
    await user.click(attach)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(within(frame()).getAllByText(/1 workspace · 20 tabs/).length).toBeGreaterThan(0)
  })
})

describe("command palette", () => {
  it("opens from the rail's search field and runs a command", async () => {
    const { user, frame } = renderDemo()
    await user.click(within(frame()).getByRole("button", { name: "Search tabs, workspaces and commands" }))
    const input = screen.getByPlaceholderText("Search tabs, workspaces, agents and commands…")
    await user.type(input, "Open Command Centre{Enter}")
    expect(screen.queryByPlaceholderText("Search tabs, workspaces, agents and commands…")).toBeNull()
    expect(within(frame()).getByRole("navigation", { name: "Agent sessions" })).toBeTruthy()
  })

  it("opens with ⌘K / Ctrl+K pressed inside the window, and closes on Escape", async () => {
    const { user, frame } = renderDemo()
    fireEvent.keyDown(frame(), { key: "k", ctrlKey: true })
    const input = screen.getByPlaceholderText("Search tabs, workspaces, agents and commands…")
    await user.type(input, "{Escape}")
    expect(screen.queryByPlaceholderText("Search tabs, workspaces, agents and commands…")).toBeNull()
  })

  it("does not take ⌘K from the rest of the page", () => {
    renderDemo()
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })
    expect(screen.queryByPlaceholderText("Search tabs, workspaces, agents and commands…")).toBeNull()
  })
})

describe("graph", () => {
  function renderGraph() {
    const user = userEvent.setup()
    render(
      <HubbleDemoProvider init={{ view: "graph" }}>
        <DemoFrame label="Graph demo">
          <DemoGraph />
        </DemoFrame>
      </HubbleDemoProvider>
    )
    return { user, frame: () => screen.getByRole("region", { name: "Graph demo" }) }
  }

  it("opens from the rail (loaded on demand)", async () => {
    const { user, frame } = renderDemo()
    await user.click(within(frame()).getByRole("button", { name: "Graph" }))
    expect(await within(frame()).findByRole("button", { name: /Explore the graph/ }, { timeout: 5000 })).toBeTruthy()
    expect(frame().querySelector("canvas")).not.toBeNull()
  })

  it("keeps the wheel for the page until the visitor chooses the graph", async () => {
    const { user, frame } = renderGraph()
    await user.click(within(frame()).getByRole("button", { name: /Explore the graph/ }))
    expect(within(frame()).queryByRole("button", { name: /Explore the graph/ })).toBeNull()
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" })
    })
    expect(within(frame()).getByRole("button", { name: /Explore the graph/ })).toBeTruthy()
  })

  it("scopes to the current workspace and responds to the panel's controls", async () => {
    const { user, frame } = renderGraph()
    // jsdom lays out at width 0, so the panel starts closed, as it does in a narrow window.
    expect(within(frame()).getByText("20/35")).toBeTruthy()
    await user.click(within(frame()).getByRole("button", { name: "Open graph settings" }))
    const local = within(frame()).getByRole("button", { name: "Local" })
    await user.click(local)
    await user.click(within(frame()).getByRole("button", { name: "Zoom in" }))
    await user.click(within(frame()).getByRole("button", { name: "Zoom out" }))
    await user.click(within(frame()).getAllByRole("button", { name: "Fit graph" })[0])
    // Search narrows through the product's own graph search.
    await user.type(within(frame()).getByPlaceholderText("Search tabs..."), "swe-bench")
    expect(within(frame()).getAllByText(/SWE-bench/).length).toBeGreaterThan(0)
  })
})

describe("settings", () => {
  it("renders the app's settings sections, and the theme cards set the page scheme", async () => {
    const set = vi.fn()
    const { user, frame } = renderDemo({ view: "settings" }, { value: "system", set })
    expect(within(frame()).getByRole("heading", { name: "Theme" })).toBeTruthy()
    await user.click(within(frame()).getAllByRole("button").find((b) => b.textContent?.includes("Hubble Dark"))!)
    expect(set).toHaveBeenCalledWith("dark")
    await user.click(within(frame()).getAllByRole("button", { name: "Workspaces" }).find((b) => b.closest("nav[aria-label='Settings sections']"))!)
    expect(within(frame()).getByRole("heading", { name: "Workspaces" })).toBeTruthy()
    const section = within(frame()).getByRole("heading", { name: "Workspaces" }).parentElement!.parentElement!
    expect(within(section).getByText("Semester")).toBeTruthy()
    expect(within(section).getByText(/6 tabs/)).toBeTruthy()
  })

  it("lists every connector as the catalog describes it", async () => {
    const { user, frame } = renderDemo({ view: "settings", settingsSection: "agents" })
    expect(within(frame()).getByRole("heading", { name: "Agents" })).toBeTruthy()
    const codex = within(frame()).getByText("OpenAI's coding agent, over the Agent Client Protocol adapter.")
    expect(codex).toBeTruthy()
    expect(within(frame()).getAllByText("Unavailable").length).toBeGreaterThan(0)
    await user.click(within(frame()).getAllByRole("button", { name: "Shortcuts" }).find((b) => b.closest("nav[aria-label='Settings sections']"))!)
    expect(within(frame()).getByRole("heading", { name: "Shortcuts" })).toBeTruthy()
  })
})

describe("destinations the demo cannot show", () => {
  it("says so in the app's empty-state language instead of faking them", async () => {
    const { user, frame } = renderDemo()
    await user.click(within(frame()).getByRole("button", { name: "History Dump" }))
    expect(within(frame()).getByText("Not part of the demo")).toBeTruthy()
    await user.click(within(frame()).getByRole("button", { name: "Back" }))
    expect(within(frame()).getByText("AI Research")).toBeTruthy()
  })
})
