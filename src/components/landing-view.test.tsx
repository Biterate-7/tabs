import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LandingView } from "./landing-view"
import { getOnboardingState, dismissOnboarding } from "@/lib/onboarding"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { shouldPlayIntro } from "@/lib/intro"

vi.mock("@/lib/onboarding", () => ({
  getOnboardingState: vi.fn(),
  dismissOnboarding: vi.fn(),
}))

vi.mock("@/lib/extension-config", () => ({
  getExtensionInstallInfo: vi.fn(),
  EXTENSION_DOWNLOAD_URL: "/tabdump-extension.zip",
}))

vi.mock("@/lib/intro", () => ({
  shouldPlayIntro: vi.fn(),
  prefersReducedMotion: vi.fn().mockReturnValue(false),
  isMobileViewport: vi.fn().mockReturnValue(false),
}))

function overlay() {
  return document.querySelector("[data-intro-phase]")
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getExtensionInstallInfo).mockReturnValue({ mode: "download" })
  vi.mocked(shouldPlayIntro).mockReturnValue(false)
})

describe("LandingView onboarding", () => {
  it("shows the install-first onboarding for a brand-new visitor", () => {
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: false, extensionConnected: false })
    render(<LandingView onDump={vi.fn()} />)

    expect(screen.getByText("Dump your Chrome tabs in one click.")).toBeTruthy()
    expect(
      screen.getByText("Install the TabDump Chrome extension to instantly bring your open tabs into TabDump.")
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Install Chrome Extension" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Paste URLs manually" })).toBeTruthy()
    // Manual pasting is still available even when the extension is the primary path.
    expect(screen.getByLabelText("Paste your tabs")).toBeTruthy()
  })

  it("opens the install guide when 'Install Chrome Extension' is clicked", async () => {
    const user = userEvent.setup()
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: false, extensionConnected: false })
    render(<LandingView onDump={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Install Chrome Extension" }))

    expect(screen.getByText("Install TabDump for Chrome")).toBeTruthy()
    expect(screen.getByText("Download the TabDump extension.")).toBeTruthy()
    const downloadLink = screen.getByRole("link", { name: "Download Extension" })
    expect(downloadLink.getAttribute("href")).toBe("/tabdump-extension.zip")
    expect(downloadLink.hasAttribute("download")).toBe(true)
    // Manual pasting remains reachable even from inside the guide.
    expect(screen.getByLabelText("Paste your tabs")).toBeTruthy()
  })

  it("returns to the onboarding CTA when 'Back' is clicked from the guide", async () => {
    const user = userEvent.setup()
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: false, extensionConnected: false })
    render(<LandingView onDump={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Install Chrome Extension" }))
    await user.click(screen.getByRole("button", { name: "Back" }))

    expect(screen.getByText("Dump your Chrome tabs in one click.")).toBeTruthy()
    expect(screen.queryByText("Install TabDump for Chrome")).toBeNull()
  })

  it("dismisses onboarding from inside the guide via 'Continue without extension'", async () => {
    const user = userEvent.setup()
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: false, extensionConnected: false })
    render(<LandingView onDump={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Install Chrome Extension" }))
    await user.click(screen.getByRole("button", { name: "Continue without extension" }))

    expect(dismissOnboarding).toHaveBeenCalledOnce()
    expect(screen.getByText(/Your tabs are a mess/)).toBeTruthy()
    expect(screen.queryByText("Install TabDump for Chrome")).toBeNull()
  })

  it("links directly to the Chrome Web Store when a store URL is configured, skipping the guide", async () => {
    const user = userEvent.setup()
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: false, extensionConnected: false })
    vi.mocked(getExtensionInstallInfo).mockReturnValue({
      mode: "store",
      url: "https://chromewebstore.google.com/detail/real-listing",
    })
    render(<LandingView onDump={vi.fn()} />)

    const link = screen.getByRole("link", { name: "Install from Chrome Web Store" })
    expect(link.getAttribute("href")).toBe("https://chromewebstore.google.com/detail/real-listing")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(screen.queryByRole("button", { name: "Install Chrome Extension" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Paste URLs manually" }))
    expect(dismissOnboarding).toHaveBeenCalledOnce()
  })

  it("dismisses onboarding and persists it when 'Paste URLs manually' is clicked", async () => {
    const user = userEvent.setup()
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: false, extensionConnected: false })
    render(<LandingView onDump={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Paste URLs manually" }))

    expect(dismissOnboarding).toHaveBeenCalledOnce()
    expect(screen.getByText(/Your tabs are a mess/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Paste URLs manually" })).toBeNull()
  })

  it("shows the plain hero (no onboarding) once already dismissed", () => {
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: true, extensionConnected: false })
    render(<LandingView onDump={vi.fn()} />)

    expect(screen.getByText(/Your tabs are a mess/)).toBeTruthy()
    expect(screen.queryByText("Dump your Chrome tabs in one click.")).toBeNull()
    expect(screen.queryByRole("button", { name: "Paste URLs manually" })).toBeNull()
  })

  it("shows the ready state once the extension has connected, taking priority over dismissed", () => {
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: false, extensionConnected: true })
    render(<LandingView onDump={vi.fn()} />)

    expect(screen.getByText("TabDump is ready.")).toBeTruthy()
    expect(
      screen.getByText("Click the TabDump extension whenever you want to dump your open tabs.")
    ).toBeTruthy()
    expect(screen.queryByText("Dump your Chrome tabs in one click.")).toBeNull()
    // Manual pasting remains available in every state.
    expect(screen.getByLabelText("Paste your tabs")).toBeTruthy()
  })
})

describe("LandingView intro gating", () => {
  beforeEach(() => {
    vi.mocked(getOnboardingState).mockReturnValue({ dismissed: true, extensionConnected: false })
  })

  it("mounts no intro overlay at all when the setting is off", () => {
    vi.mocked(shouldPlayIntro).mockReturnValue(false)
    render(<LandingView onDump={vi.fn()} />)

    expect(overlay()).toBeNull()
    expect(screen.getByText(/Your tabs are a mess/)).toBeTruthy()
  })

  it("mounts the intro overlay when the setting is on", () => {
    vi.mocked(shouldPlayIntro).mockReturnValue(true)
    render(<LandingView onDump={vi.fn()} />)

    expect(overlay()).not.toBeNull()
  })
})
