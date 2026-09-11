"use client"

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react"
import { avatarFallback, faviconUrl } from "@/lib/workspace/favicon"
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
}: {
  id?: string
  className?: string
  children: ReactNode
}) {
  return (
    // No rule between sections. A hairline under every one turns the page
    // into a stack of slides; the ground and the rhythm are enough to say
    // where a section ends, and the demos read as one continuous document.
    <section id={id} className={cn("relative", className)} style={{ paddingBlock: "var(--m-section-y)" }}>
      {children}
    </section>
  )
}

/**
 * A section's opening block: heading and the sentence after it, set at the
 * same size with only weight and color separating them.
 *
 * Deliberately not heading-gap-subtitle. Two sizes plus an eyebrow above them
 * makes three competing typographic voices before a reader has learned
 * anything; one paragraph where the first clause happens to be the <h2> reads
 * as writing rather than as a slide, and it is what the benchmark does.
 */
export function SectionLede({
  heading,
  lead,
  className,
}: {
  heading: ReactNode
  lead: ReactNode
  className?: string
}) {
  return (
    <div className={cn("max-w-[36rem]", className)}>
      <Reveal order={0}>
        <h2 className="m-title text-foreground">{heading}</h2>
      </Reveal>
      <Reveal order={1}>
        <p className="m-lead">{lead}</p>
      </Reveal>
    </div>
  )
}

/**
 * Reveals its children on first scroll into view.
 *
 * `order` staggers siblings by a fixed 70ms step rather than taking a raw
 * delay, so a section's entrance rhythm is declared as "first, second, third"
 * and stays consistent with every other section on the page. Short enough
 * that three staggered items still land inside a quarter second.
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
      style={{ "--m-reveal-delay": `${order * 70}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  )
}

/**
 * The page's workhorse composition: a statement on the left, a live piece of
 * product on the right. Stacks to copy-then-demo on narrow viewports, where
 * `reverse` is ignored — reading order has to stay statement-first.
 */
export function SplitSection({
  id,
  heading,
  lead,
  aside,
  children,
  reverse = false,
}: {
  id?: string
  heading: ReactNode
  lead: ReactNode
  /** Small print under the lead — the invitation to touch the demo. */
  aside?: ReactNode
  children: ReactNode
  reverse?: boolean
}) {
  return (
    <Section id={id}>
      <Container>
        {/* Demo-dominant, ~62/38. The demo is the argument and the copy is the
            caption, so the copy column is sized to a comfortable 34rem measure
            and the demo takes everything else.

            The track sizes swap with `reverse`, not just the order: `order`
            moves an item into the *other track*, so reversing without this
            would hand the demo the narrow column. */}
        <div
          className={cn(
            // Top-aligned, not centred: the copy is a caption on the demo
            // beside it, and centring a 200px block against a 500px one
            // strands it in the middle of a column of nothing.
            "grid items-start gap-x-14 gap-y-10",
            reverse
              ? "lg:grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)]"
              : "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.62fr)]"
          )}
        >
          <div className={cn("lg:pt-2", reverse && "lg:order-2")}>
            <SectionLede heading={heading} lead={lead} />
            {aside && (
              <Reveal order={2}>
                <p className="mt-5 max-w-[30rem] text-body-sm text-tertiary">{aside}</p>
              </Reveal>
            )}
          </div>
          <Reveal order={1} className={cn("min-w-0", reverse && "lg:order-1")}>
            {/* Staged here rather than at each call site so every demo on the
                page floats on the same backdrop at the same inset. */}
            <DemoStage>{children}</DemoStage>
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

/**
 * The backdrop a demo window floats on.
 *
 * Two planes instead of one: the window gets a cast shadow onto a lit
 * surface, which is what makes it read as a photograph of software rather
 * than as a bordered div. Purely presentational — it never wraps the demo's
 * own interaction surface, so nothing here can intercept a drag or a click.
 */
export function DemoStage({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("m-stage", className)}>{children}</div>
}

/**
 * A tab's favicon, drawn exactly the way the app draws it — same favicon
 * service, same letter fallback, same palette, same rounded geometry — but
 * server-renderable.
 *
 * The app's own `TabFavicon` wraps Base UI's Avatar, which cannot know on the
 * server whether an image will load and so emits only the fallback; the client
 * then mounts an <img> in its place. Inside the app that is invisible, because
 * nothing there is server-rendered. On /welcome it is a structural hydration
 * mismatch repeated 246 times.
 *
 * So this reproduces the treatment with a plain <img> over a coloured letter:
 * identical markup on both sides, the letter showing through until (or unless)
 * the icon loads. It still imports `faviconUrl` and `avatarFallback` from the
 * app rather than re-deriving them, so the colour a domain gets here is the
 * colour it gets in a real workspace.
 */
export function DemoFavicon({ domain, size = 16 }: { domain: string; size?: number }) {
  const { letter, colorVar } = avatarFallback(domain)
  return (
    <span
      className="relative inline-flex shrink-0 overflow-hidden rounded-md"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* The coloured letter sits *behind* the icon and is removed once the
          icon actually loads — many favicons have transparent corners, and a
          fallback left painted underneath shows through as a coloured ring
          around every one of them. */}
      <span
        data-favicon-fallback
        className="absolute inset-0 flex items-center justify-center font-semibold text-white"
        style={{ backgroundColor: `var(${colorVar})`, fontSize: Math.round(size * 0.62) }}
      >
        {letter}
      </span>
      {/* Not next/image: these are third-party icons at 13–18px from a URL
          pattern, where the optimiser would add a proxy hop and gain nothing.
          alt="" keeps a failed load silent rather than showing broken-image
          chrome over the letter. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={faviconUrl(domain)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="relative size-full rounded-md object-cover"
        onLoad={(e) => {
          const fallback = e.currentTarget.previousElementSibling
          if (fallback instanceof HTMLElement) fallback.style.opacity = "0"
        }}
        onError={(e) => {
          e.currentTarget.style.display = "none"
        }}
      />
    </span>
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
      <DemoFavicon domain={domain} size={size === "sm" ? 14 : 18} />
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
