"use client"

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import { cn } from "@/lib/utils"
import { useInView } from "./hooks"

/**
 * Shared layout, chrome and control primitives for the landing page.
 *
 * Every section below composes these rather than hand-rolling its own frame,
 * which is what keeps the page's spacing, radii, borders and motion identical
 * from the hero to the footer. The demo chrome in particular (`DemoWindow`,
 * `DemoTabRow`) is the page's promise made good: it renders the same favicon
 * component, category palette and card anatomy the real workspace uses, so
 * what a visitor plays with is the product's own visual language and not a
 * marketing redraw of it.
 */

/* -------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------- */

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn("mx-auto w-full", className)}
      style={{ maxWidth: "var(--m-max)", paddingInline: "var(--m-gutter)" }}
    >
      {children}
    </div>
  )
}

export function Section({
  id,
  className,
  children,
  /** Hairline above the section. The page's sections are separated by rules, not by color changes. */
  divided = true,
}: {
  id?: string
  className?: string
  children: ReactNode
  divided?: boolean
}) {
  return (
    <section
      id={id}
      className={cn("relative", divided && "border-t border-subtle", className)}
      style={{ paddingBlock: "var(--m-section-y)" }}
    >
      {children}
    </section>
  )
}

/**
 * Reveals its children on first scroll into view.
 *
 * `order` staggers siblings by a fixed 90ms step rather than taking a raw
 * delay, so a section's entrance rhythm is declared as "first, second, third"
 * and stays consistent with every other section on the page.
 */
export function Reveal({
  order = 0,
  className,
  children,
  as: Tag = "div",
}: {
  order?: number
  className?: string
  children: ReactNode
  as?: "div" | "li" | "h2" | "p"
}) {
  const { ref, shown } = useInView<HTMLDivElement>()
  return (
    <Tag
      ref={ref as never}
      data-shown={shown}
      className={cn("m-reveal", className)}
      style={{ "--m-reveal-delay": `${order * 90}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  )
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("m-eyebrow", className)}>{children}</p>
}

/**
 * The page's workhorse composition: a statement on the left, a live piece of
 * product on the right. Stacks to copy-then-demo on narrow viewports, where
 * `reverse` is ignored — reading order has to stay statement-first.
 */
export function SplitSection({
  id,
  eyebrow,
  heading,
  lead,
  aside,
  children,
  reverse = false,
}: {
  id?: string
  eyebrow: string
  heading: ReactNode
  lead: ReactNode
  /** Optional small print under the lead — a hint about what the demo can do. */
  aside?: ReactNode
  children: ReactNode
  reverse?: boolean
}) {
  return (
    <Section id={id}>
      <Container>
        {/* The track sizes swap with `reverse`, not just the order: `order`
            moves an item into the *other track*, so reversing without this
            would hand the demo the narrow column and the copy the wide one. */}
        <div
          className={cn(
            "grid items-center gap-x-16 gap-y-12",
            reverse
              ? "lg:grid-cols-[minmax(0,1.18fr)_minmax(0,0.82fr)]"
              : "lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]"
          )}
        >
          <div className={cn("max-w-xl", reverse && "lg:order-2")}>
            <Reveal order={0}>
              <Eyebrow>{eyebrow}</Eyebrow>
            </Reveal>
            <Reveal order={1}>
              <h2 className="m-title mt-5 text-foreground">{heading}</h2>
            </Reveal>
            <Reveal order={2}>
              <p className="m-lead mt-5">{lead}</p>
            </Reveal>
            {aside && (
              <Reveal order={3}>
                <p className="mt-6 text-body-sm text-tertiary">{aside}</p>
              </Reveal>
            )}
          </div>
          <Reveal order={1} className={cn("min-w-0", reverse && "lg:order-1")}>
            {children}
          </Reveal>
        </div>
      </Container>
    </Section>
  )
}

/* -------------------------------------------------------------------------
 * Controls
 * ---------------------------------------------------------------------- */

/**
 * The page's CTA. A pill, deliberately not the app's `Button` primitive:
 * app buttons are 28–36px chrome sized to sit in dense toolbars, and a
 * landing-page CTA needs to be the second-loudest thing in the hero. Focus
 * ring, disabled handling and hit area still match the app's conventions.
 */
export function MButton({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: {
  variant?: "primary" | "secondary" | "ghost"
  size?: "md" | "lg"
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(mButtonClass(variant, size), className)}
      {...props}
    >
      {children}
    </button>
  )
}

/** Shared with anchors, which need the same look but real link semantics. */
export function mButtonClass(variant: "primary" | "secondary" | "ghost" = "primary", size: "md" | "lg" = "md") {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap",
    "transition-[background-color,color,border-color,transform] duration-(--duration-fast) ease-(--ease-standard)",
    "outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    size === "lg" ? "h-11 px-5 text-[0.9375rem]" : "h-9 px-4 text-body-sm",
    variant === "primary" && "bg-foreground text-background hover:bg-foreground/88",
    variant === "secondary" &&
      "border border-strong/70 bg-transparent text-foreground hover:border-strong hover:bg-white/[0.045]",
    variant === "ghost" && "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
  )
}

/* -------------------------------------------------------------------------
 * Demo chrome
 * ---------------------------------------------------------------------- */

/**
 * A piece of software rendered inside the page.
 *
 * `chrome="browser"` gives the traffic-light + address-bar frame used
 * wherever the demo is standing in for the visitor's own browser;
 * `chrome="app"` is TabDump's own window. The distinction carries meaning on
 * this page — the whole story is "things move out of the left frame and into
 * the right one" — so it is a prop rather than per-call markup.
 */
export function DemoWindow({
  chrome = "app",
  title,
  toolbar,
  className,
  bodyClassName,
  children,
  label,
}: {
  chrome?: "browser" | "app" | "bare"
  title?: ReactNode
  /** Right-aligned controls in the title bar (a counter, a button). */
  toolbar?: ReactNode
  className?: string
  bodyClassName?: string
  children: ReactNode
  /** Announced to screen readers in place of the visual chrome. */
  label?: string
}) {
  return (
    <figure
      className={cn("m-window relative overflow-hidden", className)}
      role="group"
      aria-label={label}
    >
      {chrome !== "bare" && (
        <div className="flex h-9 items-center gap-3 border-b border-subtle px-3.5">
          {chrome === "browser" ? (
            <div className="flex shrink-0 gap-1.5" aria-hidden>
              <span className="size-2.5 rounded-full bg-white/12" />
              <span className="size-2.5 rounded-full bg-white/12" />
              <span className="size-2.5 rounded-full bg-white/12" />
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-2 text-tertiary" aria-hidden>
              <BrandGlyph className="size-3.5" />
            </div>
          )}
          <div className="min-w-0 flex-1 truncate text-meta text-tertiary">{title}</div>
          {toolbar && <div className="flex shrink-0 items-center gap-2">{toolbar}</div>}
        </div>
      )}
      <div className={cn("relative", bodyClassName)}>{children}</div>
    </figure>
  )
}

/** The TabDump mark, inlined here so demo chrome doesn't depend on app layout. */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("size-4", className)}
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

/** The 2px category spine that colors a tab row, a section header and a graph node alike. */
export function CategoryDot({ category, className }: { category: CategoryId; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: `var(${CATEGORIES[category].accentColor})` }}
    />
  )
}

/**
 * A tab, as TabDump draws one: favicon, title, domain, category spine.
 *
 * Deliberately a single flexible component used by every demo — the dump, the
 * tree, the search results, the spatial canvas and the restore list all show
 * the *same* object, which is what makes the page read as one product rather
 * than eight illustrations.
 */
export function DemoTabRow({
  domain,
  title,
  category,
  size = "md",
  dimmed = false,
  highlighted = false,
  count,
  trailing,
  className,
  style,
}: {
  domain: string
  title: string
  category: CategoryId
  size?: "sm" | "md"
  /** Filtered out by the current query — present but pushed back, never removed. */
  dimmed?: boolean
  highlighted?: boolean
  /** Renders a "× N" collapsed-duplicates badge. */
  count?: number
  trailing?: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={cn(
        "group/row flex items-center gap-2.5 rounded-lg border bg-card/70 transition-[opacity,border-color,background-color,transform] duration-(--duration-base) ease-(--ease-standard)",
        size === "sm" ? "px-2 py-1.5" : "px-2.5 py-2",
        highlighted ? "border-[color-mix(in_oklch,var(--primary),transparent_45%)] bg-accent-subtle" : "border-subtle",
        dimmed && "opacity-25",
        className
      )}
      style={style}
    >
      <span
        aria-hidden
        className="h-5 w-0.5 shrink-0 rounded-full"
        style={{ backgroundColor: `var(${CATEGORIES[category].accentColor})`, opacity: 0.85 }}
      />
      <TabFavicon domain={domain} size={size === "sm" ? 14 : 18} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-foreground", size === "sm" ? "text-[0.75rem] leading-4" : "text-body-sm")}>
          {title}
        </span>
        {size === "md" && <span className="block truncate text-meta text-tertiary">{domain}</span>}
      </span>
      {count != null && count > 1 && (
        <span className="m-num shrink-0 rounded-full border border-subtle px-1.5 py-0.5 text-[0.6875rem] text-tertiary">
          ×{count}
        </span>
      )}
      {trailing}
    </div>
  )
}

/** A single labelled figure — used in the processing readout and the proof strip. */
export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div>
      <div className="m-num text-[1.75rem] leading-none text-foreground">{value}</div>
      <div className="mt-2 text-body-sm text-tertiary">{label}</div>
    </div>
  )
}

/**
 * Wraps a demo with the one thing every demo on this page needs: a visible
 * invitation to touch it. Sits under the frame so it never competes with the
 * product UI inside.
 */
export function DemoCaption({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3.5 flex items-center gap-2 text-body-sm text-tertiary">
      <span aria-hidden className="inline-block size-1 rounded-full bg-accent-text/70" />
      {children}
    </p>
  )
}
