"use client"

import { useEffect, useState } from "react"
import { Menu, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { BrandGlyph, mButtonClass } from "./primitives"

const LINKS = [
  { href: "#dump", label: "The dump" },
  { href: "#organize", label: "Organization" },
  { href: "#spatial", label: "Spatial" },
  { href: "#recall", label: "Recall" },
] as const

/**
 * Sticky top bar.
 *
 * Transparent while the hero is still under it and only gains its
 * background/hairline past the fold — the bar should read as part of the hero
 * at rest and as chrome once you are reading the page. The scroll listener is
 * passive and does nothing but flip one boolean, so it never competes with
 * the demos for frame budget.
 */
export function MarketingNav({
  onPrimary,
  primaryLabel,
  primaryHref,
  onSecondary,
}: {
  onPrimary: () => void
  primaryLabel: string
  /** Set when the primary action is a real navigation (a Chrome Web Store listing), so it renders as a link. */
  primaryHref?: string
  onSecondary: () => void
}) {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // A menu left open while the page scrolls away behind it is disorienting on
  // a phone; closing on navigation is handled per-link, this covers the rest.
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    window.addEventListener("resize", close)
    return () => window.removeEventListener("resize", close)
  }, [menuOpen])

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300 ease-(--ease-standard)",
        scrolled ? "border-b border-subtle bg-background/72 backdrop-blur-xl" : "border-b border-transparent"
      )}
    >
      <nav
        aria-label="Primary"
        className="mx-auto flex h-14 w-full items-center gap-3"
        style={{ maxWidth: "var(--m-max)", paddingInline: "var(--m-gutter)" }}
      >
        <a
          href="#top"
          className="flex shrink-0 items-center gap-2 rounded-md text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <BrandGlyph className="size-[1.125rem]" />
          <span className="text-[0.9375rem] font-medium tracking-[-0.01em]">TabDump</span>
        </a>

        <ul className="ml-6 hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="inline-flex h-8 items-center rounded-full px-3 text-body-sm text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-white/[0.05] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onSecondary}
            className={cn(mButtonClass("ghost"), "hidden sm:inline-flex")}
          >
            Paste tabs
          </button>
          {primaryHref ? (
            <a href={primaryHref} target="_blank" rel="noopener noreferrer" className={mButtonClass("primary")}>
              {primaryLabel}
            </a>
          ) : (
            <button type="button" onClick={onPrimary} className={mButtonClass("primary")}>
              {primaryLabel}
            </button>
          )}
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:hidden"
          >
            {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </nav>

      {menuOpen && (
        <div className="border-t border-subtle bg-background/95 backdrop-blur-xl md:hidden">
          <ul className="flex flex-col py-2" style={{ paddingInline: "var(--m-gutter)" }}>
            {LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-lg px-2 py-2.5 text-body text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {link.label}
                </a>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onSecondary()
                }}
                className="block w-full rounded-lg px-2 py-2.5 text-left text-body text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                Paste tabs instead
              </button>
            </li>
          </ul>
        </div>
      )}
    </header>
  )
}
