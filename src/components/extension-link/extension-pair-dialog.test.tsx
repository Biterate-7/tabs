import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CONNECT_ARM_MS, ExtensionPairDialog, formatPairingCode, type PairingApi } from "./extension-pair-dialog"

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

  it("ignores a click on Connect in the moment the dialog appears, then connects on a deliberate one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { value, answered } = api([REQUEST])
    render(<ExtensionPairDialog api={value} />)
    const connect = await screen.findByRole("button", { name: "Connect" })
    // Hubble just came to the front: a click already on its way must not approve anything.
    expect((connect as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(connect)
    expect(answered).toEqual([])
    await act(async () => {
      vi.advanceTimersByTime(CONNECT_ARM_MS)
    })
    expect((connect as HTMLButtonElement).disabled).toBe(false)
    vi.useRealTimers()
    fireEvent.click(connect)
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
