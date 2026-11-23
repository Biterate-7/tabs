import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBrowserBridgeForTests } from "./bridge"
import { CHROME_NO_ANSWER_MESSAGE, CHROME_NOT_CONNECTED_MESSAGE, CHROME_NOT_PAIRED_MESSAGE, CHROME_SLOW_MESSAGE, readChromeTabs } from "./read-tabs"

type Tauri = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }
const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: Tauri }

/** Hubble Desktop, with the link answering each command `answer(action)` and the pairing `paired`. */
function desktop(answer: (action: string) => unknown, paired: boolean) {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  tauriWindow.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      calls.push({ command, ...(args ? { args } : {}) })
      if (command === "desktop_link_command") return answer(String(args?.action))
      if (command === "desktop_link_paired") return paired
      throw new Error(`unexpected command ${command}`)
    },
  }
  return calls
}

describe("readChromeTabs in Hubble Desktop", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    delete tauriWindow.__TAURI_INTERNALS__
    __resetBrowserBridgeForTests()
    vi.restoreAllMocks()
  })

  it("reads the tabs and windows a paired Hubble for Chrome sends, waking Chrome for them", async () => {
    const calls = desktop(
      (action) =>
        action === "list_browser_tabs"
          ? { ok: true, result: { tabs: [{ tabId: 1, windowId: 7, index: 0, url: "https://a.example/", title: "A", active: true, pinned: false }] } }
          : { ok: true, result: { windows: [{ windowId: 7, focused: true, incognito: false, type: "normal" }] } },
      true
    )
    const reading = await readChromeTabs()
    expect(reading).toMatchObject({ ok: true, tabs: [{ url: "https://a.example/" }], windows: [{ windowId: 7 }] })
    const commands = calls.filter((call) => call.command === "desktop_link_command")
    expect(commands.map((call) => call.args?.action).sort()).toEqual(["list_browser_tabs", "list_browser_windows"])
    // Something the person just asked for: Chrome may be woken, and gets long enough to start its worker.
    expect(commands.every((call) => call.args?.wake === true && Number(call.args?.timeoutMs) >= 12000)).toBe(true)
  })

  it("says Hubble for Chrome isn't connected — and how to connect it — when nothing is paired", async () => {
    desktop(() => ({ ok: false, error: "not-paired" }), false)
    const reading = await readChromeTabs()
    expect(reading).toEqual({ ok: false, reason: "unavailable", cause: "not-paired", message: CHROME_NOT_PAIRED_MESSAGE })
    expect(CHROME_NOT_PAIRED_MESSAGE).toMatch(/choose Connect/)
    expect(console.warn).toHaveBeenCalledWith("[hubble] reading Chrome's tabs failed", { reason: "unavailable", cause: "not-paired", error: "desktop-unreachable" })
  })

  it("tells a connected Chrome that never collected the request apart from an unpaired one", async () => {
    desktop(() => ({ ok: false, error: "extension-unreachable" }), true)
    expect(await readChromeTabs()).toEqual({ ok: false, reason: "unavailable", cause: "no-answer", message: CHROME_NO_ANSWER_MESSAGE })
  })

  it("says Chrome was slow when it took the request and never answered", async () => {
    desktop(() => ({ ok: false, error: "timed-out" }), true)
    expect(await readChromeTabs()).toEqual({ ok: false, reason: "failed", message: CHROME_SLOW_MESSAGE })
  })

  it("passes on what Hubble for Chrome said when it refused", async () => {
    desktop(() => ({ ok: false, error: "Chrome refused." }), true)
    expect(await readChromeTabs()).toEqual({ ok: false, reason: "failed", message: "Hubble for Chrome couldn't read your tabs: Chrome refused." })
  })
})

describe("readChromeTabs on the web", () => {
  afterEach(() => {
    __resetBrowserBridgeForTests()
    vi.restoreAllMocks()
  })

  it("reads no extension answering as no extension", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await readChromeTabs(20)).toEqual({ ok: false, reason: "unavailable", cause: "no-extension", message: CHROME_NOT_CONNECTED_MESSAGE })
  })
})
