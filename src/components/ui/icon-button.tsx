import * as React from "react"

import { cn } from "@/lib/utils"

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      data-slot="icon-button"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none",
        "hover:bg-muted hover:text-foreground",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
)
IconButton.displayName = "IconButton"
