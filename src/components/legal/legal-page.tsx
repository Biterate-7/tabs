import Link from "next/link"
import { ArrowLeft, Mail } from "lucide-react"
import type { ReactNode } from "react"

export const CONTACT_EMAIL = "tabdump.team@gmail.com"

const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/cookies", label: "Cookie Policy" },
] as const

/**
 * Shared chrome for the three legal pages (/privacy, /terms, /cookies):
 * a back link to the app, the page title with a "Last updated" date, and a
 * cross-nav row so a reader can move between the three without going back
 * through the app itself. Content is passed as plain semantic HTML (h2/p/ul)
 * — this component only supplies spacing/typography for those via the
 * `[&_h2]`-style selectors below, reusing the same text-h2/text-body-sm
 * tokens the rest of the app already uses (see globals.css) rather than
 * introducing a separate prose scale.
 */
export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string
  lastUpdated: string
  children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-1.5 rounded-md text-body-sm text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to TabDump
        </Link>

        <h1 className="mt-8 text-h1 text-foreground sm:text-display">{title}</h1>
        <p className="mt-2 text-body-sm text-tertiary">Last updated: {lastUpdated}</p>

        <div
          className={[
            "mt-8 flex flex-col gap-8 text-body text-muted-foreground",
            "[&_h2]:text-h2 [&_h2]:text-foreground",
            "[&_h2+p]:mt-3 [&_h2+ul]:mt-3",
            "[&_p+p]:mt-3 [&_p+ul]:mt-2 [&_ul+p]:mt-3",
            "[&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5",
            "[&_li]:leading-relaxed [&_p]:leading-relaxed",
            "[&_a]:text-accent-text [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:no-underline",
          ].join(" ")}
        >
          {children}
        </div>

        <nav aria-label="Legal pages" className="mt-16 flex flex-wrap gap-x-6 gap-y-2 border-t border-subtle pt-6 text-body-sm">
          {LEGAL_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </main>
  )
}

/**
 * Flags a fact this document cannot state for real — an operator-specific
 * detail (a contact address, a governing jurisdiction) that isn't anywhere
 * in this codebase to read — instead of inventing one. Styled to visibly
 * stand apart from the surrounding legal text rather than blend in as if it
 * were a verified statement.
 */
export function ConfigNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-body-sm text-foreground">
      <p className="font-medium">Needs configuration</p>
      <div className="mt-1 [&_p]:mt-1.5 [&_p]:leading-relaxed">{children}</div>
    </div>
  )
}

/**
 * The site's one contact address, always paired with a mail icon and a
 * `mailto:` link so every appearance of it is clickable in the same way.
 */
export function ContactEmail() {
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className="inline-flex items-center gap-1.5 align-middle">
      <Mail className="size-4 shrink-0" aria-hidden="true" />
      {CONTACT_EMAIL}
    </a>
  )
}
