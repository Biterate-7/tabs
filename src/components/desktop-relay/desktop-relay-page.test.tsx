import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const sendBrowserCommand = vi.hoisted(() => vi.fn())
vi.mock("@/lib/browser/bridge", () => ({ sendBrowserCommand }))

const { DesktopRelayPage, readRelay } = await import("./desktop-relay-page")
const { readConnectRequest, callbackUrl } = await import("@/components/desktop-connect/desktop-connect-page")

const ID = "a".repeat(32)
const SECRET = "b".repeat(64)
const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

function openWith(hash: string) {
  window.history.replaceState(null, "", `/desktop/relay${hash}`)
  render(<DesktopRelayPage />)
}

beforeEach(() => sendBrowserCommand.mockReset())
afterEach(cleanup)

describe("readRelay", () => {
  it("accepts only a request Hubble Desktop made", () => {
    expect(readRelay(`#id=${ID}&secret=${SECRET}&port=41517&action=browser_tabs`)).toEqual({ id: ID, secret: SECRET, port: 41517, action: "browser_tabs" })
    expect(readRelay(`#id=${ID}&secret=${SECRET}&port=41518&action=history&args=${b64({ startTime: 10, endTime: 20 })}`)).toMatchObject({
      action: "history",
      history: { startTime: 10, endTime: 20 },
    })
    for (const bad of [
      "",
      `#id=${ID}&secret=${SECRET}&port=80&action=browser_tabs`,
      `#id=xyz&secret=${SECRET}&port=41517&action=browser_tabs`,
      `#id=${ID}&secret=short&port=41517&action=browser_tabs`,
      `#id=${ID}&secret=${SECRET}&port=41517&action=open_tabs`,
      `#id=${ID}&secret=${SECRET}&port=41517&action=history`,
      `#id=${ID}&secret=${SECRET}&port=41517&action=history&args=${b64({ startTime: 20, endTime: 10 })}`,
    ]) {
      expect(readRelay(bad), bad).toBeNull()
    }
  })
})

describe("the relay page", () => {
  it("reads nothing until Send, then hands Chrome's tabs to the app — without this page's own tab — and forgets the secret", async () => {
    sendBrowserCommand.mockImplementation(async (action: string) => {
      if (action === "list_browser_tabs") return { id: "1", ok: true, result: { tabs: [{ tabId: 1, url: "https://a.example/" }] } }
      if (action === "list_browser_windows") return { id: "2", ok: true, result: { windows: [{ windowId: 1 }] } }
      if (action === "deliver_to_desktop") return { id: "3", ok: true, result: { delivered: true } }
      return { id: "x", ok: false, error: "unexpected" }
    })
    openWith(`#id=${ID}&secret=${SECRET}&port=41517&action=browser_tabs`)
    expect(await screen.findByText("Send your open tabs to Hubble Desktop?")).toBeTruthy()
    expect(window.location.hash).toBe("")
    expect(sendBrowserCommand).not.toHaveBeenCalled()

    await userEvent.setup().click(screen.getByRole("button", { name: "Send to Hubble Desktop" }))
    expect(await screen.findByText("Sent to Hubble Desktop")).toBeTruthy()
    const delivery = sendBrowserCommand.mock.calls.find(([action]) => action === "deliver_to_desktop")![1]
    expect(delivery).toMatchObject({ port: 41517, id: ID, secret: SECRET, action: "browser_tabs", ok: true })
    expect(delivery.result.origin).toBe(window.location.origin)
  })

  it("Don't send reads nothing from Chrome and tells the app no", async () => {
    sendBrowserCommand.mockResolvedValue({ id: "3", ok: true, result: { delivered: true } })
    openWith(`#id=${ID}&secret=${SECRET}&port=41517&action=history&args=${b64({ startTime: 0, endTime: 1 })}`)
    await userEvent.setup().click(await screen.findByRole("button", { name: /Don.t send/ }))
    expect(await screen.findByText("Nothing was sent")).toBeTruthy()
    expect(sendBrowserCommand.mock.calls.map(([action]) => action)).toEqual(["deliver_to_desktop"])
    expect(sendBrowserCommand.mock.calls[0]![1]).toMatchObject({ ok: false, error: "Not sent from Chrome." })
  })

  it("asks for an update when the extension predates the relay", async () => {
    sendBrowserCommand.mockImplementation(async (action: string) =>
      action === "deliver_to_desktop"
        ? { id: "3", ok: false, error: 'Unknown or disallowed browser action "deliver_to_desktop".' }
        : { id: "1", ok: true, result: { items: [] } }
    )
    openWith(`#id=${ID}&secret=${SECRET}&port=41517&action=history&args=${b64({ startTime: 0 })}`)
    await userEvent.setup().click(await screen.findByRole("button", { name: "Send to Hubble Desktop" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Update Hubble for Chrome/))
  })
})

describe("the connect page's request", () => {
  it("accepts only an S256 challenge and a state", () => {
    const challenge = "c".repeat(43)
    expect(readConnectRequest(`?challenge=${challenge}&state=${"s".repeat(43)}&label=Hubble%20Desktop%20on%20PC`)).toEqual({
      challenge,
      state: "s".repeat(43),
      label: "Hubble Desktop on PC",
    })
    expect(readConnectRequest(`?challenge=short&state=${"s".repeat(43)}`)).toBeNull()
    expect(readConnectRequest(`?challenge=${challenge}`)).toBeNull()
    expect(readConnectRequest(`?challenge=${challenge}&state=${"s".repeat(43)}&label=${"x".repeat(200)}`)!.label).toHaveLength(80)
  })

  it("hands the code back only through hubble://auth", () => {
    expect(callbackUrl("hbc_abc", "st&ate")).toBe("hubble://auth/callback?code=hbc_abc&state=st%26ate")
  })
})

describe("the relay page under StrictMode", () => {
  it("reads the fragment once, even when its effect runs twice", async () => {
    const { StrictMode } = await import("react")
    window.history.replaceState(null, "", `/desktop/relay#id=${ID}&secret=${SECRET}&port=41517&action=browser_tabs`)
    render(
      <StrictMode>
        <DesktopRelayPage />
      </StrictMode>
    )
    expect(await screen.findByText("Send your open tabs to Hubble Desktop?")).toBeTruthy()
    expect(window.location.hash).toBe("")
  })
})
