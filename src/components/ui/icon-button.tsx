import * as React from "react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string
  /** Tooltip text; defaults to aria-label so most call sites need nothing extra. */
  tooltip?: string
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, tooltip, "aria-label": ariaLabel, ...props }, ref) => (
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
              "text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-standard) outline-none",
              "hover:border-border hover:bg-muted hover:text-foreground",
              "active:not-aria-[haspopup]:translate-y-px",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-50",
              "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              className
            )}
            {...props}
          />
        }
      />
      <TooltipContent>{tooltip ?? ariaLabel}</TooltipContent>
    </Tooltip>
  )
)
IconButton.displayName = "IconButton"
