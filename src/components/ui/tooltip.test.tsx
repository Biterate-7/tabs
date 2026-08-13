import { describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

describe("Tooltip", () => {
  it("shows its content on hover and exposes it accessibly", async () => {
    const user = userEvent.setup()
    render(
      <Tooltip>
        <TooltipTrigger render={<button>Open</button>} />
        <TooltipContent>Opens the thing</TooltipContent>
      </Tooltip>
    )

    expect(screen.queryByText("Opens the thing")).toBeFalsy()
    await user.hover(screen.getByRole("button", { name: "Open" }))
    await waitFor(
      () => expect(screen.getByText("Opens the thing")).toBeTruthy(),
      { timeout: 2000 }
    )
  })
})
