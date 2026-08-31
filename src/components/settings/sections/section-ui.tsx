import type { ReactNode } from "react"

/** A section's leading heading + optional one-line description. */
export function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-h2 text-foreground">{title}</h2>
      {description && <p className="mt-1 text-body-sm text-muted-foreground">{description}</p>}
    </div>
  )
}

/** A single labeled control row — label/description on the left, the control itself on the right. Used for every simple on/off, segmented, or dropdown setting. */
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
      className={
        stacked
          ? "rounded-lg border border-subtle p-3"
          : "flex items-center justify-between gap-4 rounded-lg border border-subtle p-3"
      }
    >
      <div className={stacked ? "mb-3" : "min-w-0"}>
        <p className="text-body-sm font-medium text-foreground">{label}</p>
        {description && <p className="mt-0.5 text-meta text-tertiary">{description}</p>}
      </div>
      <div className={stacked ? "" : "shrink-0"}>{children}</div>
    </div>
  )
}

/** A labeled slider row that shows the live numeric value next to the label. */
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
    <div className="rounded-lg border border-subtle p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-body-sm font-medium text-foreground">{label}</p>
        <span className="text-meta text-tertiary">{valueLabel}</span>
      </div>
      {children}
    </div>
  )
}

export function SectionStack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2.5">{children}</div>
}
