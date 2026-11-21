"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import Link from "next/link"
import { Menu, X } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { buttonVariants } from "@/components/ui/button"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { CONTACT_EMAIL } from "@/components/legal/legal-page"
import { DOWNLOAD_PATH } from "@/lib/desktop/release"
import { cn } from "@/lib/utils"
import { RevealSection, revealStep } from "./reveal"

/*
 * The site's frame: header, footer, containers, feature cards — shared by
 * the launch page, /download and /move.
 *
 * Geometry is the reference's, measured at 1440px: a 52px header on the page
 * ground with the mark at the container's left edge and the section links
 * centred; 27px pill actions on the right; a 1300px container; feature cards
 * one step above the ground with the words set low in a 383px column beside
 * a staged window; a footer on the card tone.
 */

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("m-container", className)}>{children}</div>
}

/** The mark in the logo's slot, beside the name set as a capitalised wordmark. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-foreground", className)}>
      <BrandMark className="size-5" />
      <span className="text-[14px] leading-none font-medium tracking-[0.16em]">HUBBLE</span>
    </span>
  )
}

/** Absolute, so the header works the same on every page of the site. */
export const NAV_LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#desktop-and-chrome", label: "Desktop + Chrome" },
  { href: "/#capture", label: "Features" },
  { href: "/download", label: "Download" },
] as const

export type PrimaryAction = { label: string; href?: string; onClick?: () => void }

export function ActionButton({ action, className, children }: { action: PrimaryAction; className: string; children: ReactNode }) {
  if (action.href) {
    return (
      <a href={action.href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    )
  }
  return (
    <button type="button" onClick={action.onClick} className={className}>
      {children}
    </button>
  )
}

/**
 * The way to the download page from the site's own pages, or `null` inside
 * the desktop app, where it would be offering the visitor what they already run.
 */
export function useDesktopLink(): { label: string; href: string } | null {
  return useIsDesktop() ? null : { label: "Download Hubble", href: DOWNLOAD_PATH }
}

/** Hubble for Chrome, from any page: its store listing when there is one, else the download page's Chrome section. */
export const CHROME_SECTION_HREF = `${DOWNLOAD_PATH}#chrome`

export function SiteHeader({ install }: { /** Hubble for Chrome — a store link, or the download page's Chrome section. */ install: PrimaryAction }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const desktop = useDesktopLink()

  // The open menu covers the page: hold the page still under it, and let
  // Escape close it.
  useEffect(() => {
    if (!menuOpen) return
    const previous = document.documentElement.style.overflow
    document.documentElement.style.overflow = "hidden"
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => {
      document.documentElement.style.overflow = previous
      window.removeEventListener("keydown", onKey)
    }
  }, [menuOpen])

  const close = () => setMenuOpen(false)

  // The menu is the header's sibling, not its child: the header's backdrop
  // blur makes it the containing block for anything fixed inside it.
  return (
    <>
      <header className="m-header sticky top-0 z-(--hb-z-sticky)">
        <div className="m-page">
          <Container className="relative flex h-(--hb-header-h) items-center gap-4">
            <Link href="/" aria-label="Hubble home" className="shrink-0 rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Wordmark />
            </Link>

            <nav aria-label="Sections" className="absolute left-1/2 hidden -translate-x-1/2 items-center lg:flex">
              {NAV_LINKS.map((link) => (
                <a key={link.href} href={link.href} className="m-small m-quiet-link px-[15px] py-[5.6px]">
                  {link.label}
                </a>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-2">
              <ActionButton action={install} className="m-small m-quiet-link hidden px-1.5 py-1 sm:inline">
                {install.label}
              </ActionButton>
              {desktop && (
                <Link href={desktop.href} className={buttonVariants({ size: "nav" })}>
                  Download
                </Link>
              )}
              <button
                type="button"
                aria-label={menuOpen ? "Close menu" : "Open menu"}
                aria-expanded={menuOpen}
                aria-controls="site-menu"
                onClick={() => setMenuOpen((open) => !open)}
                className="-mr-1.5 flex size-9 items-center justify-center rounded-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
              >
                {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
              </button>
            </div>
          </Container>
        </div>
      </header>

      <nav id="site-menu" aria-label="Menu" data-open={menuOpen} inert={!menuOpen} className="m-sheet m-page pt-6 pb-10 lg:hidden">
        <ul className="flex flex-col">
          {NAV_LINKS.map((link, index) => (
            <li key={link.href} className="m-sheet-item" style={{ "--m-step": index } as CSSProperties}>
              <a href={link.href} onClick={close} className="flex h-14 items-center text-[28px] tracking-[-0.025em] text-foreground">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="m-sheet-item mt-8 flex flex-col gap-2.5" style={{ "--m-step": NAV_LINKS.length } as CSSProperties}>
          {desktop && (
            <Link href={desktop.href} onClick={close} className={cn(buttonVariants({ size: "hero" }), "w-full")}>
              {desktop.label}
            </Link>
          )}
          <ActionButton action={install} className={cn(buttonVariants({ variant: "secondary", size: "hero" }), "w-full")}>
            {install.label}
          </ActionButton>
        </div>
      </nav>
    </>
  )
}

/** "Learn about … →": white, with an arrow that leans forward on hover. */
export function MoreLink({ href, onClick, external = false, children }: { href?: string; onClick?: () => void; external?: boolean; children: ReactNode }) {
  const inner = (
    <>
      {children}{" "}
      <span aria-hidden className="m-arrow">
        →
      </span>
    </>
  )
  return href ? (
    <a href={href} className="m-link m-body inline-flex items-center gap-1" {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {inner}
    </a>
  ) : (
    <button type="button" onClick={onClick} className="m-link m-body inline-flex items-center gap-1">
      {inner}
    </button>
  )
}

/**
 * A feature card, as the reference sets them: the title in white and the
 * rest of the sentence in grey at the same size, low in a 383px column,
 * beside a window on its stage. From `xl` the two sit side by side
 * (`reverse` puts the window first); below that the words sit above a
 * full-width stage. Title, body, link and window reveal in that order.
 */
export function FeatureSection({
  id,
  title,
  body,
  link,
  stage,
  reverse = false,
}: {
  id?: string
  title: string
  body: ReactNode
  link?: ReactNode
  stage: ReactNode
  reverse?: boolean
}) {
  return (
    <RevealSection id={id} className="m-page scroll-mt-(--hb-header-h) py-[calc(var(--hb-v)*1.5)] sm:py-[calc(var(--hb-v)*2)]">
      <Container>
        <div
          className={cn(
            "m-card m-bleed grid gap-6 p-3 sm:p-[18px]",
            "xl:min-h-[720px] xl:grid-cols-[minmax(0,383px)_minmax(0,1fr)] xl:gap-[40px]",
            reverse && "xl:grid-cols-[minmax(0,1fr)_minmax(0,383px)]"
          )}
        >
          <div className={cn("flex flex-col justify-end px-2 pt-5 sm:px-[3px] xl:pt-0 xl:pb-[18px]", reverse && "xl:order-2")}>
            <h2 className="m-title m-reveal-item m-reveal-text text-foreground" style={revealStep(0)}>
              {title}
            </h2>
            <p className="m-title m-reveal-item m-reveal-text max-w-[620px] text-muted-foreground" style={revealStep(1)}>
              {body}
            </p>
            {link && (
              <div className="m-reveal-item mt-5" style={revealStep(2)}>
                {link}
              </div>
            )}
          </div>
          <div className={cn("m-reveal-item min-w-0", reverse && "xl:order-1")} style={revealStep(link ? 3 : 2)}>
            {stage}
          </div>
        </div>
      </Container>
    </RevealSection>
  )
}

/** The plane a window rests on, with the window inset from its edges and drifting a little as the page scrolls. */
export function Stage({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("m-stage m-settle px-2 py-6 sm:p-8 lg:p-12", className)}>
      <div className="m-parallax">{children}</div>
    </div>
  )
}

// ------------------------------------------------------------------ Footer

const FOOTER_COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "/#how-it-works" },
      { label: "Desktop + Chrome", href: "/#desktop-and-chrome" },
      { label: "Hubble for Chrome", href: CHROME_SECTION_HREF },
      { label: "Changelog", href: "/#changelog" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Release notes", href: "/download#release" },
      { label: "Move from Hubble on the web", href: "/move" },
      { label: "Your account", href: "/account" },
      { label: "Contact", href: `mailto:${CONTACT_EMAIL}` },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms & Conditions", href: "/terms" },
      { label: "Cookie Policy", href: "/cookies" },
    ],
  },
]

export function SiteFooter() {
  const desktopLink = useDesktopLink()
  const columns = FOOTER_COLUMNS.map((column) => ({
    ...column,
    links: [...(column.title === "Resources" && desktopLink ? [desktopLink] : []), ...column.links],
  }))
  return (
    <footer className="m-page bg-card pt-[calc(var(--hb-section-y)*1.2)] pb-[30px]">
      <Container>
        <div className="grid grid-cols-2 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">
          <div className="col-span-2 sm:col-span-3 lg:col-span-2">
            <Wordmark />
          </div>
          {columns.map((column) => (
            <div key={column.title}>
              <h2 className="m-small pb-[4.67px] text-tertiary">{column.title}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href} className="m-small m-quiet-link inline-block py-[4.67px]">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-24 flex flex-wrap items-center justify-between gap-4 border-t border-subtle pt-6">
          <p className="m-small text-tertiary">© 2026 Hubble</p>
          <p className="m-small text-tertiary">Your work stays on your computer.</p>
        </div>
      </Container>
    </footer>
  )
}
