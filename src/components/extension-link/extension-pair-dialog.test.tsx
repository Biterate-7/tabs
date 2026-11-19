import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ExtensionPairDialog, formatPairingCode, type PairingApi } from "./extension-pair-dialog"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

afterEach(() => cleanup())

function api(pending: { id: string; code: string; label: string; extensionId: string; expiresInMs: number }[]) {
  let notify: (() => void) | undefined
  const answered: { id: string; approve: boolean }[] = []
  const value: PairingApi = {
    pendingPairings: vi.fn(async () => [...pending]),
    answerPairing: vi.fn(async (id: string, approve: boolean) => {
      answered.push({ id, approve })
      pending.splice(0)
    }),
    onPairRequested: vi.fn(async (handler: () => void) => {
      notify = handler
      return () => {}
    }),
  }
  return { value, answered, request: (entry: (typeof pending)[number]) => (pending.push(entry), notify?.()) }
}

const REQUEST = { id: "p1", code: "482913", label: "Chrome on Windows", extensionId: "abcdefghijklmnop", expiresInMs: 120000 }

describe("ExtensionPairDialog", () => {
  it("shows nothing until an extension asks, then the code to compare", async () => {
    const { value, request } = api([])
    render(<ExtensionPairDialog api={value} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    request(REQUEST)
    expect(await screen.findByRole("dialog", { name: "Connect Hubble for Chrome?" })).toBeTruthy()
    expect(screen.getByLabelText("Pairing code").textContent).toBe("482 913")
    expect(screen.getByText(/Chrome on Windows · extension abcdefghijklmnop/)).toBeTruthy()
  })

  it("connects only when the person presses Connect", async () => {
    const { value, answered } = api([REQUEST])
    render(<ExtensionPairDialog api={value} />)
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }))
    await waitFor(() => expect(answered).toEqual([{ id: "p1", approve: true }]))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("declines with Don't connect", async () => {
    const { value, answered } = api([REQUEST])
    render(<ExtensionPairDialog api={value} />)
    fireEvent.click(await screen.findByRole("button", { name: /Don.t connect/ }))
    await waitFor(() => expect(answered).toEqual([{ id: "p1", approve: false }]))
  })

  it("renders nothing on the web, where there is no link", () => {
    render(<ExtensionPairDialog api={undefined} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(formatPairingCode("12")).toBe("12")
  })
})
