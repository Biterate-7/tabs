import { afterEach, describe, expect, it, vi } from "vitest"

const sendBrowserCommandMock = vi.hoisted(() => vi.fn())
vi.mock("./bridge", () => ({ sendBrowserCommand: sendBrowserCommandMock }))

const { executeBrowserAction, executeBrowserRevert, executeBrowserReverts, needsBrowserExecution } = await import("./execute")

afterEach(() => {
  sendBrowserCommandMock.mockReset()
})

describe("needsBrowserExecution", () => {
  it("is true for every action that has a real chrome-side effect", () => {
    for (const name of [
      "open_url",
      "open_tabs",
      "open_workspace_in_browser",
      "close_tab",
      "close_tabs",
      "pin_tab",
      "unpin_tab",
      "bulk_pin_tabs",
      "bulk_unpin_tabs",
      "move_tabs_to_window",
      "create_browser_window",
    ]) {
      expect(needsBrowserExecution(name)).toBe(true)
    }
  })

  it("is false for read actions and the pure store mutation", () => {
    for (const name of ["list_browser_tabs", "get_active_tab", "list_browser_windows", "import_browser_tabs_to_workspace", "move_tabs"]) {
      expect(needsBrowserExecution(name)).toBe(false)
    }
  })
})

describe("executeBrowserAction", () => {
  it("open_url opens the tab and records a close_tabs revert", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { tab: { tabId: 42 }, alreadyOpen: false } })
    const result = await executeBrowserAction("open_url", { url: "https://example.com" }, undefined)
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("open_url", { url: "https://example.com" })
    expect(result).toEqual({ name: "open_url", ok: true, message: "Opened https://example.com.", revert: { kind: "close_tabs", tabIds: [42] } })
  })

  it("open_url switches to the existing tab without a revert when the url is already open", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { tab: { tabId: 42 }, alreadyOpen: true } })
    const result = await executeBrowserAction("open_url", { url: "https://example.com" }, undefined)
    expect(result.ok).toBe(true)
    expect(result.message).toContain("already open")
    expect(result.revert).toBeUndefined()
  })

  it("open_url reports failure without a revert when the extension errors", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "blocked" })
    const result = await executeBrowserAction("open_url", { url: "https://example.com" }, undefined)
    expect(result.ok).toBe(false)
    expect(result.revert).toBeUndefined()
  })

  it("open_tabs reports partial failure honestly rather than claiming full success", async () => {
    sendBrowserCommandMock.mockResolvedValue({
      id: "1",
      ok: true,
      result: { opened: [{ tabId: 1 }, { tabId: 2 }], failed: [{ url: "https://c.com", error: "blocked" }] },
    })
    const result = await executeBrowserAction("open_tabs", { urls: ["https://a.com", "https://b.com", "https://c.com"] }, undefined)
    expect(result.ok).toBe(true) // partial success is still "ok" (something happened) but...
    expect(result.message).toContain("2 of 3")
    expect(result.revert).toEqual({ kind: "close_tabs", tabIds: [1, 2] })
  })

  it("open_tabs reports full failure when nothing opened", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { opened: [], failed: [{ url: "https://a.com", error: "blocked" }] } })
    const result = await executeBrowserAction("open_tabs", { urls: ["https://a.com"] }, undefined)
    expect(result.ok).toBe(false)
    expect(result.revert).toBeUndefined()
  })

  it("open_workspace_in_browser opens the resolved urls from `data`, not `args`", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { opened: [{ tabId: 5 }], failed: [] } })
    const result = await executeBrowserAction(
      "open_workspace_in_browser",
      { workspaceId: "w1" },
      { urls: ["https://physics.example"], workspaceName: "Physics IA" }
    )
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("open_tabs", { urls: ["https://physics.example"], newWindow: false })
    expect(result.message).toContain("Physics IA")
    expect(result.revert).toEqual({ kind: "close_tabs", tabIds: [5] })
  })

  it("close_tabs reports partial failure", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { closed: [1], failed: [{ tabId: 2, error: "gone" }] } })
    const result = await executeBrowserAction("close_tabs", { tabIds: [1, 2] }, undefined)
    expect(result.ok).toBe(true)
    expect(result.message).toContain("1 of 2")
    expect(result.revert).toBeUndefined() // closing is never undoable
  })

  it("pin_tab records the previous pinned state for undo", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { previousPinned: false } })
    const result = await executeBrowserAction("pin_tab", { tabId: 7 }, undefined)
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("pin_tab", { tabId: 7, pinned: true })
    expect(result.revert).toEqual({ kind: "restore_pinned", tabId: 7, pinned: false })
  })

  it("unpin_tab records the previous pinned state for undo", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { previousPinned: true } })
    const result = await executeBrowserAction("unpin_tab", { tabId: 7 }, undefined)
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("unpin_tab", { tabId: 7, pinned: false })
    expect(result.revert).toEqual({ kind: "restore_pinned", tabId: 7, pinned: true })
  })

  it("bulk_pin_tabs pins every tab and records one restore_pinned revert per tab", async () => {
    sendBrowserCommandMock
      .mockResolvedValueOnce({ id: "1", ok: true, result: { previousPinned: false } })
      .mockResolvedValueOnce({ id: "2", ok: true, result: { previousPinned: false } })
    const result = await executeBrowserAction("bulk_pin_tabs", { tabIds: [1, 2] }, undefined)
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("pin_tab", { tabId: 1, pinned: true })
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("pin_tab", { tabId: 2, pinned: true })
    expect(result.ok).toBe(true)
    expect(result.message).toContain("Pinned 2")
    expect(result.revert).toEqual([
      { kind: "restore_pinned", tabId: 1, pinned: false },
      { kind: "restore_pinned", tabId: 2, pinned: false },
    ])
  })

  it("bulk_unpin_tabs reports partial failure honestly", async () => {
    sendBrowserCommandMock
      .mockResolvedValueOnce({ id: "1", ok: true, result: { previousPinned: true } })
      .mockResolvedValueOnce({ id: "2", ok: false, error: "gone" })
    const result = await executeBrowserAction("bulk_unpin_tabs", { tabIds: [1, 2] }, undefined)
    expect(result.ok).toBe(true)
    expect(result.message).toContain("1 of 2")
    expect(result.revert).toEqual([{ kind: "restore_pinned", tabId: 1, pinned: true }])
  })

  it("bulk_pin_tabs reports full failure when nothing succeeded", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "gone" })
    const result = await executeBrowserAction("bulk_pin_tabs", { tabIds: [1] }, undefined)
    expect(result.ok).toBe(false)
    expect(result.revert).toBeUndefined()
  })

  it("move_tabs_to_window never produces a revert", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { moved: [{ tabId: 1 }] } })
    const result = await executeBrowserAction("move_tabs_to_window", { tabIds: [1], windowId: 9 }, undefined)
    expect(result.ok).toBe(true)
    expect(result.revert).toBeUndefined()
  })

  it("create_browser_window records a close_tabs revert for the window's tabs", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { window: { windowId: 5, tabIds: [10, 11] } } })
    const result = await executeBrowserAction("create_browser_window", { urls: ["https://a.com"] }, undefined)
    expect(result.revert).toEqual({ kind: "close_tabs", tabIds: [10, 11] })
  })
})

describe("executeBrowserRevert", () => {
  it("runs close_tabs for a close_tabs revert step", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { closed: [1, 2] } })
    const result = await executeBrowserRevert({ kind: "close_tabs", tabIds: [1, 2] })
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("close_tabs", { tabIds: [1, 2] })
    expect(result).toEqual({ ok: true })
  })

  it("runs pin_tab/unpin_tab for a restore_pinned revert step", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: {} })
    await executeBrowserRevert({ kind: "restore_pinned", tabId: 7, pinned: true })
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("pin_tab", { tabId: 7, pinned: true })

    await executeBrowserRevert({ kind: "restore_pinned", tabId: 7, pinned: false })
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("unpin_tab", { tabId: 7, pinned: false })
  })

  it("surfaces an error when the revert command itself fails", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "gone" })
    const result = await executeBrowserRevert({ kind: "close_tabs", tabIds: [1] })
    expect(result).toEqual({ ok: false, error: "gone" })
  })
})

describe("executeBrowserReverts", () => {
  it("runs every step and reports overall success when all succeed", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: {} })
    const result = await executeBrowserReverts([{ kind: "close_tabs", tabIds: [1] }, { kind: "restore_pinned", tabId: 2, pinned: true }])
    expect(sendBrowserCommandMock).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true, errors: [] })
  })

  it("continues past a failed step and reports it rather than aborting", async () => {
    sendBrowserCommandMock.mockResolvedValueOnce({ id: "1", ok: false, error: "gone" }).mockResolvedValueOnce({ id: "2", ok: true, result: {} })
    const result = await executeBrowserReverts([{ kind: "close_tabs", tabIds: [1] }, { kind: "restore_pinned", tabId: 2, pinned: true }])
    expect(sendBrowserCommandMock).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: false, errors: ["gone"] })
  })
})
