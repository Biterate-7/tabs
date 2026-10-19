import { describe, expect, it } from "vitest"
import { capturableWindows, suggestSessionName, tabsOfWindows } from "./capture"
import type { BrowserTabInfo, BrowserWindowInfo } from "@/lib/browser/protocol"

const SELF = "https://hubble-hq.vercel.app"

function tab(over: Partial<BrowserTabInfo>): BrowserTabInfo {
  return { tabId: 1, windowId: 1, url: "https://example.com/", title: "Example", pinned: false, active: false, index: 0, ...over }
}

function win(over: Partial<BrowserWindowInfo>): BrowserWindowInfo {
  return { windowId: 1, focused: false, incognito: false, type: "normal", tabIds: [], ...over }
}

describe("capturableWindows", () => {
  const tabs = [
    tab({ tabId: 3, windowId: 1, index: 2, url: "https://c.example/", title: "C", active: true }),
    tab({ tabId: 1, windowId: 1, index: 0, url: "https://a.example/", title: "A", pinned: true, favIconUrl: "https://a.example/i.png" }),
    tab({ tabId: 2, windowId: 1, index: 1, url: "chrome://settings", title: "Settings" }),
    tab({ tabId: 4, windowId: 1, index: 3, url: `${SELF}/`, title: "Hubble" }),
    tab({ tabId: 5, windowId: 2, index: 0, url: "https://other.example/", title: "Other" }),
    tab({ tabId: 6, windowId: 9, index: 0, url: "https://private.example/", title: "Private" }),
  ]
  const windows = [win({ windowId: 2 }), win({ windowId: 1, focused: true }), win({ windowId: 9, incognito: true })]

  it("captures the focused window first, in tab-strip order, leaving out browser pages and Hubble itself", () => {
    const result = capturableWindows(tabs, windows, SELF)
    expect(result.map((entry) => entry.windowId)).toEqual([1, 2])
    expect(result[0].tabs).toEqual([
      { url: "https://a.example/", title: "A", favicon: "https://a.example/i.png", pinned: true },
      { url: "https://c.example/", title: "C" },
    ])
    expect(result[0].skipped).toBe(1)
    expect(result[0].label).toBe("C")
  })

  it("never offers a private window's tabs", () => {
    const result = capturableWindows(tabs, windows, SELF)
    expect(result.some((entry) => entry.windowId === 9)).toBe(false)
    expect(result.flatMap((entry) => entry.tabs).some((entry) => entry.url.includes("private"))).toBe(false)
  })

  it("adds tabs window by window for the windows chosen", () => {
    const result = capturableWindows(tabs, windows, SELF)
    expect(tabsOfWindows(result, new Set([1])).tabs.map((entry) => entry.url)).toEqual(["https://a.example/", "https://c.example/"])
    const both = tabsOfWindows(result, new Set([1, 2]))
    expect(both.tabs.map((entry) => entry.url)).toEqual(["https://a.example/", "https://c.example/", "https://other.example/"])
    expect(both.skipped).toBe(1)
  })
})

describe("suggestSessionName", () => {
  const now = new Date(2026, 9, 19, 14, 5).getTime()
  it("uses the project's name when one was chosen, and the day", () => {
    expect(suggestSessionName({ projectName: "History IA", now })).toMatch(/^History IA — 19 Oct$/)
    expect(suggestSessionName({ now })).toMatch(/^Session — 19 Oct$/)
  })
})
