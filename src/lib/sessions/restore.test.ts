import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sendBrowserCommand = vi.fn()
vi.mock("@/lib/browser/bridge", () => ({ sendBrowserCommand: (...args: unknown[]) => sendBrowserCommand(...args) }))
const openExternal = vi.fn<(url: string) => Promise<void>>()
vi.mock("@/lib/platform", () => ({ openExternal: (url: string) => openExternal(url) }))

import { DESKTOP_UNREACHABLE } from "@/lib/browser/protocol"
import { describeRestore } from "./messages"
import { __resetRestoreForTests, restoreTabs } from "./restore"

const tabs = [{ url: "https://a.example/" }, { url: "https://b.example/", pinned: true }, { url: "https://c.example/" }]

beforeEach(() => {
  sendBrowserCommand.mockReset()
  __resetRestoreForTests()
})

afterEach(() => __resetRestoreForTests())

describe("restoreTabs", () => {
  it("asks the extension to open the tabs, in order, with one request id", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "x", ok: true, result: { windowId: 7, opened: 3, failed: [] } })
    const outcome = await restoreTabs(tabs, { connected: true })
    expect(outcome).toEqual({ kind: "opened", opened: 3, failed: [] })
    expect(sendBrowserCommand).toHaveBeenCalledTimes(1)
    const [action, args] = sendBrowserCommand.mock.calls[0]
    expect(action).toBe("open_session")
    expect(args.tabs).toEqual([{ url: "https://a.example/" }, { url: "https://b.example/", pinned: true }, { url: "https://c.example/" }])
    expect(typeof args.requestId).toBe("string")
  })

  it("reports a partial restore honestly", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "x", ok: true, result: { opened: 2, failed: [{ index: 1, url: "https://b.example/", error: "blocked" }] } })
    const outcome = await restoreTabs(tabs, { connected: true })
    expect(outcome).toEqual({ kind: "opened", opened: 2, failed: [{ url: "https://b.example/", error: "blocked" }] })
    expect(describeRestore(outcome, 3)).toMatchObject({ tone: "warning", title: "Opened 2 of 3 tabs" })
  })

  it("never sends invalid addresses", async () => {
    expect(await restoreTabs([{ url: "javascript:alert(1)" }, { url: "chrome://settings" }], { connected: true })).toEqual({ kind: "empty" })
    expect(sendBrowserCommand).not.toHaveBeenCalled()
  })

  it("refuses a second launch while the first is still running", async () => {
    let finish: (value: unknown) => void = () => {}
    sendBrowserCommand.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const first = restoreTabs(tabs, { connected: true })
    expect(await restoreTabs(tabs, { connected: true })).toEqual({ kind: "busy" })
    finish({ id: "x", ok: true, result: { opened: 3, failed: [] } })
    expect((await first).kind).toBe("opened")
    expect(sendBrowserCommand).toHaveBeenCalledTimes(1)
  })

  it("says the extension isn't there when it never answered", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "x", ok: false, error: "Timed out waiting for the browser extension to respond." })
    expect(await restoreTabs(tabs, { connected: false })).toEqual({ kind: "no-extension" })
    expect(sendBrowserCommand.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(3000)
  })

  it("does not claim failure when a connected extension is merely slow", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "x", ok: false, error: "Timed out waiting for the browser extension to respond." })
    const outcome = await restoreTabs(tabs, { connected: true })
    expect(outcome).toEqual({ kind: "timeout" })
    expect(describeRestore(outcome, 3).title).toMatch(/hasn't confirmed/)
  })

  it("opens the tabs in the default browser inside Hubble Desktop, in order, and says which failed", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "x", ok: false, error: DESKTOP_UNREACHABLE })
    openExternal.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Refusing to open")).mockResolvedValueOnce(undefined)
    const outcome = await restoreTabs(tabs, { connected: false })
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual(tabs.map((tab) => tab.url))
    expect(outcome).toEqual({ kind: "opened", opened: 2, failed: [{ url: tabs[1]!.url, error: "Refusing to open" }], inBrowser: true })
    expect(describeRestore(outcome, 3).title).toBe("Opened 2 of 3 tabs")
    openExternal.mockResolvedValue(undefined)
    expect(describeRestore(await restoreTabs(tabs, { connected: false }), 3).title).toBe("Opened 3 tabs in your browser")
  })

  it("falls back to open_tabs on an extension that predates open_session", async () => {
    sendBrowserCommand
      .mockResolvedValueOnce({ id: "x", ok: false, error: 'Unknown or disallowed browser action "open_session".' })
      .mockResolvedValueOnce({ id: "y", ok: true, result: { opened: [{}, {}, {}], failed: [] } })
    expect(await restoreTabs(tabs, { connected: true })).toEqual({ kind: "opened", opened: 3, failed: [] })
    expect(sendBrowserCommand.mock.calls[1][0]).toBe("open_tabs")
    expect(sendBrowserCommand.mock.calls[1][1]).toEqual({ urls: tabs.map((tab) => tab.url), newWindow: true })
  })

  it("asks for an update rather than open part of a large session on an old extension", async () => {
    sendBrowserCommand.mockResolvedValueOnce({ id: "x", ok: false, error: 'Unknown or disallowed browser action "open_session".' })
    const many = Array.from({ length: 51 }, (_, i) => ({ url: `https://example.com/${i}` }))
    expect(await restoreTabs(many, { connected: true })).toEqual({ kind: "outdated" })
    expect(sendBrowserCommand).toHaveBeenCalledTimes(1)
  })
})
