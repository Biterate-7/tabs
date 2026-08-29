import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TabInput } from "./tab-input"

describe("TabInput", () => {
  it("shows an Organizing state, then a DumpConfirmation, before calling onDump", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({
      advanceTimers: vi.advanceTimersByTime,
    })
    const onDump = vi.fn()
    render(<TabInput onDump={onDump} />)

    await user.type(
      screen.getByLabelText("Paste your tabs"),
      "https://github.com/a\nhttps://arxiv.org/b"
    )
    await user.click(screen.getByRole("button", { name: /Dump 2 tabs/ }))

    expect(screen.getByText(/Organizing 2 tabs/)).toBeTruthy()
    expect(onDump).not.toHaveBeenCalled()

    vi.advanceTimersByTime(600)
    await waitFor(() => expect(screen.getByText("2 tabs imported")).toBeTruthy())
    expect(onDump).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: /View workspace/ }))
    expect(onDump).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
