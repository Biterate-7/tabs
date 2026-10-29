import { describe, expect, it } from "vitest"
import * as extension from "../../../extension/src/context-sites.js"
import { cleanExcludedHost, isSensitiveUrl, SENSITIVE_HOSTS, SITE_CATEGORY_HOSTS, siteCategoryOf } from "./sites"

/** The Hubble page's copy of the site rules must say exactly what the extension enforces. */
describe("site rules, page and extension", () => {
  it("list the same categories and sensitive hosts", () => {
    expect(SITE_CATEGORY_HOSTS).toEqual(extension.SITE_CATEGORY_HOSTS)
    expect([...SENSITIVE_HOSTS]).toEqual([...extension.SENSITIVE_HOSTS])
  })

  const urls = [
    "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001",
    "https://docs.google.com/document/d/abc/edit",
    "https://scholar.google.com/scholar?q=sugar+tax",
    "https://www.ox.ac.uk/research",
    "https://www.youtube.com/watch?v=abc123",
    "https://mail.google.com/mail/u/0/",
    "https://www.santander.co.uk/personal",
    "https://example.org/account/settings",
    "https://onlinebanking.example.com/",
    "https://www.economicshelp.org/blog/sugar-tax/",
    "https://news.example.com/story",
    "ftp://example.org/file",
  ]

  it("classify and refuse every address the same way", () => {
    for (const url of urls) {
      expect([url, siteCategoryOf(url)]).toEqual([url, extension.siteCategoryOf(url)])
      expect([url, isSensitiveUrl(url)]).toEqual([url, extension.isSensitiveUrl(url)])
    }
  })

  it("read an excluded site the same way", () => {
    for (const value of ["Example.com", "https://www.reddit.com/r/x", "not a site", "", "a.b"]) {
      expect([value, cleanExcludedHost(value)]).toEqual([value, extension.cleanExcludedHost(value)])
    }
  })

  it("never detect sensitive pages in any mode", () => {
    for (const mode of ["auto", "sites"]) {
      expect(extension.isDetectable("https://mail.google.com/mail/u/0/", { mode, categories: ["ai", "docs", "research", "video"], excludedHosts: [] }, { hubbleOrigin: "http://localhost:3000" })).toBe(false)
    }
  })
})
