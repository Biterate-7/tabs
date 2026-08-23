import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetBrowserBridgeForTests,
  isBrowserConnected,
  sendBrowserCommand,
  startConnectionWatch,
  subscribeConnection,
} from "./bridge"
import {
  BROWSER_MESSAGE_SOURCE,
  MSG_BROWSER_COMMAND,
  MSG_BROWSER_COMMAND_RESULT,
  MSG_EXTENSION_PING,
  MSG_EXTENSION_PONG,
} from "./protocol"

/**
 * jsdom's own `window.postMessage` does not set `event.origin`/`event.source`
 * the way a real browser does (both come back empty/mismatched), so — like
 * use-extension-import.test.ts already does for the same reason — incoming
 * "from the extension" messages are simulated by dispatching a MessageEvent
 * directly with those fields set correctly, rather than relying on a real
 * postMessage round trip. Outgoing calls (bridge.ts → "extension") still go
 * through the real `window.postMessage`, captured here via a spy so a test
 * can react to what the bridge actually sent.
 */
function dispatchFromExtension(payload: { source: string; type: string; payload: unknown }) {
  window.dispatchEvent(new MessageEvent("message", { data: payload, origin: window.location.origin, source: window }))
}

function respondToCommand(id: string, result: unknown) {
  dispatchFromExtension({ source: BROWSER_MESSAGE_SOURCE, type: MSG_BROWSER_COMMAND_RESULT, payload: { id, ok: true, result } })
}

function respondToPing(requestId: string | null) {
  dispatchFromExtension({ source: BROWSER_MESSAGE_SOURCE, type: MSG_EXTENSION_PONG, payload: { requestId } })
}

function lastSentCommand(postMessageSpy: ReturnType<typeof vi.spyOn>): { id: string; action: string; args: unknown } {
  const call = postMessageSpy.mock.calls.findLast(
    (c: unknown[]) => (c[0] as { type?: string })?.type === MSG_BROWSER_COMMAND
  ) as [{ payload: { id: string; action: string; args: unknown } }] | undefined
  if (!call) throw new Error("no MSG_BROWSER_COMMAND was posted");
  return call[0].payload
}

afterEach(() => {
  __resetBrowserBridgeForTests()
  vi.restoreAllMocks()
})

describe("sendBrowserCommand", () => {
  it("resolves with the extension's result when one responds", async () => {
    const spy = vi.spyOn(window, "postMessage")
    const promise = sendBrowserCommand("list_browser_tabs", { windowId: undefined })
    const sent = lastSentCommand(spy)
    expect(sent.action).toBe("list_browser_tabs")

    respondToCommand(sent.id, { tabs: [] })

    await expect(promise).resolves.toEqual({ id: sent.id, ok: true, result: { tabs: [] } })
  })

  it("times out with an ok:false result when nothing answers", async () => {
    const result = await sendBrowserCommand("list_browser_tabs", {}, { timeoutMs: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/timed out/i)
  })

  it("matches each pending command to its own result by request id", async () => {
    const spy = vi.spyOn(window, "postMessage")
    const p1 = sendBrowserCommand("open_url", { url: "https://a.com" })
    const p2 = sendBrowserCommand("open_url", { url: "https://b.com" })

    const commandCalls = spy.mock.calls.filter((c) => (c[0] as { type?: string })?.type === MSG_BROWSER_COMMAND)
    expect(commandCalls).toHaveLength(2)
    const [sent1, sent2] = commandCalls.map((c) => (c[0] as { payload: { id: string } }).payload)
    expect(sent1.id).not.toBe(sent2.id)

    respondToCommand(sent2.id, { opened: "second" })
    respondToCommand(sent1.id, { opened: "first" })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok && r1.result).toEqual({ opened: "first" })
    expect(r2.ok && r2.result).toEqual({ opened: "second" })
  })

  it("ignores a result for an id it never sent", async () => {
    respondToCommand("some-unrelated-id", { irrelevant: true })
    const result = await sendBrowserCommand("get_active_tab", {}, { timeoutMs: 100 })
    expect(result.ok).toBe(false)
  })
})

describe("connection watch / ping-pong", () => {
  it("reports disconnected before any pong arrives", () => {
    expect(isBrowserConnected()).toBe(false)
  })

  it("posts a ping and marks connected once a pong arrives", () => {
    const spy = vi.spyOn(window, "postMessage")
    const stop = startConnectionWatch()
    try {
      const pingCall = spy.mock.calls.find((c) => (c[0] as { type?: string })?.type === MSG_EXTENSION_PING)
      expect(pingCall).toBeDefined()

      expect(isBrowserConnected()).toBe(false)
      respondToPing(null)
      expect(isBrowserConnected()).toBe(true)
    } finally {
      stop()
    }
  })

  it("notifies subscribers exactly when connection state actually changes", () => {
    const states: boolean[] = []
    const unsubscribe = subscribeConnection((c) => states.push(c))
    const stop = startConnectionWatch()

    respondToPing(null)
    respondToPing(null) // a second pong while already connected shouldn't re-notify
    expect(states).toEqual([true])

    unsubscribe()
    stop()
  })

  it("ignores a pong-shaped message from the wrong origin", () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: BROWSER_MESSAGE_SOURCE, type: MSG_EXTENSION_PONG, payload: { requestId: null } },
        origin: "https://evil.example",
        source: window,
      })
    )
    expect(isBrowserConnected()).toBe(false)
  })
})
