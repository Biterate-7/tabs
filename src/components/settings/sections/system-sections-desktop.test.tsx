import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
// The sign-in dialog needs an AuthProvider; whether it opens isn't what these check.
vi.mock("@/components/auth/sign-in-dialog", () => ({ SignInDialog: () => null }))

const { AccountSettingsSection, ExtensionSection } = await import("./system-sections")

function setDesktop(on: boolean) {
  if (on) (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  else delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

afterEach(() => {
  cleanup()
  setDesktop(false)
})

describe("Settings in Hubble Desktop", () => {
  it("presents the extension as this app's companion instead of a status that could only read Not connected", () => {
    setDesktop(true)
    render(<ExtensionSection />)
    expect(screen.getByText(/The companion extension: saves AI conversations and tabs from Chrome into your projects here/)).toBeTruthy()
    expect(screen.queryByText("Not connected")).toBeNull()
    expect(screen.getByRole("link", { name: /Download/ })).toBeTruthy()
  })

  it("keeps the connection status on the web", () => {
    render(<ExtensionSection />)
    expect(screen.getByText("Not connected")).toBeTruthy()
  })

  it("describes storage as this computer, not this browser", () => {
    setDesktop(true)
    render(<AccountSettingsSection />)
    expect(screen.getByText("Everything is saved in this app on this computer.")).toBeTruthy()
    expect(screen.queryByText(/this browser/)).toBeNull()
  })
})
