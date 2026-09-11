import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const fetchBrowserHistoryMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/browser/history", () => ({ fetchBrowserHistory: fetchBrowserHistoryMock }))

const { HistoryDumpView } = await import("./history-dump-view")
import type { Tab } from "@/lib/tabs/types"

afterEach(() => {
  fetchBrowserHistoryMock.mockReset()
})

function makeTab(over: Partial<Tab> & { id: string; normalizedUrl: string }): Tab {
  return { url: over.normalizedUrl, domain: "example.com", ...over }
}

const NOW = Date.now()

const FREQUENT_ITEM = {
  url: "https://en.wikipedia.org/wiki/Tab",
  title: "Tab (interface) — a long, meaningful title",
  lastVisitTime: NOW,
  visitCount: 8,
  historyItemId: "1",
}
const WEAK_ITEM = {
  url: "https://example.com/random-old-page",
  title: "x",
  lastVisitTime: NOW - 25 * 24 * 60 * 60 * 1000,
  visitCount: 1,
  historyItemId: "2",
}
const ALREADY_SAVED_ITEM = {
  url: "https://existing.example/saved",
  title: "Already saved page",
  lastVisitTime: NOW,
  visitCount: 3,
  historyItemId: "3",
}

async function renderAndScan(items: typeof FREQUENT_ITEM[], workspaceTabs: Tab[] = []) {
  fetchBrowserHistoryMock.mockResolvedValue({ ok: true, items })
  const onDump = vi.fn()
  const onClose = vi.fn()
  const user = userEvent.setup()
  render(<HistoryDumpView tabs={workspaceTabs} onClose={onClose} onDump={onDump} />)

  await user.click(screen.getByRole("button", { name: "Scan History" }))
  await waitFor(() => expect(fetchBrowserHistoryMock).toHaveBeenCalled())

  return { onDump, onClose, user }
}

describe("HistoryDumpView — setup stage", () => {
  it("shows the scan setup with the default time range and does not scan until asked", () => {
    render(<HistoryDumpView tabs={[]} onClose={vi.fn()} onDump={vi.fn()} />)
    expect(screen.getByText("Last 7 days")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Scan History" })).toBeTruthy()
    expect(fetchBrowserHistoryMock).not.toHaveBeenCalled()
  })

  it("closes the view via the back button", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<HistoryDumpView tabs={[]} onClose={onClose} onDump={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe("HistoryDumpView — review stage", () => {
  it("groups a strong candidate as high confidence and a weak one as other", async () => {
    await renderAndScan([FREQUENT_ITEM, WEAK_ITEM])

    expect(await screen.findByText("HIGH CONFIDENCE")).toBeTruthy()
    expect(screen.getByText("OTHER POTENTIAL TABS")).toBeTruthy()
    expect(screen.getByText(/Tab \(interface\)/)).toBeTruthy()
  })

  it("filters out browser-internal noise before it ever reaches review", async () => {
    await renderAndScan([FREQUENT_ITEM, { ...WEAK_ITEM, url: "chrome://settings", title: "Settings" }])
    expect(screen.queryByText("Settings")).toBeNull()
  })

  it("flags a candidate already in the workspace and keeps it unselectable", async () => {
    const existing = makeTab({ id: "existing-1", normalizedUrl: "https://existing.example/saved" })
    await renderAndScan([FREQUENT_ITEM, ALREADY_SAVED_ITEM], [existing])

    await userEvent.setup().click(screen.getByRole("button", { name: /Already in TabDump/ }))
    expect(await screen.findByText("Already saved page")).toBeTruthy()
    expect(screen.queryByRole("checkbox", { name: /Select existing\.example/ })).toBeNull()
  })

  it("updates the selected count as candidates are checked and unchecked", async () => {
    const { user } = await renderAndScan([FREQUENT_ITEM])
    expect(await screen.findByText("0 tabs selected")).toBeTruthy()

    await user.click(screen.getByRole("checkbox", { name: "Select en.wikipedia.org" }))
    expect(screen.getByText("1 tab selected")).toBeTruthy()

    await user.click(screen.getByRole("checkbox", { name: "Select en.wikipedia.org" }))
    expect(screen.getByText("0 tabs selected")).toBeTruthy()
  })

  it("disables the dump button when nothing is selected, and enables it once something is", async () => {
    const { user } = await renderAndScan([FREQUENT_ITEM])
    const dumpButton = () => screen.getByRole("button", { name: /Dump \d+ tabs?/ })

    expect(dumpButton()).toHaveProperty("disabled", true)
    await user.click(screen.getByRole("checkbox", { name: "Select en.wikipedia.org" }))
    expect(dumpButton()).toHaveProperty("disabled", false)
  })

  it("Select suggested only selects suggested-tier candidates", async () => {
    const { user } = await renderAndScan([FREQUENT_ITEM, WEAK_ITEM])
    await user.click(screen.getByRole("button", { name: "Select suggested" }))
    expect(screen.getByText("1 tab selected")).toBeTruthy()
  })

  it("Select all selects every reviewable candidate, and Deselect all clears the selection", async () => {
    const { user } = await renderAndScan([FREQUENT_ITEM, WEAK_ITEM])
    await user.click(screen.getByRole("button", { name: "Select all" }))
    expect(screen.getByText("2 tabs selected")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Deselect all" }))
    expect(screen.getByText("0 tabs selected")).toBeTruthy()
  })

  it("calls onDump with history-sourced entries for exactly the selected candidates", async () => {
    const { user, onDump } = await renderAndScan([FREQUENT_ITEM, WEAK_ITEM])
    await user.click(screen.getByRole("button", { name: "Select suggested" }))
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }))

    expect(onDump).toHaveBeenCalledWith([
      expect.objectContaining({
        url: FREQUENT_ITEM.url,
        source: "history",
        historyVisitCount: FREQUENT_ITEM.visitCount,
        historyLastVisitedAt: FREQUENT_ITEM.lastVisitTime,
      }),
    ])
  })
})

/**
 * The reported bug, end to end through the real pipeline (scan → candidates
 * → tiering → Select suggested): one afternoon of research leaves behind a
 * search and its variation, an article and its tracking-link twin, and a
 * video watched twice. Selecting all of it fills the workspace with
 * redundant objects; what should land is the resources that browsing
 * produced.
 */
describe("HistoryDumpView — Select suggested on a real research session", () => {
  const SESSION = [
    { url: "https://find.example/search?q=best+ib+economics+price+mechanism+notes", title: "best ib economics price mechanism notes — Search", lastVisitTime: NOW, visitCount: 3, historyItemId: "s1" },
    { url: "https://find.example/search?q=ib+economics+price+mechanism", title: "ib economics price mechanism — Search", lastVisitTime: NOW, visitCount: 3, historyItemId: "s2" },
    { url: "https://en.wikipedia.org/wiki/Price_mechanism", title: "Price mechanism — Wikipedia", lastVisitTime: NOW, visitCount: 4, historyItemId: "w1" },
    { url: "https://en.wikipedia.org/wiki/Price_mechanism#Functions", title: "Price mechanism — Wikipedia", lastVisitTime: NOW, visitCount: 2, historyItemId: "w2" },
    { url: "https://econblog.example/price-mechanism-explained", title: "Price Mechanism Explained", lastVisitTime: NOW, visitCount: 3, historyItemId: "a1" },
    { url: "https://econblog.example/price-mechanism-explained?utm_source=google", title: "Price Mechanism Explained", lastVisitTime: NOW, visitCount: 2, historyItemId: "a2" },
    { url: "https://www.youtube.com/watch?v=AAA", title: "Price Mechanism Explained — Lecture", lastVisitTime: NOW, visitCount: 3, historyItemId: "y1" },
    { url: "https://www.youtube.com/watch?v=AAA&t=120", title: "Price Mechanism Explained — Lecture", lastVisitTime: NOW, visitCount: 2, historyItemId: "y2" },
    { url: "https://econblog.example/demand-and-supply", title: "Demand And Supply, From First Principles", lastVisitTime: NOW, visitCount: 3, historyItemId: "a3" },
    { url: "https://textbook.example/economics/markets", title: "Markets — Official Economics Textbook", lastVisitTime: NOW, visitCount: 4, historyItemId: "t1" },
  ]

  it("selects one representative per resource instead of every step of the session", async () => {
    const { user, onDump } = await renderAndScan(SESSION)
    await user.click(screen.getByRole("button", { name: "Select suggested" }))
    await user.click(screen.getByRole("button", { name: /Dump \d+ tabs?/ }))

    const dumped: { url: string }[] = onDump.mock.calls[0][0]
    const domains = dumped.map((entry) => new URL(entry.url).hostname)

    // One search, one Wikipedia article, one blog article, one video — plus
    // the two genuinely distinct extra resources.
    expect(dumped).toHaveLength(6)
    expect(domains.filter((d) => d === "find.example")).toHaveLength(1)
    expect(domains.filter((d) => d === "en.wikipedia.org")).toHaveLength(1)
    expect(domains.filter((d) => d === "www.youtube.com")).toHaveLength(1)
    // Two different articles on one blog both survive: same domain, same
    // topic, different resources.
    expect(domains.filter((d) => d === "econblog.example")).toHaveLength(2)
    expect(domains).toContain("textbook.example")
  })

  it("explains on the row why a near-duplicate was passed over, and still lets it be selected by hand", async () => {
    const { user } = await renderAndScan(SESSION)
    await user.click(screen.getByRole("button", { name: "Select suggested" }))

    const before = screen.getByText(/\d+ tabs selected/).textContent
    expect(screen.getAllByText("Similar search to another selected tab").length).toBeGreaterThan(0)

    await user.click(screen.getAllByRole("checkbox", { name: "Select find.example" })[1])
    expect(screen.getByText(/\d+ tabs selected/).textContent).not.toBe(before)
  })

  it("does not suggest a resource the workspace already holds under another URL variant", async () => {
    const saved = makeTab({ id: "saved-1", normalizedUrl: "https://www.youtube.com/watch?v=AAA" })
    const { user, onDump } = await renderAndScan(SESSION, [saved])

    await user.click(screen.getByRole("button", { name: "Select suggested" }))
    await user.click(screen.getByRole("button", { name: /Dump \d+ tabs?/ }))

    const dumped: { url: string }[] = onDump.mock.calls[0][0]
    expect(dumped.some((entry) => entry.url.includes("youtube.com"))).toBe(false)
  })

  it("still selects every candidate when the user explicitly asks for all of them", async () => {
    const { user } = await renderAndScan(SESSION)
    await user.click(screen.getByRole("button", { name: "Select all" }))
    // Seven resources survive the pipeline: the ten entries minus the three
    // pairs that are literally one page under two URLs (the Wikipedia
    // fragment, the tracking link, the timestamped video).
    expect(screen.getByText("7 tabs selected")).toBeTruthy()
  })
})

describe("HistoryDumpView — empty states", () => {
  it("shows a 'no history found' empty state when nothing was scanned at all", async () => {
    await renderAndScan([])
    expect(await screen.findByText("No history found")).toBeTruthy()
  })

  it("shows a 'nothing worth surfacing' empty state when everything scanned was filtered as noise", async () => {
    await renderAndScan([{ ...WEAK_ITEM, url: "chrome://settings", title: "Settings" }])
    expect(await screen.findByText("Nothing worth surfacing yet")).toBeTruthy()
  })

  it("shows an 'already covered' empty state when every surfaced page is already saved", async () => {
    const existing = makeTab({ id: "existing-1", normalizedUrl: "https://existing.example/saved" })
    await renderAndScan([ALREADY_SAVED_ITEM], [existing])
    expect(await screen.findByText("You're already covered")).toBeTruthy()
  })
})

describe("HistoryDumpView — extension errors", () => {
  it("shows an extension-not-detected message and lets the user retry", async () => {
    fetchBrowserHistoryMock.mockResolvedValue({ ok: false, reason: "not-connected" })
    const user = userEvent.setup()
    render(<HistoryDumpView tabs={[]} onClose={vi.fn()} onDump={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Scan History" }))
    expect(await screen.findByText("TabDump extension not detected.")).toBeTruthy()

    fetchBrowserHistoryMock.mockResolvedValue({ ok: true, items: [FREQUENT_ITEM] })
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("HIGH CONFIDENCE")).toBeTruthy()
  })

  it("shows a permission/error message distinct from the not-connected case", async () => {
    fetchBrowserHistoryMock.mockResolvedValue({ ok: false, reason: "error", error: "Browser command failed." })
    const user = userEvent.setup()
    render(<HistoryDumpView tabs={[]} onClose={vi.fn()} onDump={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Scan History" }))
    expect(await screen.findByText("History access isn't available.")).toBeTruthy()
  })
})
