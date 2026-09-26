"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { ArrowRight, Menu, Monitor, Moon, Sun, X } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/*
 * The landing page's frame: header, footer, containers, sections.
 *
 * Geometry is the reference's, measured at 1440px: a 52px header on the page
 * ground with the mark at the container's left edge and the section links
 * centred; 27px pill actions on the right; a 1300px container with 20px
 * gutters; sections 67.2px apart; a footer on the card tone.
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

export const NAV_LINKS = [
  { href: "#workspaces", label: "Workspaces" },
  { href: "#command-centre", label: "Command Centre" },
  { href: "#graph", label: "Graph" },
  { href: "#context", label: "Context" },
  { href: "#agents", label: "Agents" },
] as const

export type PrimaryAction = { label: string; href?: string; onClick?: () => void }

export function ActionButton({
  action,
  className,
  children,
}: {
  action: PrimaryAction
  className: string
  children: ReactNode
}) {
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

export function SiteHeader({
  install,
  onOpenApp,
}: {
  /** Hubble for Chrome — a store link, or the install guide. */
  install: PrimaryAction
  onOpenApp: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="sticky top-0 z-(--hb-z-sticky) bg-background">
      <div className="m-page">
        <Container className="relative flex h-(--hb-header-h) items-center gap-4">
          <Link href="/welcome" aria-label="Hubble home" className="shrink-0 rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Wordmark />
          </Link>

          <nav aria-label="Sections" className="absolute left-1/2 hidden -translate-x-1/2 items-center lg:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="m-small rounded-full px-[1.07em] py-[0.4em] text-foreground transition-opacity duration-(--duration-fast) hover:opacity-60"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <ActionButton
              action={install}
              className="m-small hidden rounded-full px-2 py-1 text-foreground transition-opacity duration-(--duration-fast) hover:opacity-60 sm:inline"
            >
              {install.label}
            </ActionButton>
            <button type="button" onClick={onOpenApp} className={buttonVariants({ size: "nav" })}>
              Open Hubble
            </button>
            <button
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="flex size-8 items-center justify-center rounded-xs text-foreground lg:hidden"
            >
              {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </Container>
      </div>

      {menuOpen && (
        <nav aria-label="Menu" className="border-t border-border bg-background px-5 pt-2 pb-6 lg:hidden">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="m-body flex h-11 items-center border-b border-border text-foreground"
            >
              {link.label}
            </a>
          ))}
          <ActionButton action={install} className="m-body flex h-11 w-full items-center border-b border-border text-foreground">
            {install.label}
          </ActionButton>
          <button type="button" onClick={onOpenApp} className="m-body flex h-11 w-full items-center text-foreground">
            Open Hubble
          </button>
        </nav>
      )}
    </header>
  )
}

/** The hero's pair: ink pill into the app, tonal pill down the page. */
export function HeroActions({ onOpenApp, exploreHref }: { onOpenApp: () => void; exploreHref: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button type="button" onClick={onOpenApp} className={buttonVariants({ size: "hero" })}>
        Get started
        <ArrowRight aria-hidden />
      </button>
      <a href={exploreHref} className={buttonVariants({ variant: "secondary", size: "hero" })}>
        Explore Hubble
      </a>
    </div>
  )
}

/** "Learn about … →", the page's only chromatic text. */
export function MoreLink({ href, onClick, external = false, children }: { href?: string; onClick?: () => void; external?: boolean; children: ReactNode }) {
  const inner = (
    <>
      {children} <span aria-hidden>→</span>
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
 * Mounts its children once they come near the viewport, holding their space
 * until then.
 *
 * The page has several live windows, each a whole Hubble; rendering them all
 * on first load would make the visitor pay for the ones they never scroll
 * to. The placeholder is the same size as the window, so nothing shifts when
 * it mounts.
 *
 * Where nearness cannot be observed (no IntersectionObserver), the windows
 * mount on the visitor's first scroll or interaction rather than all at
 * once on load — the page is first rendered as a browser would render it,
 * with only the hero live. (Mounting them eagerly here made the first-run
 * screen at `/` six times as heavy in jsdom, and slowed the app's own
 * extension-dump tests into timeouts.)
 */
export function WhenNear({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || near) return
    if (typeof IntersectionObserver === "undefined") {
      const events = ["scroll", "wheel", "touchstart", "keydown", "pointerdown"] as const
      const mount = () => setNear(true)
      for (const name of events) window.addEventListener(name, mount, { once: true, passive: true })
      return () => {
        for (const name of events) window.removeEventListener(name, mount)
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { rootMargin: "600px 0px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [near])
  return (
    <div ref={ref} className={className}>
      {near ? children : null}
    </div>
  )
}

/**
 * A feature section: two sentences and a link beside (or above) a live
 * Hubble window. `split` sets the text in a 383px column beside the window
 * from `xl`, where the window still has app-sized room; below that, and for
 * `wide` sections at every width, the text sits above a full-width window.
 */
export function FeatureSection({
  id,
  title,
  body,
  link,
  stage,
  layout = "split",
  reverse = false,
}: {
  id?: string
  title: string
  body: ReactNode
  link?: ReactNode
  stage: ReactNode
  layout?: "split" | "wide"
  reverse?: boolean
}) {
  const split = layout === "split"
  return (
    <section id={id} className="m-page scroll-mt-(--hb-header-h) py-[calc(var(--hb-v)*2)]">
      <Container>
        <div
          className={cn(
            "m-card m-bleed grid gap-6 p-3 sm:p-[17.5px]",
            split && "xl:min-h-[715px] xl:grid-cols-[minmax(0,383px)_minmax(0,1fr)] xl:gap-[40px]",
            split && reverse && "xl:grid-cols-[minmax(0,1fr)_minmax(0,383px)]"
          )}
        >
          <div className={cn("flex flex-col justify-center px-[2.5px] pt-3", split ? "xl:py-0" : "max-w-[720px] sm:pt-4", split && reverse && "xl:order-2")}>
            <h2 className="m-title text-foreground">{title}</h2>
            <p className="m-title text-muted-foreground">{body}</p>
            {link && <div className="mt-5">{link}</div>}
          </div>
          <div className={cn("min-w-0", split && reverse && "xl:order-1")}>{stage}</div>
        </div>
      </Container>
    </section>
  )
}

/** The flat tonal plane a window rests on, with the window inset from its edges. */
export function Stage({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("m-stage p-2 sm:p-6 lg:p-10", className)}>{children}</div>
}

// ------------------------------------------------------------------ Footer

export type Scheme = "system" | "light" | "dark"
const SCHEME_KEY = "tabdump:marketing-scheme:v1"

/**
 * The page's colour scheme, as the reference offers it: system, light or
 * dark. Applied as `data-scheme` on the page root; "system" removes it so
 * the media query decides. A per-visitor convenience, so localStorage is the
 * right home and a failure to read it simply means "system".
 */
export function useMarketingScheme(rootId: string): [Scheme, (scheme: Scheme) => void] {
  const [scheme, setSchemeState] = useState<Scheme>("system")
  useEffect(() => {
    let stored: Scheme = "system"
    try {
      const raw = window.localStorage.getItem(SCHEME_KEY)
      if (raw === "light" || raw === "dark") stored = raw
    } catch {
      // Private mode or blocked storage: follow the system.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSchemeState(stored)
  }, [])
  useEffect(() => {
    const root = document.getElementById(rootId)
    if (!root) return
    if (scheme === "system") root.removeAttribute("data-scheme")
    else root.setAttribute("data-scheme", scheme)
  }, [rootId, scheme])
  const setScheme = useCallback((next: Scheme) => {
    setSchemeState(next)
    try {
      if (next === "system") window.localStorage.removeItem(SCHEME_KEY)
      else window.localStorage.setItem(SCHEME_KEY, next)
    } catch {
      // Not persisted this time; the choice still applies to this visit.
    }
  }, [])
  return [scheme, setScheme]
}

const FOOTER_COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Workspaces", href: "#workspaces" },
      { label: "Command Centre", href: "#command-centre" },
      { label: "Graph", href: "#graph" },
      { label: "Context", href: "#context" },
      { label: "Agents", href: "#agents" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Changelog", href: "#changelog" },
      { label: "Open Hubble", href: "/" },
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

export function SiteFooter({ scheme, onScheme }: { scheme: Scheme; onScheme: (scheme: Scheme) => void }) {
  const options: { value: Scheme; label: string; icon: typeof Sun }[] = [
    { value: "system", label: "System", icon: Monitor },
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
  ]
  return (
    <footer className="m-page bg-card pt-[var(--hb-section-y)] pb-[30px]">
      <Container>
        <div className="grid grid-cols-2 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">
          <div className="col-span-2 sm:col-span-3 lg:col-span-2">
            <Wordmark />
          </div>
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.title}>
              <h2 className="m-small pb-[4.67px] text-muted-foreground">{column.title}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href} className="m-small inline-block py-[4.67px] text-foreground transition-opacity duration-(--duration-fast) hover:opacity-60">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-24 flex flex-wrap items-center justify-between gap-4">
          <p className="m-small text-muted-foreground">© 2026 Hubble · Your workspaces stay on your device.</p>
          <div role="radiogroup" aria-label="Colour scheme" className="flex items-center gap-0.5 rounded-full bg-surface-active p-0.5">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={scheme === option.value}
                aria-label={option.label}
                onClick={() => onScheme(option.value)}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full transition-colors duration-(--duration-fast)",
                  scheme === option.value ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <option.icon className="size-3.5" aria-hidden />
              </button>
            ))}
          </div>
        </div>
      </Container>
    </footer>
  )
}
