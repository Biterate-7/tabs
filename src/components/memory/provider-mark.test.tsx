import { existsSync } from "node:fs"
import path from "node:path"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { AI_PROVIDER_IDS } from "@/lib/providers/registry"
import { ProviderBadge, ProviderMark } from "./provider-mark"

const publicFile = (src: string) => path.join(process.cwd(), "public", src)

describe("ProviderMark", () => {
  it("draws each provider's own supplied logo, and the file exists", () => {
    for (const id of AI_PROVIDER_IDS) {
      const { container, unmount } = render(<ProviderMark provider={id} />)
      const mark = container.querySelector(`[data-provider-logo="${id}"]`)!
      const src = mark.querySelector("img")?.getAttribute("src") ?? /url\(["']?(.+?)["']?\)/.exec(mark.querySelector("span")?.getAttribute("style") ?? "")?.[1]
      expect(src).toBe(`/brand/providers/${id}.png`)
      expect(existsSync(publicFile(src!))).toBe(true)
      unmount()
    }
  })

  it("draws nothing for a provider it does not know, never another provider's logo", () => {
    for (const unknown of ["grok", "", null, undefined]) {
      const { container, unmount } = render(<ProviderMark provider={unknown} />)
      expect(container.innerHTML).toBe("")
      unmount()
    }
  })

  it("is decorative beside a name, and named when given a title", () => {
    const decorative = render(<ProviderMark provider="claude" />).container.firstElementChild!
    expect(decorative.getAttribute("aria-hidden")).toBe("true")
    expect(decorative.getAttribute("role")).toBeNull()
    const named = render(<ProviderMark provider="gemini" title="Gemini" />).container.firstElementChild!
    expect(named.getAttribute("role")).toBe("img")
    expect(named.getAttribute("aria-label")).toBe("Gemini")
  })

  it("keeps a fixed box so a badge never shifts", () => {
    const { container } = render(<ProviderBadge provider="perplexity" />)
    const box = container.querySelector<HTMLElement>("[data-provider-logo]")!
    expect(box.style.width).toBe("12px")
    expect(box.style.height).toBe("12px")
    expect(container.textContent).toBe("Perplexity")
  })
})
