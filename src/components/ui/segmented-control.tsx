"use client"

import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = { value: T; label: string }

/**
 * HubbleTabs (segmented) — the Monthly/Yearly switch: a pill track one tone
 * off the ground holding pill options; the chosen one steps a tone further
 * and takes full ink, the rest sit at the secondary tier.
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
      className={cn("inline-flex w-fit items-center gap-0.5 rounded-full bg-surface-hover p-0.5", className)}
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
              "rounded-full text-body-sm transition-colors duration-(--duration-fast) ease-(--ease-color) outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              size === "sm" ? "h-5 px-2" : "h-6 px-2.5",
              selected
                ? "bg-surface-active text-foreground shadow-[0_0_0_1px_var(--border-subtle)]"
                : "text-muted-foreground hover:text-foreground"
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
