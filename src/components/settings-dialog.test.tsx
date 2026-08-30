import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SettingsDialog } from "./settings-dialog"
import { getSettings, setPlayIntro } from "@/lib/settings"

vi.mock("@/lib/settings", () => ({
  getSettings: vi.fn(),
  setPlayIntro: vi.fn(),
}))

function introSwitch() {
  return screen.getByRole("switch", { name: "Play intro animation" })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("SettingsDialog", () => {
  it("shows the intro toggle on, reflecting the current setting", () => {
    vi.mocked(getSettings).mockReturnValue({ playIntro: true })
    render(<SettingsDialog open onOpenChange={vi.fn()} />)

    expect(introSwitch().getAttribute("aria-checked")).toBe("true")
  })

  it("shows the intro toggle off, reflecting the current setting", () => {
    vi.mocked(getSettings).mockReturnValue({ playIntro: false })
    render(<SettingsDialog open onOpenChange={vi.fn()} />)

    expect(introSwitch().getAttribute("aria-checked")).toBe("false")
  })

  it("persists turning the intro off", async () => {
    const user = userEvent.setup()
    vi.mocked(getSettings).mockReturnValue({ playIntro: true })
    render(<SettingsDialog open onOpenChange={vi.fn()} />)

    await user.click(introSwitch())

    expect(setPlayIntro).toHaveBeenCalledWith(false)
    expect(introSwitch().getAttribute("aria-checked")).toBe("false")
  })

  it("persists turning the intro back on", async () => {
    const user = userEvent.setup()
    vi.mocked(getSettings).mockReturnValue({ playIntro: false })
    render(<SettingsDialog open onOpenChange={vi.fn()} />)

    await user.click(introSwitch())

    expect(setPlayIntro).toHaveBeenCalledWith(true)
  })

  it("renders nothing when closed", () => {
    vi.mocked(getSettings).mockReturnValue({ playIntro: true })
    render(<SettingsDialog open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByText("Settings")).toBeNull()
  })
})
