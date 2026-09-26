import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/**
 * HubbleInput — 32px, an 8px corner, a 10% hairline on the page ground.
 * Focus darkens the hairline to the ring tone rather than drawing a halo:
 * the reference's fields announce focus the way its search box does, by
 * the edge alone.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 py-1 text-body text-foreground",
        "transition-[border-color,background-color] duration-(--duration-fast) ease-(--ease-color) outline-none",
        "placeholder:text-tertiary",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-body-sm file:font-medium file:text-foreground",
        "hover:border-strong focus-visible:border-ring focus-visible:outline-none",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
