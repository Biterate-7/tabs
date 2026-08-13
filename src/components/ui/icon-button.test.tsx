import { describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ExternalLink } from "lucide-react"
import { IconButton } from "./icon-button"

describe("IconButton", () => {
  it("renders an accessible label and shows a tooltip with the same text by default", async () => {
    const user = userEvent.setup()
    render(
      <IconButton aria-label="Open example.com">
        <ExternalLink />
      </IconButton>
    )
    const button = screen.getByRole("button", { name: "Open example.com" })
    await user.hover(button)
    await waitFor(() =>
      expect(screen.getByText("Open example.com")).toBeTruthy()
    )
  })

  it("uses a distinct tooltip prop when given", async () => {
    const user = userEvent.setup()
    render(
      <IconButton aria-label="More actions for example.com" tooltip="More actions">
        <ExternalLink />
      </IconButton>
    )
    await user.hover(
      screen.getByRole("button", { name: "More actions for example.com" })
    )
    await waitFor(() => expect(screen.getByText("More actions")).toBeTruthy())
  })
})
