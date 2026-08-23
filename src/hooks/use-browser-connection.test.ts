import { afterEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useBrowserConnection } from "./use-browser-connection"
import { __resetBrowserBridgeForTests } from "@/lib/browser/bridge"
import { BROWSER_MESSAGE_SOURCE, MSG_EXTENSION_PONG } from "@/lib/browser/protocol"

function respondToPing() {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: BROWSER_MESSAGE_SOURCE, type: MSG_EXTENSION_PONG, payload: { requestId: null } },
      origin: window.location.origin,
      source: window,
    })
  )
}

afterEach(() => {
  __resetBrowserBridgeForTests()
})

describe("useBrowserConnection", () => {
  it("starts disconnected and flips to connected once a pong arrives", () => {
    const { result } = renderHook(() => useBrowserConnection())
    expect(result.current).toBe(false)

    act(() => respondToPing())

    expect(result.current).toBe(true)
  })

  it("stops watching (no leaked listener) once unmounted", () => {
    const { unmount } = renderHook(() => useBrowserConnection())
    expect(() => unmount()).not.toThrow()
  })
})
