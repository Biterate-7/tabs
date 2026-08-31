"use client"

import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = { value: T; label: string }

/**
 * A small fixed set of mutually-exclusive choices rendered as one pill —
 * used throughout Settings → Appearance (Preset/Custom, density, radius,
 * intensity levels, …) instead of a dropdown when there are only a handful
 * of options worth seeing all at once.
 */
function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  className,
  size = "default",
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  className?: string
  size?: "default" | "sm"
}) {
  return (
    <div
      role="radiogroup"
      className={cn("inline-flex w-fit items-center gap-0.5 rounded-lg border border-subtle bg-card p-0.5", className)}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "rounded-md text-label font-medium transition-colors duration-(--duration-fast) ease-(--ease-standard) outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              size === "sm" ? "px-2 py-1" : "px-3 py-1.5",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export { SegmentedControl }
