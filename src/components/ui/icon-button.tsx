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

/**
 * HubbleIconButton — a 28px square with a 4px corner and a 16px glyph at
 * the secondary text tier, the measured geometry of the reference's toolbar
 * and title-bar controls. Hover fills the square with the 3.5% tone and
 * brings the glyph up to full ink; nothing moves.
 */
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
              "inline-flex size-7 shrink-0 items-center justify-center rounded-xs border border-transparent",
              "transition-[background-color,color] duration-(--duration-fast) ease-(--ease-color) outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring/60",
              "disabled:pointer-events-none disabled:opacity-50",
              "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              destructive
                ? "text-muted-foreground hover:bg-destructive/12 hover:text-destructive"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground aria-expanded:bg-surface-hover aria-expanded:text-foreground",
              className
            )}
            {...props}
          />
        }
      />
      <TooltipContent>
        {shortcut ? (
          <span className="flex items-center gap-2">
            <span>{tooltip ?? ariaLabel}</span>
            <span className="text-tertiary">{shortcut}</span>
          </span>
        ) : (
          (tooltip ?? ariaLabel)
        )}
      </TooltipContent>
    </Tooltip>
  )
)
IconButton.displayName = "IconButton"
