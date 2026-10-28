import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
const delivered = vi.hoisted(() => ({ handler: undefined as ((event: { payload: { id: string } }) => void) | undefined }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, handler: (event: { payload: { id: string } }) => void) => {
    delivered.handler = handler
    return () => (delivered.handler = undefined)
  },
}))

const { askChromeForHistory, askChromeForTabs, RELAY_WAIT_MS } = await import("./desktop-relay")

/** Answers `desktop_relay_take` with whatever `answer` holds, once it is set. */
let answer: unknown = null
beforeEach(() => {
  answer = null
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "desktop_relay_begin") return "relay-1"
    if (command === "desktop_relay_take") {
      expect(args).toEqual({ id: "relay-1" })
      const value = answer
      answer = null
      return value
    }
    return undefined
  })
})
afterEach(() => vi.useRealTimers())

describe("asking Chrome from Hubble Desktop", () => {
  it("asks once for tabs and windows together, and answers when Chrome's reply is delivered", async () => {
    const pending = askChromeForTabs()
    await vi.waitFor(() => expect(delivered.handler).toBeDefined())
    expect(invoke).toHaveBeenCalledWith("desktop_relay_begin", { action: "browser_tabs", args: {} })
    answer = { ok: true, result: { tabs: [], windows: [], origin: "https://hubble.example" } }
    delivered.handler!({ payload: { id: "relay-1" } })
    expect(await pending).toEqual({ ok: true, result: { tabs: [], windows: [], origin: "https://hubble.example" } })
  })

  it("ignores deliveries for other relays", async () => {
    const pending = askChromeForHistory({ startTime: 1, endTime: 2 })
    await vi.waitFor(() => expect(delivered.handler).toBeDefined())
    expect(invoke).toHaveBeenCalledWith("desktop_relay_begin", { action: "history", args: { startTime: 1, endTime: 2 } })
    answer = { ok: true, result: { items: [{ url: "https://a.example/" }] } }
    delivered.handler!({ payload: { id: "someone-else" } })
    // The poll still finds it.
    expect(await pending).toMatchObject({ ok: true, result: { items: [{ url: "https://a.example/" }] } })
  })

  it("tells a decline from a failure, and refuses a malformed answer", async () => {
    answer = { ok: false, error: "Not sent from Chrome." }
    expect(await askChromeForTabs()).toMatchObject({ ok: false, reason: "declined" })
    answer = { ok: false, error: "Hubble for Chrome isn't installed." }
    expect(await askChromeForTabs()).toMatchObject({ ok: false, reason: "failed", error: "Hubble for Chrome isn't installed." })
    answer = { ok: true, result: { tabs: "nope" } }
    expect(await askChromeForTabs()).toMatchObject({ ok: false, reason: "failed", error: "Chrome sent something unexpected." })
  })

  it("gives up after waiting, and cancels so a late answer is refused", async () => {
    vi.useFakeTimers()
    const pending = askChromeForTabs()
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS + 10)
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" })
    expect(invoke).toHaveBeenCalledWith("desktop_relay_cancel", { id: "relay-1" })
  })

  it("reports when the browser couldn't be opened at all", async () => {
    invoke.mockRejectedValueOnce("Hubble Desktop's connection for Hubble for Chrome isn't running.")
    expect(await askChromeForTabs()).toEqual({ ok: false, reason: "failed", error: "Hubble Desktop's connection for Hubble for Chrome isn't running." })
  })
})
