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
