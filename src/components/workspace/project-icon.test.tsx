import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ProjectIcon } from "./project-icon"

describe("ProjectIcon", () => {
  it("draws a plain outline glyph with no tile, gradient or glow", () => {
    const { container } = render(<ProjectIcon workspace={{ name: "AP Calculus" }} size={16} />)
    const icon = container.querySelector("[data-project-icon]") as HTMLElement
    expect(icon.getAttribute("data-project-icon")).toBe("math")
    expect(icon.querySelector("svg")).not.toBeNull()
    expect(icon.className).toContain("text-muted-foreground")
    expect(icon.getAttribute("style") ?? "").not.toMatch(/gradient|shadow/)
    expect(container.querySelector("linearGradient, radialGradient")).toBeNull()
  })

  it("is a folder when the title names no subject", () => {
    const { container } = render(<ProjectIcon workspace={{ name: "Zzyzx" }} />)
    expect(container.querySelector("[data-project-icon]")?.getAttribute("data-project-icon")).toBe("folder")
  })

  it("never grows the glyph past 20px, however large the box", () => {
    const { container } = render(<ProjectIcon workspace={{ name: "Zzyzx" }} size={44} />)
    const svg = container.querySelector("svg") as SVGElement
    expect(svg.getAttribute("width")).toBe("20")
  })
})
