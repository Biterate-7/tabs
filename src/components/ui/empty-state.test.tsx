import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Search } from "lucide-react"
import { EmptyState } from "./empty-state"

describe("EmptyState", () => {
  it("renders title, description, and an optional action", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <EmptyState
        icon={Search}
        title='Nothing matches "asdf".'
        description="Try another word, or clear your filters."
        action={{ label: "Clear filters", onClick }}
      />
    )
    expect(screen.getByText('Nothing matches "asdf".')).toBeTruthy()
    expect(
      screen.getByText("Try another word, or clear your filters.")
    ).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("omits the action button when none is given", () => {
    render(<EmptyState icon={Search} title="Nothing here." />)
    expect(screen.queryByRole("button")).toBeFalsy()
  })
})
