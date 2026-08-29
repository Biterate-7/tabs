import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { ExtensionInstallGuide } from "./extension-install-guide"

describe("ExtensionInstallGuide", () => {
  it("tells users to extract the downloaded archive before touching Chrome", () => {
    render(<ExtensionInstallGuide onBack={vi.fn()} onContinueWithoutExtension={vi.fn()} />)

    expect(screen.getByText(/Extract the downloaded/)).toBeTruthy()
    expect(screen.getByText("tabdump-extension.zip")).toBeTruthy()
    expect(screen.getByText(/do not select the \.zip itself in Chrome/)).toBeTruthy()
  })

  it("tells users to select the extracted folder containing manifest.json, never the .zip file", () => {
    render(<ExtensionInstallGuide onBack={vi.fn()} onContinueWithoutExtension={vi.fn()} />)

    const folderStep = screen.getAllByRole("listitem").find((li) => li.textContent?.includes("Select the extracted"))
    expect(folderStep).toBeTruthy()
    expect(folderStep!.textContent).toContain("tabdump-extension")
    expect(folderStep!.textContent).toContain("manifest.json")
    expect(screen.queryByText(/Select the downloaded/)).toBeNull()
  })

  it("orders extraction before opening chrome://extensions", () => {
    render(<ExtensionInstallGuide onBack={vi.fn()} onContinueWithoutExtension={vi.fn()} />)

    const stepTexts = screen.getAllByRole("listitem").map((li) => li.textContent ?? "")
    const extractIndex = stepTexts.findIndex((t) => t.includes("Extract the downloaded"))
    const chromeExtensionsIndex = stepTexts.findIndex((t) => t.includes("chrome://extensions"))
    const loadUnpackedIndex = stepTexts.findIndex((t) => t.includes("Load unpacked"))

    expect(extractIndex).toBeGreaterThanOrEqual(0)
    expect(extractIndex).toBeLessThan(chromeExtensionsIndex)
    expect(extractIndex).toBeLessThan(loadUnpackedIndex)
  })
})
