import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bytesToBase64, detectTransferSupport, sendTransfer } from "./client"
import type { TransferRequest } from "./protocol"

/**
 * The page's transport, against jsdom's real postMessage with a stand-in
 * content script listening on the window: support detection, one transfer
 * with its progress, and every way it can fail being a value.
 */

const SOURCE = "tabdump-extension"
let fake: ((event: MessageEvent) => void) | undefined

function extension(handler: (type: string, payload: Record<string, unknown>, reply: (type: string, payload: unknown) => void) => void) {
  fake = (event: MessageEvent) => {
    if (event.data?.source !== SOURCE) return
    handler(event.data.type, event.data.payload ?? {}, (type, payload) => window.postMessage({ source: SOURCE, type, payload }, window.location.origin))
  }
  window.addEventListener("message", fake)
}

afterEach(() => {
  if (fake) window.removeEventListener("message", fake)
  fake = undefined
  vi.useRealTimers()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

const request: TransferRequest = { opId: "op_0123456789abcdef", provider: "gemini", mode: "prepare", text: "Summarize.", files: [] }

describe("detectTransferSupport", () => {
  it("finds an extension that speaks the protocol", async () => {
    extension((type, payload, reply) => {
      if (type === "HUBBLE_AI_TRANSFER_HELLO") reply("HUBBLE_AI_TRANSFER_HELLO_RESULT", { requestId: payload.requestId, protocol: 1 })
    })
    expect(await detectTransferSupport()).toEqual({ available: true })
  })

  it("tells an older extension (it answers the ping, not the hello) apart from none", async () => {
    extension((type, payload, reply) => {
      if (type === "TABDUMP_EXTENSION_PING") reply("TABDUMP_EXTENSION_PONG", { requestId: payload.requestId })
    })
    expect(await detectTransferSupport()).toEqual({ available: false, reason: "extension-outdated" })
    window.removeEventListener("message", fake!)
    fake = undefined
    expect(await detectTransferSupport()).toEqual({ available: false, reason: "no-extension" })
  })

  it("knows Hubble Desktop can't reach the browser", async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    expect(await detectTransferSupport()).toEqual({ available: false, reason: "desktop" })
  })
})

describe("sendTransfer", () => {
  beforeEach(() => {
    extension((type, payload, reply) => {
      if (type !== "HUBBLE_AI_TRANSFER") return
      // Someone else's transfer first: never mistaken for this one.
      reply("HUBBLE_AI_TRANSFER_PROGRESS", { opId: "op_somebodyelse1", state: "attaching" })
      reply("HUBBLE_AI_TRANSFER_PROGRESS", { opId: payload.opId, state: "opening-provider" })
      reply("HUBBLE_AI_TRANSFER_PROGRESS", { opId: payload.opId, state: "inserting" })
      reply("HUBBLE_AI_TRANSFER_RESULT", { opId: "op_somebodyelse1", ok: false, error: "failed" })
      reply("HUBBLE_AI_TRANSFER_RESULT", { opId: payload.opId, ok: true, state: "ready-for-review", attached: [], notAttached: [], usedFallback: false, reusedTab: false })
    })
  })

  it("hands over one transfer and follows its own progress to its own result", async () => {
    const states: string[] = []
    const result = await sendTransfer(request, (state) => states.push(state))
    expect(states).toEqual(["opening-provider", "inserting"])
    expect(result).toMatchObject({ opId: request.opId, ok: true, state: "ready-for-review" })
  })

  it("refuses a request it would refuse on the other side, without posting it", async () => {
    const posted = vi.spyOn(window, "postMessage")
    expect(await sendTransfer({ ...request, opId: "x" })).toEqual({ opId: "x", ok: false, error: "invalid" })
    expect(posted).not.toHaveBeenCalled()
  })

  it("times out when nothing answers", async () => {
    window.removeEventListener("message", fake!)
    fake = undefined
    vi.useFakeTimers()
    const pending = sendTransfer(request)
    await vi.advanceTimersByTimeAsync(151_000)
    expect(await pending).toEqual({ opId: request.opId, ok: false, error: "timeout" })
  })
})

describe("bytesToBase64", () => {
  it("encodes bytes exactly", async () => {
    expect(await bytesToBase64(new TextEncoder().encode("%PDF-1.4"))).toBe(btoa("%PDF-1.4"))
  })
})
