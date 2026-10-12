import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OpenTabsOrganize } from "./open-tabs-organize"
import type { SmartProposal } from "@/lib/organize/smart/types"
import type { Workspace } from "@/lib/workspace/types"

const sendBrowserCommand = vi.hoisted(() => vi.fn())
vi.mock("@/lib/browser/bridge", () => ({ sendBrowserCommand }))
const desktop = vi.hoisted(() => ({ value: false }))
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => desktop.value }))

const tab = (tabId: number, url: string, title: string, windowId = 1) => ({ tabId, windowId, url, title, pinned: false, active: false, index: tabId })

/** What Hubble for Chrome answers: the tabs, and the windows (so private ones can be left out). */
function chromeHas(tabs: ReturnType<typeof tab>[], windows = [{ windowId: 1, focused: true, incognito: false, type: "normal", tabIds: [] as number[] }]) {
  sendBrowserCommand.mockImplementation(async (action: string) =>
    action === "list_browser_tabs" ? { id: "t", ok: true, result: { tabs } } : action === "list_browser_windows" ? { id: "w", ok: true, result: { windows } } : { id: "x", ok: false, error: "unexpected" }
  )
}

const OPEN_TABS = [
  tab(1, "https://a.example/projectile", "Projectile motion lab"),
  tab(2, "https://b.example/projectile-calc", "Projectile motion calculator"),
  tab(3, "https://c.example/frev", "French Revolution causes"),
  tab(4, "https://d.example/frev2", "French Revolution timeline"),
  tab(5, "https://d.example/frev2?utm_source=newsletter", "French Revolution timeline"),
  tab(6, "https://e.example/misc", "Weekend plans"),
  tab(7, "https://saved.example/page", "Already saved page"),
  tab(8, "chrome://newtab/", "New Tab"),
]

const history: Workspace = {
  id: "history",
  name: "History",
  tabs: [
    {
      id: "s1",
      url: "https://saved.example/page",
      normalizedUrl: "https://saved.example/page",
      domain: "saved.example",
      resource: { kind: "webpage", origin: "manual", status: "ready", addedAt: 1, updatedAt: 1 },
    },
  ],
  createdAt: 1,
  updatedAt: 1,
}

function renderOrganize(overrides: { open?: boolean } = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    workspaces: [history],
    subjects: [history],
    onApply: vi.fn<(proposal: SmartProposal) => void>(),
    ...overrides,
  }
  render(<OpenTabsOrganize {...props} />)
  return props
}

function groupNamed(name: string) {
  const input = screen.getAllByRole("textbox", { name: "Group name" }).find((element) => (element as HTMLInputElement).value === name)
  if (!input) throw new Error(`no group named ${name}`)
  return input.closest("[data-smart-group]") as HTMLElement
}

beforeEach(() => {
  sendBrowserCommand.mockReset()
  desktop.value = false
})

describe("Organize open tabs", () => {
  it("reads Chrome's tabs, proposes groups, and shows what it is unsure of, duplicates and what it left out", async () => {
    chromeHas(OPEN_TABS)
    renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    expect(sendBrowserCommand).toHaveBeenCalledWith("list_browser_tabs", {}, expect.anything())

    await within(dialog).findByRole("list", { name: "Suggested groups" })
    const groups = within(dialog).getAllByRole("textbox", { name: "Group name" }).map((input) => (input as HTMLInputElement).value)
    expect(groups).toEqual(["French Revolution", "Projectile motion"])
    expect(within(groupNamed("French Revolution")).getByText("3 tabs")).toBeTruthy()
    expect(within(groupNamed("Projectile motion")).getByText("Projectile motion lab")).toBeTruthy()
    expect(within(groupNamed("Projectile motion")).getAllByText("a.example").length).toBeGreaterThan(0)

    expect(within(dialog).getByRole("heading", { name: /Not sure/ })).toBeTruthy()
    expect(within(dialog).getByText("Weekend plans")).toBeTruthy()
    expect(within(dialog).getByRole("heading", { name: /Open more than once/ })).toBeTruthy()
    expect(within(dialog).getByRole("heading", { name: /Not included/ })).toBeTruthy()
    expect(within(dialog).getByText(/Already in History/)).toBeTruthy()
    expect(within(dialog).getByText(/1 browser page was skipped/)).toBeTruthy()

    // The footer says exactly what will happen: one copy of the duplicated page, two new subjects.
    expect(dialog.querySelector("[data-smart-footer]")!.textContent).toBe("Adds 4 pages to 2 subjects (2 new). 2 stay as they are.")
  })

  it("lets the person rename, move, exclude and leave tabs as they are before confirming", async () => {
    chromeHas(OPEN_TABS)
    const user = userEvent.setup()
    const props = renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    await within(dialog).findByRole("list", { name: "Suggested groups" })

    // Rename.
    const name = within(groupNamed("Projectile motion")).getByRole("textbox", { name: "Group name" })
    await user.clear(name)
    await user.type(name, "Physics IA")

    // Move "Weekend plans" into the renamed group.
    await user.click(within(dialog).getByRole("button", { name: "Move Weekend plans" }))
    await user.click(await screen.findByRole("menuitem", { name: "Physics IA" }))
    expect(within(groupNamed("Physics IA")).getByText("Weekend plans")).toBeTruthy()

    // Exclude one, leave another as it is.
    await user.click(within(dialog).getByRole("button", { name: "Move French Revolution causes" }))
    await user.click(await screen.findByRole("menuitem", { name: "Don’t include" }))
    await user.click(within(dialog).getByRole("button", { name: "Move Projectile motion calculator" }))
    await user.click(await screen.findByRole("menuitem", { name: "Leave as it is" }))

    // Send the revolution group to the existing History subject.
    await user.click(within(groupNamed("French Revolution")).getByRole("button", { name: /New subject/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Add to History" }))

    await user.click(within(dialog).getByRole("button", { name: /^Organize \d+ pages?$/ }))
    expect(props.onApply).toHaveBeenCalledOnce()
    const proposal = props.onApply.mock.calls[0]![0]
    const byId = new Map(proposal.items.map((item) => [item.id, item.title]))
    expect(proposal.groups.map((group) => [group.name, group.itemIds.map((id) => byId.get(id)), group.destination])).toEqual([
      ["French Revolution", ["French Revolution timeline", "French Revolution timeline"], { kind: "subject", workspaceId: "history" }],
      ["Physics IA", ["Projectile motion lab", "Weekend plans"], { kind: "new-subject" }],
    ])
    expect(proposal.review.map((id) => byId.get(id))).toEqual(["Projectile motion calculator"])
    expect(proposal.excluded.map((entry) => [byId.get(entry.itemId), entry.reason])).toEqual([
      ["Already saved page", "already-saved"],
      ["French Revolution causes", "you"],
    ])
  })

  it("will not confirm while a group has no name", async () => {
    chromeHas(OPEN_TABS)
    const user = userEvent.setup()
    renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    await within(dialog).findByRole("list", { name: "Suggested groups" })
    await user.clear(within(groupNamed("Projectile motion")).getByRole("textbox", { name: "Group name" }))
    expect(within(dialog).getByText("Give every group a name to continue.")).toBeTruthy()
    expect((within(dialog).getByRole("button", { name: /^Organize/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("cancelling changes nothing", async () => {
    chromeHas(OPEN_TABS)
    const user = userEvent.setup()
    const props = renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    await within(dialog).findByRole("list", { name: "Suggested groups" })
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
    expect(props.onApply).not.toHaveBeenCalled()
  })

  it("says plainly when Hubble for Chrome is not there, and can try again", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "1", ok: false, error: "timeout" })
    const user = userEvent.setup()
    renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    expect(await within(dialog).findByText("Hubble for Chrome isn't connected")).toBeTruthy()
    expect(within(dialog).getByRole("link", { name: "Hubble for Chrome" })).toBeTruthy()

    chromeHas([tab(9, "chrome://newtab/", "New Tab")])
    await user.click(within(dialog).getByRole("button", { name: "Try again" }))
    expect(await screen.findByText(/No web pages are open in Chrome right now/)).toBeTruthy()
  })

  it("on Hubble Desktop, says it cannot see Chrome's tabs instead of trying", async () => {
    desktop.value = true
    renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    expect(within(dialog).getByText("Hubble Desktop can't see your Chrome tabs")).toBeTruthy()
    expect(sendBrowserCommand).not.toHaveBeenCalled()
  })

  it("says so when everything open is already saved, and offers nothing to confirm", async () => {
    chromeHas([tab(7, "https://saved.example/page", "Already saved page")])
    renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    expect(await within(dialog).findByText("Everything open is already saved in Hubble.")).toBeTruthy()
    expect(within(dialog).getByText("Nothing will change.")).toBeTruthy()
    expect((within(dialog).getByRole("button", { name: "Organize" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("never reads tabs in private windows, and says it left them alone", async () => {
    chromeHas(
      [tab(1, "https://a.example/projectile", "Projectile motion lab"), tab(2, "https://b.example/projectile-calc", "Projectile motion calculator"), tab(3, "https://secret.example/private", "Private projectile motion search", 2)],
      [
        { windowId: 1, focused: true, incognito: false, type: "normal", tabIds: [1, 2] },
        { windowId: 2, focused: false, incognito: true, type: "normal", tabIds: [3] },
      ]
    )
    renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    await within(dialog).findByRole("list", { name: "Suggested groups" })
    expect(within(dialog).queryByText(/Private projectile/)).toBeNull()
    expect(within(dialog).getByText(/1 tab in private windows was left alone/)).toBeTruthy()
  })

  it("reads nothing if it cannot tell which windows are private", async () => {
    sendBrowserCommand.mockImplementation(async (action: string) =>
      action === "list_browser_tabs" ? { id: "t", ok: true, result: { tabs: OPEN_TABS } } : { id: "w", ok: false, error: "timeout" }
    )
    renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    expect(await within(dialog).findByText(/Couldn't check which of your Chrome windows are private/)).toBeTruthy()
    expect(within(dialog).queryByRole("list", { name: "Suggested groups" })).toBeNull()
  })

  it("offers no copies toggle for a duplicate that is already saved — it would do nothing", async () => {
    chromeHas([
      tab(7, "https://saved.example/page", "Already saved page"),
      tab(8, "https://saved.example/page#part-2", "Already saved page"),
      tab(1, "https://a.example/projectile", "Projectile motion lab"),
      tab(2, "https://b.example/projectile-calc", "Projectile motion calculator"),
      tab(3, "https://b.example/projectile-calc?utm_source=x", "Projectile motion calculator"),
    ])
    const user = userEvent.setup()
    renderOrganize()
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    await within(dialog).findByRole("list", { name: "Suggested groups" })
    const duplicates = within(dialog).getByRole("heading", { name: /Open more than once/ }).closest("section") as HTMLElement
    const rows = within(duplicates).getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    const saved = rows.find((row) => row.textContent?.includes("Already saved page"))!
    expect(saved.textContent).toContain("already in History")
    expect(within(saved).queryByRole("button")).toBeNull()
    // The live set toggles both ways.
    const live = rows.find((row) => row.textContent?.includes("Projectile motion calculator"))!
    await user.click(within(live).getByRole("button", { name: "Leave out copies" }))
    expect(within(live).getByRole("button", { name: "Include copies" })).toBeTruthy()
    await user.click(within(live).getByRole("button", { name: "Include copies" }))
    expect(within(live).getByRole("button", { name: "Leave out copies" })).toBeTruthy()
  })

  it("renders nothing while closed", () => {
    renderOrganize({ open: false })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(sendBrowserCommand).not.toHaveBeenCalled()
  })
})
