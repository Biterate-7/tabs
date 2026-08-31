import * as React from "react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string
  /** Tooltip text; defaults to aria-label so most call sites need nothing extra. */
  tooltip?: string
  /** Keyboard shortcut shown as a subdued second line in the tooltip. Only pass shortcuts that are actually wired up — never an invented one. */
  shortcut?: string
  /** Styles this as an irreversible/destructive action (remove, delete, clear) instead of the neutral default. */
  destructive?: boolean
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, tooltip, shortcut, destructive, "aria-label": ariaLabel, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={ref}
            type="button"
            data-slot="icon-button"
            aria-label={ariaLabel}
            className={cn(
              "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-transparent",
              "transition-colors duration-(--duration-fast) ease-(--ease-standard) outline-none",
              "active:not-aria-[haspopup]:translate-y-px",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-50",
              "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              destructive
                ? "text-destructive hover:border-destructive/30 hover:bg-destructive/10"
                : "text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
              className
            )}
            {...props}
          />
        }
      />
      <TooltipContent>
        {shortcut ? (
          <span className="flex flex-col gap-0.5">
            <span>{tooltip ?? ariaLabel}</span>
            <span className="text-[0.65rem] text-muted-foreground">{shortcut}</span>
          </span>
        ) : (
          (tooltip ?? ariaLabel)
        )}
      </TooltipContent>
    </Tooltip>
  )
)
IconButton.displayName = "IconButton"
