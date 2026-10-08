import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { peekFaviconSrc, resetFaviconCache } from "@/lib/favicon/client"
import { installFakeFaviconNetwork, type ServiceOutcome } from "@/lib/favicon/__fixtures__/fake-network"
import { TabFavicon } from "./tab-favicon"

let service: Record<string, ServiceOutcome>
let net: ReturnType<typeof installFakeFaviconNetwork>

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })

beforeEach(() => {
  service = {}
  net = installFakeFaviconNetwork({ service: (host) => service[host] ?? "not-found" })
  resetFaviconCache()
})

afterEach(() => {
  resetFaviconCache()
  net.restore()
})

describe("TabFavicon", () => {
  it("shows the site's icon once it has loaded", async () => {
    service["console.cloud.google.com"] = "icon"
    const { container } = render(<TabFavicon domain="console.cloud.google.com" />)
    // The letter holds the space while the icon resolves.
    expect(container.textContent).toBe("C")

    await flush()
    const img = container.querySelector("img")
    expect(img?.getAttribute("src")).toBe(peekFaviconSrc("console.cloud.google.com"))
    expect(img?.getAttribute("src")).toMatch(/^blob:/)
    expect(container.textContent).toBe("")
  })

  it("shows the letter fallback, and no <img>, when the site has no icon", async () => {
    const { container } = render(<TabFavicon domain="no-icon.com" />)
    await flush()
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("N")
  })

  it("falls back to the letter when the verified icon then fails to render (onError)", async () => {
    service["github.com"] = "icon"
    const first = render(<TabFavicon domain="github.com" />)
    await flush()
    const src = peekFaviconSrc("github.com")!
    expect(first.container.querySelector("img")).not.toBeNull()
    first.unmount()

    // The next render's load of that same URL fails.
    net.breakBlob(src)
    const { container } = render(<TabFavicon domain="github.com" />)
    await flush()
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("G")
    // …and the cache forgot it, so every other view falls back too.
    expect(peekFaviconSrc("github.com")).toBeNull()
  })

  it("renders a cached icon for a second mount without asking the resolver again", async () => {
    service["hubble-hq.vercel.app"] = "icon"
    const first = render(<TabFavicon domain="hubble-hq.vercel.app" />)
    await flush()
    first.unmount()

    const second = render(<TabFavicon domain="hubble-hq.vercel.app" />)
    await flush()
    expect(second.container.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/)
    expect(net.fetched).toEqual(["/api/favicon?host=hubble-hq.vercel.app"])
  })

  it("never requests anything for an invalid domain and still renders a badge", async () => {
    const { container } = render(<TabFavicon domain="" />)
    await flush()
    expect(net.fetched).toEqual([])
    expect(net.images).toEqual([])
    expect(container.textContent).toBe("?")
  })
})

describe("TabFavicon with the icon Chrome supplied", () => {
  const CHROME_ICON = "https://chatgpt.com/cdn/assets/favicon.svg"
  const INLINE_ICON = "data:image/png;base64,iVBORw0KGgo="

  function withImages(outcome: (src: string) => "load" | "error") {
    net.restore()
    net = installFakeFaviconNetwork({ service: (host) => service[host] ?? "not-found", image: outcome })
  }

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it("draws Chrome's icon and never asks the resolver", async () => {
    withImages((src) => (src === CHROME_ICON ? "load" : "error"))
    service["chatgpt.com"] = "icon"
    const { container } = render(<TabFavicon domain="chatgpt.com" icon={CHROME_ICON} />)
    await flush()
    expect(container.querySelector("img")?.getAttribute("src")).toBe(CHROME_ICON)
    expect(net.fetched).toEqual([])
  })

  it("falls back to the resolver when Chrome's icon no longer loads", async () => {
    withImages(() => "error")
    service["chatgpt.com"] = "icon"
    const { container } = render(<TabFavicon domain="chatgpt.com" icon={CHROME_ICON} />)
    await flush()
    await flush()
    // Chrome's icon was tried first.
    expect(net.images[0]).toBe(CHROME_ICON)
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/)
    expect(net.fetched).toEqual(["/api/favicon?host=chatgpt.com"])
  })

  it("falls back to the letter when neither loads", async () => {
    withImages(() => "error")
    const { container } = render(<TabFavicon domain="chatgpt.com" icon={CHROME_ICON} />)
    await flush()
    await flush()
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("C")
  })

  it("on desktop, leaves a remote icon to the resolver (no remote img-src) but draws an inline one", async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    withImages((src) => (src.startsWith("data:") ? "load" : "error"))
    service["chatgpt.com"] = "icon"
    const remote = render(<TabFavicon domain="chatgpt.com" icon={CHROME_ICON} />)
    await flush()
    expect(net.images).not.toContain(CHROME_ICON)
    expect(remote.container.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/)
    remote.unmount()

    const inline = render(<TabFavicon domain="example.org" icon={INLINE_ICON} />)
    await flush()
    expect(inline.container.querySelector("img")?.getAttribute("src")).toBe(INLINE_ICON)
  })

  it("ignores a stored value that isn't an icon address", async () => {
    service["example.org"] = "icon"
    const { container } = render(<TabFavicon domain="example.org" icon="javascript:alert(1)" />)
    await flush()
    expect(net.images).not.toContain("javascript:alert(1)")
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/)
  })
})
