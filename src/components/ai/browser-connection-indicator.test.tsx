import { afterEach, describe, expect, it } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { BrowserConnectionIndicator } from "./browser-connection-indicator"
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

describe("BrowserConnectionIndicator", () => {
  it("shows unavailable before the extension answers", () => {
    render(<BrowserConnectionIndicator />)
    expect(screen.getByText(/browser unavailable/i)).toBeTruthy()
  })

  it("switches to connected once the extension responds", () => {
    render(<BrowserConnectionIndicator />)
    act(() => respondToPing())
    expect(screen.getByText(/browser connected/i)).toBeTruthy()
  })
})
