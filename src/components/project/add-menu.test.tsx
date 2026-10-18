import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AddMenu } from "./add-menu"

const sendBrowserCommand = vi.hoisted(() => vi.fn())
vi.mock("@/lib/browser/bridge", () => ({ sendBrowserCommand }))

const tab = (tabId: number, url: string, title: string) => ({ tabId, windowId: 1, url, title, pinned: false, active: false, index: tabId })

function renderMenu(overrides: Partial<Parameters<typeof AddMenu>[0]> = {}) {
  const props = {
    subjectName: "History HL",
    onAdd: vi.fn((inputs: { url: string }[]) => inputs.map((input) => ({ status: "added" as const, input, tabId: "x", kind: "webpage" as const }))),
    onOpenLink: vi.fn(),
    ...overrides,
  }
  render(<AddMenu {...props} />)
  return props
}

async function openBrowserTabs(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Add/ }))
  await user.click(await screen.findByRole("menuitem", { name: "Browser tabs" }))
  return screen.findByRole("dialog", { name: "Add browser tabs" })
}

beforeEach(() => sendBrowserCommand.mockReset())

describe("+ Add", () => {
  it("offers only what is useful: Browser tabs and Link", async () => {
    const user = userEvent.setup()
    const props = renderMenu()
    await user.click(screen.getByRole("button", { name: /^Add/ }))
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["Browser tabs", "Link"])
    await user.click(screen.getByRole("menuitem", { name: "Link" }))
    expect(props.onOpenLink).toHaveBeenCalledOnce()
  })

  it("lists the web pages open in Chrome — not Hubble itself, not chrome:// pages, no repeats — and adds the ones ticked", async () => {
    sendBrowserCommand.mockResolvedValue({
      id: "1",
      ok: true,
      result: {
        tabs: [
          tab(1, "https://en.wikipedia.org/wiki/Treaty_of_Versailles", "Treaty of Versailles"),
          tab(2, `${window.location.origin}/`, "Hubble"),
          tab(3, "chrome://settings", "Settings"),
          tab(4, "https://www.britannica.com/event/World-War-I", "World War I"),
          tab(5, "https://en.wikipedia.org/wiki/Treaty_of_Versailles", "Treaty of Versailles (again)"),
        ],
      },
    })
    const user = userEvent.setup()
    const props = renderMenu()
    const dialog = within(await openBrowserTabs(user))

    expect(sendBrowserCommand).toHaveBeenCalledWith("list_browser_tabs", {}, expect.anything())
    const list = within(await dialog.findByRole("list", { name: "Open tabs" }))
    const items = list.getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain("Treaty of Versailles")
    expect(items[0]!.textContent).not.toContain("(again)")
    expect(items[1]!.textContent).toContain("World War I")

    await user.click(dialog.getByRole("button", { name: "Select all" }))
    await user.click(dialog.getByRole("button", { name: "Add 2 tabs" }))
    expect(props.onAdd).toHaveBeenCalledWith([
      { url: "https://en.wikipedia.org/wiki/Treaty_of_Versailles", title: "Treaty of Versailles" },
      { url: "https://www.britannica.com/event/World-War-I", title: "World War I" },
    ])
  })

  it("without the extension, says how tabs get here in one line, and takes pasted links", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "1", ok: false, error: "Timed out waiting for the browser extension to respond." })
    const user = userEvent.setup()
    const props = renderMenu()
    const dialog = within(await openBrowserTabs(user))

    expect(await dialog.findByText(/Add tabs straight from Chrome with/)).toBeTruthy()
    // Never the raw bridge error.
    expect(dialog.queryByText(/Timed out/)).toBeNull()
    await user.type(dialog.getByLabelText("Or paste links"), "https://a.example{Enter}https://b.example")
    await user.click(dialog.getByRole("button", { name: "Add" }))
    expect(props.onAdd).toHaveBeenCalledWith([{ url: "https://a.example" }, { url: "https://b.example" }])
  })

  it("with Hubble for Chrome present but unreachable here, names the right-click for this project", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "1", ok: false, error: "extension-unreachable" })
    const user = userEvent.setup()
    renderMenu({ quickAdd: { shortcut: "Alt+Shift+H" } })
    const dialog = within(await openBrowserTabs(user))
    expect((await dialog.findByText(/right-click a tab/)).textContent).toContain("Add to History HL")
  })
})

describe("+ Add in Hubble Desktop", () => {
  function setDesktop(on: boolean) {
    if (on) (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    else delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  }

  it("names the extension's desktop menu item, not the website's quick add", async () => {
    setDesktop(true)
    try {
      sendBrowserCommand.mockResolvedValue({ id: "1", ok: false, error: "desktop-unreachable" })
      const user = userEvent.setup()
      renderMenu({ quickAdd: { shortcut: "Alt+Shift+S" } })
      const dialog = within(await openBrowserTabs(user))

      expect(await dialog.findByText("Hubble → Add to Hubble Desktop")).toBeTruthy()
      expect(dialog.queryByText(/Add to History HL/)).toBeNull()
      expect(dialog.getByRole("link", { name: "Hubble for Chrome" })).toBeTruthy()
      // Pasting still works here.
      expect(dialog.getByRole("textbox")).toBeTruthy()
    } finally {
      setDesktop(false)
    }
  })
})
