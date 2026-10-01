import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

/** The release manifest, replaceable per test so the published state can be exercised before it is real. */
const builds = vi.hoisted(() => ({
  current: {
    windows: { status: "unpublished" },
    macos: { status: "coming_soon" },
    linux: { status: "unsupported" },
  } as Record<string, unknown>,
}))
vi.mock("@/lib/desktop/release", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/release")>()
  type Builds = Parameters<typeof actual.downloadUrl>[1]
  const live = () => builds.current as Builds
  return {
    ...actual,
    get DESKTOP_BUILDS() {
      return live()
    },
    downloadUrl: (os: Parameters<typeof actual.downloadUrl>[0]) => actual.downloadUrl(os, live()),
    downloadHref: (os: Parameters<typeof actual.downloadHref>[0]) => actual.downloadHref(os, live()),
    desktopOffer: (visitor: Parameters<typeof actual.desktopOffer>[0]) => actual.desktopOffer(visitor, live()),
    statusLabel: (os: Parameters<typeof actual.statusLabel>[0]) => actual.statusLabel(os, live()),
    desktopLinkLabel: () => actual.desktopLinkLabel(live()),
    anyDesktopBuildPublished: () => actual.anyDesktopBuildPublished(live()),
  }
})

import { DownloadPage } from "./download-page"
import { getOnboardingState } from "@/lib/onboarding"

const UNPUBLISHED = {
  windows: { status: "unpublished" },
  macos: { status: "coming_soon" },
  linux: { status: "unsupported" },
}
const SHA = "b".repeat(64)
/** Every download link is the measured endpoint; the GitHub asset URL never appears in the page. */
const MEASURED = "/api/download?platform=windows"

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
}

function asVisitor(userAgent: string) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent)
}

function hero() {
  return screen.getByRole("heading", { level: 1 }).closest("section")!
}

beforeEach(() => {
  builds.current = { ...UNPUBLISHED }
  push.mockReset()
  window.localStorage.clear()
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("/download while no installer is published", () => {
  it("tells a Windows visitor plainly that the Windows build is not yet available, with no download link", async () => {
    asVisitor(UA.windows)
    render(<DownloadPage />)
    expect(await within(hero()).findByText("Hubble for Windows")).toBeTruthy()
    expect(within(hero()).getByText("The Windows build is not publicly available yet.")).toBeTruthy()
    // No fake download anywhere on the page.
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull()
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/\.exe|\.msi|releases\/download/)
    }
  })

  it("says macOS is coming soon and Linux is not available", async () => {
    asVisitor(UA.mac)
    const { unmount } = render(<DownloadPage />)
    expect(await within(hero()).findByText("Hubble for macOS")).toBeTruthy()
    expect(within(hero()).getByText("Coming soon")).toBeTruthy()
    unmount()

    asVisitor(UA.linux)
    render(<DownloadPage />)
    expect(await within(hero()).findByText("Hubble for Linux")).toBeTruthy()
    expect(within(hero()).getByText("Not available")).toBeTruthy()
  })

  it("lists every platform with its real status", async () => {
    asVisitor(UA.windows)
    render(<DownloadPage />)
    const list = await screen.findByRole("region", { name: "Platforms" })
    expect(within(list).getByText("Windows").parentElement!.textContent).toMatch(/Not yet available/)
    expect(within(list).getByText("macOS").parentElement!.textContent).toMatch(/Coming soon/)
    expect(within(list).getByText("Linux").parentElement!.textContent).toMatch(/Not available/)
  })

  it("asks an unknown platform to choose, under a neutral label", async () => {
    asVisitor("")
    render(<DownloadPage />)
    expect(await within(hero()).findByText("Download Hubble Desktop")).toBeTruthy()
    expect(within(hero()).getByText("Hubble Desktop is not publicly available yet.")).toBeTruthy()
  })

  it("offers Hubble in the browser instead, recording the onboarding choice first", async () => {
    asVisitor(UA.windows)
    render(<DownloadPage />)
    fireEvent.click(await within(hero()).findByRole("button", { name: /Use Hubble in your browser/ }))
    expect(getOnboardingState().dismissed).toBe(true)
    expect(push).toHaveBeenCalledWith("/")
  })
})

describe("/download once a Windows installer is published", () => {
  beforeEach(() => {
    builds.current = { ...UNPUBLISHED, windows: { status: "published", version: "0.1.0", sha256: SHA } }
  })

  it("offers Windows visitors the measured download link, with requirements and version", async () => {
    asVisitor(UA.windows)
    render(<DownloadPage />)
    const button = await within(hero()).findByRole("link", { name: "Download Hubble for Windows" })
    expect(button.getAttribute("href")).toBe(MEASURED)
    expect(document.body.innerHTML).not.toMatch(/github\.com|releases\/download|localhost|_debug|\.exe/)
    expect(within(hero()).getByText(/Windows 10 or 11, 64-bit · Version 0.1.0/)).toBeTruthy()
  })

  it("shows the next steps after the download starts", async () => {
    asVisitor(UA.windows)
    render(<DownloadPage />)
    // jsdom cannot follow a link to another document; the click is what is under test.
    document.addEventListener("click", (event) => event.preventDefault(), { once: true })
    fireEvent.click(await within(hero()).findByRole("link", { name: "Download Hubble for Windows" }))
    expect(within(hero()).getByRole("status").textContent).toMatch(/Your download has started/)
    expect(screen.getByRole("heading", { name: "Next steps" })).toBeTruthy()
    const steps = screen.getByRole("heading", { name: "Next steps" }).closest("section")!
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Install Hubble"),
      expect.stringContaining("Open Hubble"),
      expect.stringContaining("Connect your agents"),
      expect.stringContaining("Sign in to each agent"),
      expect.stringContaining("Start working"),
    ])
  })

  it("still offers a Mac visitor no download, but lists the Windows build", async () => {
    asVisitor(UA.mac)
    render(<DownloadPage />)
    expect(await within(hero()).findByText("Coming soon")).toBeTruthy()
    expect(within(hero()).queryByRole("link", { name: /download/i })).toBeNull()
    const list = screen.getByRole("region", { name: "Platforms" })
    expect(within(list).getByRole("link", { name: /Download · Version 0.1.0/ }).getAttribute("href")).toBe(MEASURED)
  })
})

describe("/download content", () => {
  it("names the local agents from the catalogue, and never the MCP client", async () => {
    render(<DownloadPage />)
    const agents = screen.getByRole("region", { name: "Works with your local agents" })
    const names = within(agents).getAllByRole("listitem").map((item) => item.textContent)
    expect(names).toEqual([
      expect.stringContaining("Claude Code"),
      expect.stringContaining("Codex"),
      expect.stringContaining("Gemini CLI"),
      expect.stringContaining("Grok Build"),
    ])
    expect(agents.textContent).not.toMatch(/Custom MCP|MCP agent/)
  })

  it("explains web vs desktop, and does not imply credentials or workspaces carry over", () => {
    render(<DownloadPage />)
    expect(screen.getByText(/Local agents run on your computer, so Hubble Desktop is required to connect them/)).toBeTruthy()
    expect(screen.getByText(/keeps its own workspaces on your computer, separate from your browser/)).toBeTruthy()
    expect(screen.getByText(/Nothing carries over from this website/)).toBeTruthy()
    // The page collects nothing.
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(document.querySelector("input, form")).toBeNull()
  })

  it("is Hubble, never TabDump, and makes no sandbox claim", () => {
    render(<DownloadPage />)
    expect(document.body.textContent).not.toMatch(/TabDump|Tab Dump|sandbox/i)
    expect(screen.getAllByText("HUBBLE").length).toBeGreaterThan(0)
  })

  it("inside Hubble Desktop, says so instead of offering a download", async () => {
    window.__TAURI_INTERNALS__ = {}
    try {
      asVisitor(UA.windows)
      render(<DownloadPage />)
      await waitFor(() => expect(within(hero()).getByText(/You’re using Hubble Desktop/)).toBeTruthy())
      expect(screen.queryByRole("region", { name: "Platforms" })).toBeNull()
      expect(within(hero()).queryByRole("button")).toBeNull()
    } finally {
      delete window.__TAURI_INTERNALS__
    }
  })

  it("points its section links back at the landing page", () => {
    render(<DownloadPage />)
    const footer = document.querySelector("footer")!
    expect(within(footer).getByRole("link", { name: "Workspaces" }).getAttribute("href")).toBe("/welcome#workspaces")
    // No link to itself in the footer's Resources.
    expect(within(footer).queryByRole("link", { name: /Hubble Desktop|Download Hubble/ })?.getAttribute("href")).toBe("/download")
  })
})
