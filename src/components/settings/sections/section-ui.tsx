import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/*
 * Settings grammar.
 *
 *   SectionHeading   the pane's title (18px) and one sentence under it
 *   GroupLabel       a small label naming the group that follows
 *   SectionStack     one hairlined group on the card tone; its rows are
 *                    divided by quiet separators rather than each drawn as
 *                    a box of its own
 *   FieldRow         label + description on the left, control on the right
 *   SliderRow        label + value above a full-width slider
 *
 * Rows carry no border of their own, so a group reads as one object with
 * lines in it — the reference's settings, not a dashboard of cards.
 */

export function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-h1 text-foreground">{title}</h2>
      {description && <p className="mt-1 max-w-xl text-body text-muted-foreground">{description}</p>}
    </div>
  )
}

export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("mb-2 text-label text-muted-foreground", className)}>{children}</p>
}

export function FieldRow({
  label,
  description,
  children,
  stacked = false,
}: {
  label: string
  description?: string
  children: ReactNode
  stacked?: boolean
}) {
  return (
    <div
      data-slot="field-row"
      className={cn("px-4 py-3", stacked ? "flex flex-col gap-3" : "flex min-h-12 items-center justify-between gap-6")}
    >
      <div className="min-w-0">
        <p className="text-body text-foreground">{label}</p>
        {description && <p className="mt-0.5 text-body-sm text-muted-foreground">{description}</p>}
      </div>
      <div className={stacked ? "" : "shrink-0"}>{children}</div>
    </div>
  )
}

export function SliderRow({
  label,
  valueLabel,
  children,
}: {
  label: string
  valueLabel: string
  children: ReactNode
}) {
  return (
    <div data-slot="field-row" className="px-4 py-3">
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-body text-foreground">{label}</p>
        <span className="text-meta text-tertiary">{valueLabel}</span>
      </div>
      {children}
    </div>
  )
}

export function SectionStack({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="settings-group"
      className={cn("flex flex-col divide-y divide-subtle overflow-hidden rounded-md border border-border bg-card", className)}
    >
      {children}
    </div>
  )
}

/** A plain block of prose or controls inside a group, padded like a row. */
export function GroupBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-4 py-3", className)}>{children}</div>
}
